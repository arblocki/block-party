import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadRunConfig } from '../core/run/config.js';
import type { ContinueEntry, RunInput, RunOutcome } from '../core/run/pipeline.js';
import { ShutdownError } from '../core/run/pipeline-helpers.js';
import { parsePlan } from '../core/run/plan.js';
import { openStore, type Store } from '../core/store/index.js';
import {
  createRunManager,
  InvalidStartError,
  PlanValidationError,
  UnknownProjectError,
  type PipelineHooks,
  type RunManagerOptions,
} from './run-manager.js';

const PLAN = `# Add widgets

## Goal
Widgets.

## Approach
Build them.

## Acceptance criteria
- [ ] Widgets exist

## Out of scope
Gadgets.
`;

const RUN_ID = 'r20260101-aaaaaa';

let store: Store;
let projectId: string;
let root: string;

beforeEach(() => {
  store = openStore(':memory:');
  root = mkdtempSync(join(tmpdir(), 'bp-manager-'));
  projectId = store.runs.upsertProject({
    owner: 'o',
    repo: 'r',
    localPath: root,
    defaultBase: 'main',
  }).id;
});

afterEach(() => store.close());

/** Records the run row for `RUN_ID`, as the real pipeline does before `onStarted`. */
function createRow() {
  store.runs.createRun({
    id: RUN_ID,
    projectId,
    title: 'T',
    stage: 'setup',
    stageNote: null,
    branch: 'bp/t',
    worktreePath: '/wt',
    runDir: '/runs/a',
    baseRef: 'main',
    baseSha: 'base',
    headSha: null,
    prNumber: null,
    planPath: '/p',
    planHash: 'h',
    implementer: null,
    rounds: { checkFix: 0, reviewFix: 0, ciFix: 0, feedback: 0, checkRuns: 0 },
    ownerPid: process.pid,
    ownerHost: 'h',
  });
}

/**
 * A pipeline that announces `RUN_ID` (recording its row unless `recordRow` is false), then
 * runs until its signal aborts, ending cancelled or (for a ShutdownError) interrupted.
 */
function fakePipeline(opts: { recordRow?: boolean } = {}) {
  const inputs: RunInput[] = [];
  const startPipeline = (input: RunInput): Promise<RunOutcome> => {
    inputs.push(input);
    return new Promise((resolve) => {
      setTimeout(() => {
        if (opts.recordRow !== false) createRow();
        input.onStarted?.(RUN_ID);
      }, 5);
      input.signal!.addEventListener('abort', () => {
        const stage = input.signal!.reason instanceof ShutdownError ? 'interrupted' : 'cancelled';
        if (store.runs.getRun(RUN_ID)) store.runs.updateRun(RUN_ID, { stage });
        resolve({ runId: RUN_ID, runDir: '/runs/a', stage, note: null, prNumber: null });
      });
    });
  };
  return { inputs, startPipeline };
}

function manager(over: Partial<RunManagerOptions> = {}) {
  return createRunManager({
    runs: store.runs,
    plansDir: join(root, 'plans'),
    onError: () => undefined,
    ...over,
  });
}

describe('RunManager.start', () => {
  it('starts the pipeline and resolves with the run id once the run exists', async () => {
    const fake = fakePipeline();
    const m = manager({ startPipeline: fake.startPipeline });
    const id = await m.start({
      projectId,
      baseRef: 'develop',
      planText: PLAN,
      title: 'Custom title',
      flags: { mode: 'headless', publish: false },
    });
    expect(id).toBe(RUN_ID);
    expect(fake.inputs).toHaveLength(1);
    const input = fake.inputs[0]!;
    expect(input).toMatchObject({ repo: root, baseRef: 'develop', title: 'Custom title' });
    expect(input.config.implementer.mode).toBe('headless');
    expect(input.config.publish).toBe(false);
    const hash = (parsePlan(PLAN) as { ok: true; plan: { contentHash: string } }).plan.contentHash;
    expect(input.planFile).toBe(join(root, 'plans', `${hash}.md`));
    expect(readFileSync(input.planFile!, 'utf8')).toBe(PLAN);
    await m.shutdown();
  });

  it('rejects an invalid plan with its errors without starting anything', async () => {
    const fake = fakePipeline();
    const m = manager({ startPipeline: fake.startPipeline });
    const err = await m
      .start({ projectId, baseRef: 'main', planText: '# Only a title\n' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanValidationError);
    expect((err as PlanValidationError).errors).toEqual(
      expect.arrayContaining(['Missing section: Goal', 'Missing section: Acceptance criteria']),
    );
    expect(fake.inputs).toHaveLength(0);
  });

  it('rejects an unknown project without starting anything', async () => {
    const fake = fakePipeline();
    const m = manager({ startPipeline: fake.startPipeline });
    await expect(m.start({ projectId: 'nope', baseRef: 'main', planText: PLAN })).rejects.toThrow(
      UnknownProjectError,
    );
    expect(fake.inputs).toHaveLength(0);
  });

  it('rejects with the error that stopped the pipeline before the run existed', async () => {
    const m = manager({ startPipeline: () => Promise.reject(new Error('no checks: section')) });
    await expect(m.start({ projectId, baseRef: 'main', planText: PLAN })).rejects.toThrow(
      'no checks: section',
    );
    expect(await m.cancel(RUN_ID)).toBe(false);
  });

  it('rejects, and stops the run, when its row was not recorded', async () => {
    const fake = fakePipeline({ recordRow: false });
    const m = manager({ startPipeline: fake.startPipeline });
    await expect(m.start({ projectId, baseRef: 'main', planText: PLAN })).rejects.toThrow(
      /could not be recorded/,
    );
    const signal = fake.inputs[0]!.signal!;
    expect(signal.aborted).toBe(true);
    expect(signal.reason).not.toBeInstanceOf(ShutdownError);
  });

  it('starts nothing when shutdown begins while the plan file is written', async () => {
    const fake = fakePipeline();
    const m = manager({ startPipeline: fake.startPipeline });
    const starting = m.start({ projectId, baseRef: 'main', planText: PLAN });
    const stopped = m.shutdown();
    await expect(starting).rejects.toThrow(/shutting down/);
    await stopped;
    expect(fake.inputs).toHaveLength(0);
  });

  it('waits in shutdown for a start that is still writing its plan file', async () => {
    let finished = false;
    const m = manager({ startPipeline: fakePipeline().startPipeline });
    const starting = m.start({ projectId, baseRef: 'main', planText: PLAN }).catch(() => {
      finished = true;
    });
    await m.shutdown();
    expect(finished).toBe(true);
    await starting;
  });

  it('gives up, cancelling the pipeline, when the run does not start in time', async () => {
    let signal: AbortSignal | undefined;
    const m = manager({
      startTimeoutMs: 20,
      startPipeline: (input) => {
        signal = input.signal;
        return new Promise(() => undefined);
      },
    });
    await expect(m.start({ projectId, baseRef: 'main', planText: PLAN })).rejects.toThrow(
      /did not start/,
    );
    expect(signal?.aborted).toBe(true);
  });
});

describe('RunManager.cancel', () => {
  it('aborts the in-process run with a plain abort and reports it cancelled', async () => {
    const fake = fakePipeline();
    const m = manager({ startPipeline: fake.startPipeline });
    const id = await m.start({ projectId, baseRef: 'main', planText: PLAN });
    const signal = fake.inputs[0]!.signal!;
    expect(await m.cancel(id)).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).not.toBeInstanceOf(ShutdownError);
    expect(store.runs.getRun(id)?.stage).toBe('cancelled');
    // Already over: there is nothing left to cancel.
    expect(await m.cancel(id)).toBe(false);
  });

  it('returns false for a run it does not own', async () => {
    expect(await manager().cancel('r20260102-bbbbbb')).toBe(false);
  });

  it('returns false when the run finished instead of being cancelled', async () => {
    const m = manager({
      startPipeline: (input) =>
        new Promise((resolve) => {
          createRow();
          input.onStarted?.(RUN_ID);
          input.signal!.addEventListener('abort', () => {
            // Too late: the run just completed.
            store.runs.updateRun(RUN_ID, { stage: 'complete' });
            resolve({
              runId: RUN_ID,
              runDir: '/runs/a',
              stage: 'complete',
              note: null,
              prNumber: null,
            });
          });
        }),
    });
    const id = await m.start({ projectId, baseRef: 'main', planText: PLAN });
    expect(await m.cancel(id)).toBe(false);
  });

  it('forgets a run once its pipeline settles', async () => {
    const fake = fakePipeline();
    const m = manager({ startPipeline: fake.startPipeline });
    const id = await m.start({ projectId, baseRef: 'main', planText: PLAN });
    await m.cancel(id);
    await new Promise((r) => setTimeout(r, 0));
    store.runs.updateRun(id, { stage: 'complete' });
    expect(await m.cancel(id)).toBe(false);
  });
});

describe('RunManager.cancel of a resting or stopped run', () => {
  /** A continuation that carries out `cancel` by moving the run to cancelled. */
  const cancelling = (entries: ContinueEntry[]) => async (_id: string, entry: ContinueEntry) => {
    entries.push(entry);
    store.runs.updateRun(RUN_ID, { stage: 'cancelled' });
    return {} as RunOutcome;
  };

  it('cancels through a held continuation, for resting and stopped stages', async () => {
    createRow();
    for (const stage of [
      'awaiting_plan_approval',
      'awaiting_review',
      'interrupted',
      'blocked',
    ] as const) {
      const entries: ContinueEntry[] = [];
      store.runs.updateRun(RUN_ID, { stage });
      const m = manager({ continuePipeline: cancelling(entries) });
      expect(await m.cancel(RUN_ID)).toBe(true);
      await m.shutdown();
      expect(entries).toEqual([{ kind: 'cancel' }]);
    }
  });

  it('waits for a continuation that is leaving rest, then cancels it', async () => {
    createRow();
    store.runs.updateRun(RUN_ID, { stage: 'awaiting_review' });
    const calls: { entry: ContinueEntry; signal: AbortSignal }[] = [];
    const m = manager({
      continuePipeline: (_id, entry, signal) => {
        calls.push({ entry, signal });
        return new Promise<RunOutcome>((resolve) => {
          signal.addEventListener('abort', () => {
            store.runs.updateRun(RUN_ID, { stage: 'cancelled' });
            resolve({} as RunOutcome);
          });
        });
      },
    });
    expect(m.continue(RUN_ID, { kind: 'feedback', text: 'x' })).toBe(true);
    const cancelled = m.cancel(RUN_ID);
    // The continuation holds the run and it still rests: the cancel does not race it.
    await new Promise((r) => setTimeout(r, 50));
    expect(calls[0]!.signal.aborted).toBe(false);
    // Once it has left rest, the cancel aborts it like any driven run.
    store.runs.updateRun(RUN_ID, { stage: 'fixing' });
    expect(await cancelled).toBe(true);
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(calls.map((c) => c.entry.kind)).toEqual(['feedback']);
  });

  it('returns false when a continuation still holds the run at rest past the wait', async () => {
    createRow();
    store.runs.updateRun(RUN_ID, { stage: 'awaiting_review' });
    const m = manager({
      cancelWaitMs: 60,
      continuePipeline: () => new Promise<RunOutcome>(() => undefined),
    });
    expect(m.continue(RUN_ID, { kind: 'feedback', text: 'x' })).toBe(true);
    expect(await m.cancel(RUN_ID)).toBe(false);
  });

  it('answers pending when the aborted run has not settled within the wait', async () => {
    createRow();
    store.runs.updateRun(RUN_ID, { stage: 'interrupted' });
    const m = manager({
      cancelWaitMs: 60,
      continuePipeline: () => new Promise<RunOutcome>(() => undefined),
    });
    expect(await m.cancel(RUN_ID)).toBe('pending');
  });

  it('returns false when the continuation it waited for completed the run', async () => {
    createRow();
    store.runs.updateRun(RUN_ID, { stage: 'awaiting_review' });
    const m = manager({
      continuePipeline: async () => {
        await new Promise((r) => setTimeout(r, 40));
        store.runs.updateRun(RUN_ID, { stage: 'complete' });
        return {} as RunOutcome;
      },
    });
    expect(m.continue(RUN_ID, { kind: 'approve' })).toBe(true);
    expect(await m.cancel(RUN_ID)).toBe(false);
  });

  it('refuses a run that is not resting or stopped', async () => {
    createRow();
    store.runs.updateRun(RUN_ID, { stage: 'complete' });
    expect(await manager().cancel(RUN_ID)).toBe(false);
  });
});

describe('RunManager.resume', () => {
  it('starts one continuation for a stopped run, and a double resume is busy', async () => {
    createRow();
    for (const stage of ['interrupted', 'blocked'] as const) {
      store.runs.updateRun(RUN_ID, { stage });
      const entries: ContinueEntry[] = [];
      let release!: () => void;
      const m = manager({
        continuePipeline: (_id, entry) => {
          entries.push(entry);
          return new Promise<RunOutcome>((r) => (release = () => r({} as RunOutcome)));
        },
      });
      expect(m.resume(RUN_ID)).toBe('started');
      expect(m.resume(RUN_ID)).toBe('busy');
      expect(entries).toEqual([{ kind: 'resume' }]);
      release();
      await m.shutdown();
      store.runs.updateRun(RUN_ID, { stage: 'implementing' });
    }
  });

  it('passes keep through', async () => {
    createRow();
    store.runs.updateRun(RUN_ID, { stage: 'interrupted' });
    const entries: ContinueEntry[] = [];
    const m = manager({
      continuePipeline: async (_id, entry) => {
        entries.push(entry);
        return {} as RunOutcome;
      },
    });
    expect(m.resume(RUN_ID, { keep: true })).toBe('started');
    await m.shutdown();
    expect(entries).toEqual([{ kind: 'resume', keep: true }]);
  });

  it.each(['complete', 'failed', 'cancelled', 'implementing', 'awaiting_review'] as const)(
    'refuses a run in %s',
    (stage) => {
      createRow();
      store.runs.updateRun(RUN_ID, { stage });
      expect(manager().resume(RUN_ID)).toBe('not_resumable');
    },
  );

  it('refuses an unknown run', () => {
    expect(manager().resume('r20260102-bbbbbb')).toBe('not_resumable');
  });

  it('does not let a resume and a continue both hold a run', async () => {
    createRow();
    store.runs.updateRun(RUN_ID, { stage: 'interrupted' });
    let release!: () => void;
    const m = manager({
      continuePipeline: () => new Promise<RunOutcome>((r) => (release = () => r({} as RunOutcome))),
    });
    expect(m.resume(RUN_ID)).toBe('started');
    expect(m.continue(RUN_ID, { kind: 'approve' })).toBe(false);
    release();
    await m.shutdown();
  });
});

describe('RunManager.shutdown', () => {
  it('aborts every run with a ShutdownError and waits for them to settle', async () => {
    const fake = fakePipeline();
    let settled = false;
    const m = manager({
      startPipeline: (input) =>
        fake.startPipeline(input).then(async (o) => {
          await new Promise((r) => setTimeout(r, 10));
          settled = true;
          return o;
        }),
    });
    await m.start({ projectId, baseRef: 'main', planText: PLAN });
    await m.shutdown();
    expect(fake.inputs[0]!.signal!.reason).toBeInstanceOf(ShutdownError);
    expect(settled).toBe(true);
    await expect(m.start({ projectId, baseRef: 'main', planText: PLAN })).rejects.toThrow(
      /shutting down/,
    );
  });

  it('stops waiting after the timeout', async () => {
    const m = manager({
      startPipeline: (input) =>
        new Promise(() => {
          setTimeout(() => {
            createRow();
            input.onStarted?.(RUN_ID);
          }, 1);
        }),
    });
    await m.start({ projectId, baseRef: 'main', planText: PLAN });
    const t0 = Date.now();
    await m.shutdown(30);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe('RunManager.continue', () => {
  const outcome: RunOutcome = {
    runId: RUN_ID,
    runDir: '/runs/a',
    stage: 'awaiting_review',
    note: null,
    prNumber: null,
  };

  /** A continuation that runs until released (or its signal aborts). */
  function fakeContinuation() {
    const calls: { runId: string; entry: ContinueEntry; signal: AbortSignal }[] = [];
    let release: () => void = () => undefined;
    const continuePipeline = (runId: string, entry: ContinueEntry, signal: AbortSignal) => {
      calls.push({ runId, entry, signal });
      return new Promise<RunOutcome>((resolve) => {
        release = () => resolve(outcome);
        signal.addEventListener('abort', () => {
          if (!(signal.reason instanceof ShutdownError)) {
            store.runs.updateRun(RUN_ID, { stage: 'cancelled' });
          }
          resolve(outcome);
        });
      });
    };
    return { calls, continuePipeline, release: () => release() };
  }

  const rest = (stage: 'awaiting_review' | 'awaiting_plan_approval' = 'awaiting_review') => {
    createRow();
    store.runs.updateRun(RUN_ID, { stage });
  };

  it('starts a continuation for a resting run and tracks it until it ends', async () => {
    rest();
    const fake = fakeContinuation();
    const m = manager({ continuePipeline: fake.continuePipeline });
    expect(m.continue(RUN_ID, { kind: 'feedback', text: 'more' })).toBe(true);
    expect(fake.calls.map((c) => [c.runId, c.entry])).toEqual([
      [RUN_ID, { kind: 'feedback', text: 'more' }],
    ]);
    // Driven in this process now: a second continuation is refused.
    expect(m.continue(RUN_ID, { kind: 'approve' })).toBe(false);
    fake.release();
    await m.shutdown();
    expect(m.continue(RUN_ID, { kind: 'approve' })).toBe(false); // stopping
  });

  it('can continue again once the first continuation has ended', async () => {
    rest();
    const fake = fakeContinuation();
    const m = manager({ continuePipeline: fake.continuePipeline });
    expect(m.continue(RUN_ID, { kind: 'approve' })).toBe(true);
    fake.release();
    await new Promise((r) => setTimeout(r, 0));
    expect(m.continue(RUN_ID, { kind: 'approve' })).toBe(true);
    await m.shutdown();
  });

  it('refuses a run that is unknown or not resting, starting nothing', () => {
    const fake = fakeContinuation();
    const m = manager({ continuePipeline: fake.continuePipeline });
    expect(m.continue(RUN_ID, { kind: 'approve' })).toBe(false);
    createRow(); // stage: setup
    expect(m.continue(RUN_ID, { kind: 'approve' })).toBe(false);
    store.runs.updateRun(RUN_ID, { stage: 'complete' });
    expect(m.continue(RUN_ID, { kind: 'approve' })).toBe(false);
    expect(fake.calls).toEqual([]);
  });

  it('cancels a continuation it drives, and interrupts it on shutdown', async () => {
    rest();
    const fake = fakeContinuation();
    const m = manager({ continuePipeline: fake.continuePipeline });
    m.continue(RUN_ID, { kind: 'approve' });
    store.runs.updateRun(RUN_ID, { stage: 'fixing' }); // the continuation left rest
    expect(await m.cancel(RUN_ID)).toBe(true);
    expect(fake.calls[0]!.signal.aborted).toBe(true);
    await m.shutdown();
  });

  it('reports a continuation that throws and frees the run', async () => {
    rest();
    const errors: unknown[] = [];
    const m = manager({
      continuePipeline: () => Promise.reject(new Error('boom')),
      onError: (_id, err) => errors.push(err),
    });
    expect(m.continue(RUN_ID, { kind: 'approve' })).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect((errors[0] as Error).message).toBe('boom');
    expect(m.continue(RUN_ID, { kind: 'approve' })).toBe(true);
    await m.shutdown();
  });

  it('reopens the final review when a continuation fails before it could run', async () => {
    rest();
    store.runs.openDecision({
      runId: RUN_ID,
      kind: 'final_review',
      title: 'Ready',
      body: 'b',
      options: [{ id: 'approve', label: 'Approve' }],
    });
    store.runs.answerDecision(1, { choice: 'approve', note: null });
    const m = manager({ continuePipeline: () => Promise.reject(new Error('no saved config')) });
    expect(m.continue(RUN_ID, { kind: 'approve' })).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    const open = store.runs.listDecisions({ runId: RUN_ID, status: 'open' });
    expect(open.map((d) => d.kind)).toEqual(['final_review']);
    expect(open[0]!.body).toContain('no saved config');
    await m.shutdown();
  });

  it('reopens the plan approval when a plan continuation fails before it could run', async () => {
    rest('awaiting_plan_approval');
    store.runs.openDecision({
      runId: RUN_ID,
      kind: 'plan_approval',
      title: 'Plan',
      body: 'b',
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'revise', label: 'Request changes' },
      ],
    });
    store.runs.answerDecision(1, { choice: 'approve', note: null });
    const m = manager({ continuePipeline: () => Promise.reject(new Error('no saved config')) });
    expect(m.continue(RUN_ID, { kind: 'plan_approve' })).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    const open = store.runs.listDecisions({ runId: RUN_ID, status: 'open' });
    expect(open.map((d) => d.kind)).toEqual(['plan_approval']);
    expect(open[0]!.options!.map((o) => o.id)).toEqual(['approve', 'revise']);
    expect(open[0]!.body).toContain('no saved config');
    await m.shutdown();
  });
});

describe('RunManager.start from a description', () => {
  it('starts the pipeline with the description and writes no plan file', async () => {
    const fake = fakePipeline();
    const m = manager({ startPipeline: fake.startPipeline });
    await m.start({ projectId, baseRef: 'main', description: 'Add a widgets page' });
    const input = fake.inputs[0]!;
    expect(input.description).toBe('Add a widgets page');
    expect(input.planFile).toBeUndefined();
    expect(existsSync(join(root, 'plans'))).toBe(false);
    await m.shutdown();
  });

  it('refuses both a plan and a description, and neither', async () => {
    const fake = fakePipeline();
    const m = manager({ startPipeline: fake.startPipeline });
    await expect(
      m.start({ projectId, baseRef: 'main', planText: PLAN, description: 'x' }),
    ).rejects.toBeInstanceOf(InvalidStartError);
    await expect(m.start({ projectId, baseRef: 'main' })).rejects.toBeInstanceOf(InvalidStartError);
    for (const description of ['   ', 'x'.repeat(20_001)]) {
      await expect(m.start({ projectId, baseRef: 'main', description })).rejects.toBeInstanceOf(
        InvalidStartError,
      );
    }
    expect(fake.inputs).toHaveLength(0);
    await m.shutdown();
  });
});

// ---- Concurrency limits and the queue -------------------------------------------------------

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('RunManager limits and queue', () => {
  const ZEROS = { checkFix: 0, reviewFix: 0, ciFix: 0, feedback: 0, checkRuns: 0 };
  let counter = 0;
  const newId = () => `r20260101-b${String(++counter).padStart(5, '0')}`;
  beforeEach(() => {
    counter = 0;
  });

  const addRun = (
    id: string,
    stage: Parameters<typeof store.runs.createRun>[0]['stage'],
    pid = projectId,
  ) =>
    store.runs.createRun({
      id,
      projectId: pid,
      title: id,
      stage,
      stageNote: null,
      branch: `bp/${id}`,
      worktreePath: '/wt',
      runDir: `/runs/${id}`,
      baseRef: 'main',
      baseSha: 'b',
      headSha: null,
      prNumber: null,
      planPath: '/p',
      planHash: 'h',
      implementer: null,
      rounds: ZEROS,
      ownerPid: null,
      ownerHost: null,
    });

  const otherProject = () =>
    store.runs.upsertProject({
      owner: 'o',
      repo: 'other',
      localPath: mkdtempSync(join(tmpdir(), 'bp-other-')),
      defaultBase: 'main',
    }).id;

  /**
   * Fake start pipelines that each run until the test opens their gate. A start from the queue
   * arrives with `input.runId` and adopts its row, as the real pipeline does.
   */
  function controlled() {
    interface Call {
      id: string;
      input: RunInput;
      hooks: PipelineHooks;
      gate: Deferred;
      started: Deferred;
    }
    const calls: Call[] = [];
    const waiting: Deferred<Call>[] = [];
    const startPipeline = async (input: RunInput, hooks: PipelineHooks): Promise<RunOutcome> => {
      const id = input.runId ?? newId();
      const call: Call = { id, input, hooks, gate: deferred(), started: deferred() };
      calls.push(call);
      const project = store.runs.listProjects().find((p) => p.localPath === input.repo)!;
      if (input.runId === undefined) addRun(id, 'setup', project.id);
      else store.runs.updateRun(id, { stage: 'setup' });
      input.onStarted?.(id);
      call.started.resolve();
      waiting.shift()?.resolve(call);
      const end = (stage: 'complete' | 'cancelled' | 'interrupted') => {
        store.runs.updateRun(id, { stage });
        return { runId: id, runDir: `/runs/${id}`, stage, note: null, prNumber: null };
      };
      await Promise.race([
        call.gate.promise,
        new Promise<void>((r) => input.signal!.addEventListener('abort', () => r())),
      ]);
      if (input.signal!.aborted) {
        return end(input.signal!.reason instanceof ShutdownError ? 'interrupted' : 'cancelled');
      }
      return end('complete');
    };
    /** Resolves with the next call that starts (or the one that already did not yet get awaited). */
    const nextStart = () => {
      const d = deferred<Call>();
      waiting.push(d);
      return d.promise;
    };
    return { calls, startPipeline, nextStart };
  }

  const queuedIds = () => store.runs.listQueued().map((q) => q.runId);
  const stageOf = (id: string) => store.runs.getRun(id)?.stage;
  const startReq = (
    pid = projectId,
    over: Partial<Parameters<ReturnType<typeof manager>['start']>[0]> = {},
  ) => ({
    projectId: pid,
    baseRef: 'main',
    description: 'Do the thing',
    ...over,
  });

  it('with maxRuns 2 queues the third start and starts it when one of the first two finishes', async () => {
    const fake = controlled();
    const m = manager({
      startPipeline: fake.startPipeline,
      limits: { maxRuns: 2, maxRunsPerProject: 5 },
    });
    const a = await m.start(startReq());
    const b = await m.start(startReq());
    const c = await m.start(startReq());
    expect(fake.calls).toHaveLength(2);
    expect(stageOf(a)).toBe('setup');
    expect(stageOf(c)).toBe('queued');
    expect(queuedIds()).toEqual([c]);
    expect(m.status()).toMatchObject({ inUse: 2, maxRuns: 2 });
    // The pending entry was stored before the start answered, with its position as an event.
    const stored = store.runs.listQueued()[0]!;
    expect(stored.entry).toMatchObject({ baseRef: 'main', description: 'Do the thing' });
    expect(store.runs.listEvents(c).find((e) => e.type === 'run.queued')?.payload).toEqual({
      position: 1,
    });

    const third = fake.nextStart();
    fake.calls[0]!.gate.resolve();
    const call = await third;
    expect(call.id).toBe(c);
    expect(call.input.runId).toBe(c);
    expect(call.input.description).toBe('Do the thing');
    expect(queuedIds()).toEqual([]);
    expect(stageOf(c)).toBe('setup');
    expect(store.runs.getRun(c)).toMatchObject({ ownerPid: process.pid });
    expect(m.status().inUse).toBe(2);
    expect(b).not.toBe(c);
    for (const x of fake.calls) x.gate.resolve();
    await m.shutdown();
  });

  it('with maxRunsPerProject 1 a second run in the same project waits while another project starts', async () => {
    const other = otherProject();
    const fake = controlled();
    const m = manager({
      startPipeline: fake.startPipeline,
      limits: { maxRuns: 5, maxRunsPerProject: 1 },
    });
    const a1 = await m.start(startReq());
    const a2 = await m.start(startReq());
    const b1 = await m.start(startReq(other));
    expect(stageOf(a1)).toBe('setup');
    expect(stageOf(a2)).toBe('queued');
    expect(stageOf(b1)).toBe('setup');
    expect(fake.calls).toHaveLength(2);

    const next = fake.nextStart();
    fake.calls[0]!.gate.resolve();
    expect((await next).id).toBe(a2);
    for (const x of fake.calls) x.gate.resolve();
    await m.shutdown();
  });

  it('starts queued runs first-in first-out, skipping one that does not fit its project', async () => {
    const other = otherProject();
    const fake = controlled();
    const m = manager({
      startPipeline: fake.startPipeline,
      limits: { maxRuns: 2, maxRunsPerProject: 1 },
    });
    await m.start(startReq()); // project A, running
    await m.start(startReq(other)); // project B, running
    const qa = await m.start(startReq()); // A, queued first
    const qb = await m.start(startReq(other)); // B, queued second
    expect(queuedIds()).toEqual([qa, qb]);

    // The slot of project B frees: qa is older but its project is still full, so qb starts.
    const next = fake.nextStart();
    fake.calls[1]!.gate.resolve();
    expect((await next).id).toBe(qb);
    expect(queuedIds()).toEqual([qa]);
    // Project A frees: qa starts.
    const nextA = fake.nextStart();
    fake.calls[0]!.gate.resolve();
    expect((await nextA).id).toBe(qa);
    for (const x of fake.calls) x.gate.resolve();
    await m.shutdown();
  });

  it('starts each queued run exactly once when two slots free at the same moment', async () => {
    const fake = controlled();
    const m = manager({
      startPipeline: fake.startPipeline,
      limits: { maxRuns: 2, maxRunsPerProject: 5 },
    });
    await m.start(startReq());
    await m.start(startReq());
    const q1 = await m.start(startReq());
    const q2 = await m.start(startReq());
    const q3 = await m.start(startReq());
    const both = Promise.all([fake.nextStart(), fake.nextStart()]);
    // Both finish in the same tick.
    fake.calls[0]!.gate.resolve();
    fake.calls[1]!.gate.resolve();
    const started = await both;
    expect(started.map((c) => c.id)).toEqual([q1, q2]);
    expect(queuedIds()).toEqual([q3]);
    const fromQueue = fake.calls.filter((c) => c.input.runId !== undefined).map((c) => c.id);
    expect(fromQueue).toEqual([q1, q2]);
    expect(m.status().inUse).toBe(2);
    for (const x of fake.calls) x.gate.resolve();
    await m.shutdown();
  });

  it('frees the slot of a run waiting for an answer, and its answer waits for a slot', async () => {
    const fake = controlled();
    const m = manager({
      startPipeline: fake.startPipeline,
      limits: { maxRuns: 1, maxRunsPerProject: 1 },
    });
    await m.start(startReq());
    const a = fake.calls[0]!;
    expect(m.status().inUse).toBe(1);
    // The pipeline enters awaiting_decision: nothing is driven, so the slot is free.
    a.hooks.slots.release();
    expect(m.status().inUse).toBe(0);
    const nextB = fake.nextStart();
    const b = await m.start(startReq());
    expect(stageOf(b)).toBe('setup');
    expect(fake.calls).toHaveLength(2);
    const c = await m.start(startReq());
    expect(stageOf(c)).toBe('queued');

    // The answer arrives, but B holds the only slot: A waits for it.
    let acquired = false;
    const acquiring = a.hooks.slots.acquire(a.input.signal).then(() => (acquired = true));
    await nextB;
    await new Promise((r) => setImmediate(r));
    expect(acquired).toBe(false);
    expect(m.status().inUse).toBe(1);

    // B ends: the waiting run takes the slot before the queued run C does.
    fake.calls[1]!.gate.resolve();
    await acquiring;
    expect(acquired).toBe(true);
    expect(stageOf(c)).toBe('queued');
    expect(m.status().inUse).toBe(1);

    const nextC = fake.nextStart();
    a.gate.resolve();
    expect((await nextC).id).toBe(c);
    for (const x of fake.calls) x.gate.resolve();
    await m.shutdown();
  });

  it('stops waiting for a slot when the run is cancelled, and release is idempotent', async () => {
    const fake = controlled();
    const m = manager({
      startPipeline: fake.startPipeline,
      limits: { maxRuns: 1, maxRunsPerProject: 1 },
    });
    const a = await m.start(startReq());
    const call = fake.calls[0]!;
    call.hooks.slots.release();
    call.hooks.slots.release();
    expect(m.status().inUse).toBe(0);
    await m.start(startReq()); // B takes the slot
    const acquiring = call.hooks.slots.acquire(call.input.signal);
    const rejected = expect(acquiring).rejects.toBeDefined();
    expect(await m.cancel(a)).toBe(true);
    await rejected;
    // A cancelled waiter never takes a slot later.
    fake.calls[1]!.gate.resolve();
    await m.shutdown();
    expect(m.status().inUse).toBe(0);
  });

  it('holds a continuation to the limits: an answer with no free slot is queued and carried out later', async () => {
    const fake = controlled();
    const continuations: { runId: string; entry: ContinueEntry; stageSeen: string | undefined }[] =
      [];
    const m = manager({
      startPipeline: fake.startPipeline,
      continuePipeline: async (runId, entry) => {
        continuations.push({ runId, entry, stageSeen: stageOf(runId) });
        store.runs.updateRun(runId, { stage: 'awaiting_review' });
        return { runId, runDir: '/r', stage: 'awaiting_review', note: null, prNumber: null };
      },
      limits: { maxRuns: 1, maxRunsPerProject: 1 },
    });
    addRun('r20260101-c00001', 'awaiting_plan_approval');
    addRun('r20260101-c00002', 'interrupted');
    store.runs.updateRun('r20260101-c00001', { stageNote: 'Plan v1 ready' });
    await m.start(startReq());

    expect(m.continue('r20260101-c00001', { kind: 'plan_approve' })).toBe(true);
    expect(m.resume('r20260101-c00002')).toBe('started');
    expect(continuations).toEqual([]);
    expect(queuedIds()).toEqual(['r20260101-c00001', 'r20260101-c00002']);
    expect(stageOf('r20260101-c00001')).toBe('queued');
    // A second answer for a queued run is not a second continuation.
    expect(m.continue('r20260101-c00001', { kind: 'plan_approve' })).toBe(false);
    expect(m.resume('r20260101-c00002')).toBe('busy');

    fake.calls[0]!.gate.resolve();
    await vi.waitFor(() => expect(continuations.length).toBe(2));
    // Back at its resting stage (with its note) when the continuation picks it up.
    expect(continuations[0]).toEqual({
      runId: 'r20260101-c00001',
      entry: { kind: 'plan_approve' },
      stageSeen: 'awaiting_plan_approval',
    });
    expect(continuations[1]).toEqual({
      runId: 'r20260101-c00002',
      entry: { kind: 'resume' },
      stageSeen: 'interrupted',
    });
    expect(queuedIds()).toEqual([]);
    await m.shutdown();
  });

  it('lets approving and cancelling run without a slot: they only finish the run', async () => {
    const fake = controlled();
    const entries: ContinueEntry[] = [];
    const m = manager({
      startPipeline: fake.startPipeline,
      continuePipeline: async (runId, entry) => {
        entries.push(entry);
        return { runId, runDir: '/r', stage: 'complete', note: null, prNumber: null };
      },
      limits: { maxRuns: 1, maxRunsPerProject: 1 },
    });
    addRun('r20260101-c00003', 'awaiting_review');
    await m.start(startReq());
    expect(m.continue('r20260101-c00003', { kind: 'approve' })).toBe(true);
    expect(stageOf('r20260101-c00003')).toBe('awaiting_review');
    await vi.waitFor(() => expect(entries).toEqual([{ kind: 'approve' }]));
    expect(queuedIds()).toEqual([]);
    fake.calls[0]!.gate.resolve();
    await m.shutdown();
  });

  it('cancels a queued start without ever starting it', async () => {
    const fake = controlled();
    const m = manager({
      startPipeline: fake.startPipeline,
      limits: { maxRuns: 1, maxRunsPerProject: 1 },
    });
    await m.start(startReq());
    const q = await m.start(startReq());
    expect(await m.cancel(q)).toBe(true);
    expect(stageOf(q)).toBe('cancelled');
    expect(queuedIds()).toEqual([]);
    fake.calls[0]!.gate.resolve();
    await m.shutdown();
    expect(fake.calls).toHaveLength(1);
  });

  it('cancels a queued answer by putting the run back at rest and cancelling it from there', async () => {
    const fake = controlled();
    const entries: [string, ContinueEntry][] = [];
    const m = manager({
      startPipeline: fake.startPipeline,
      continuePipeline: async (runId, entry) => {
        entries.push([stageOf(runId)!, entry]);
        if (entry.kind === 'cancel') store.runs.updateRun(runId, { stage: 'cancelled' });
        return { runId, runDir: '/r', stage: 'cancelled', note: null, prNumber: null };
      },
      limits: { maxRuns: 1, maxRunsPerProject: 1 },
    });
    addRun('r20260101-c00004', 'awaiting_plan_approval');
    await m.start(startReq());
    expect(m.continue('r20260101-c00004', { kind: 'plan_approve' })).toBe(true);
    expect(stageOf('r20260101-c00004')).toBe('queued');
    expect(await m.cancel('r20260101-c00004')).toBe(true);
    // Only the cancel ran, from the rest stage; the approval was dropped.
    expect(entries).toEqual([['awaiting_plan_approval', { kind: 'cancel' }]]);
    expect(stageOf('r20260101-c00004')).toBe('cancelled');
    fake.calls[0]!.gate.resolve();
    await m.shutdown();
  });

  it('keeps queued runs queued across a restart and starts them after pump', async () => {
    const first = controlled();
    const m1 = manager({
      startPipeline: first.startPipeline,
      limits: { maxRuns: 1, maxRunsPerProject: 1 },
    });
    await m1.start(startReq());
    const q1 = await m1.start(startReq());
    const q2 = await m1.start(startReq());
    // The server stops: the running run is interrupted, the queued ones stay queued.
    await m1.shutdown();
    expect(stageOf(first.calls[0]!.id)).toBe('interrupted');
    expect(queuedIds()).toEqual([q1, q2]);

    const second = controlled();
    const m2 = manager({
      startPipeline: second.startPipeline,
      limits: { maxRuns: 1, maxRunsPerProject: 1 },
    });
    // Nothing starts by itself before the server asks, after reconciliation.
    expect(second.calls).toHaveLength(0);
    const next = second.nextStart();
    m2.pump();
    expect((await next).id).toBe(q1);
    expect(queuedIds()).toEqual([q2]);
    const after = second.nextStart();
    second.calls[0]!.gate.resolve();
    expect((await after).id).toBe(q2);
    for (const x of second.calls) x.gate.resolve();
    await m2.shutdown();
  });

  it('puts a queued start back in the queue when the server stops before it got going', async () => {
    const started = deferred();
    const m = manager({
      startPipeline: async (input) => {
        started.resolve();
        await new Promise<void>((r) => input.signal!.addEventListener('abort', () => r()));
        // Stopped in preflight, before any run file or onStarted.
        throw input.signal!.reason;
      },
      limits: { maxRuns: 1, maxRunsPerProject: 1 },
    });
    const id = newId();
    store.runs.createQueuedRun(
      {
        id,
        projectId,
        title: 'Q',
        stageNote: null,
        branch: '',
        worktreePath: '',
        runDir: `/runs/${id}`,
        baseRef: 'main',
        baseSha: '',
        headSha: null,
        prNumber: null,
        planPath: '',
        planHash: '',
        implementer: null,
        rounds: ZEROS,
      },
      { repo: root, baseRef: 'main', description: 'x', config: loadRunConfig(root) },
    );
    m.pump();
    await started.promise;
    expect(stageOf(id)).toBe('setup');
    await m.shutdown();
    expect(stageOf(id)).toBe('queued');
    expect(queuedIds()).toEqual([id]);
  });

  it('marks a queued start failed, not lost, when it cannot get started', async () => {
    const errors: unknown[] = [];
    const m = manager({
      startPipeline: async () => {
        throw new Error('No checks: section in .block-party.yaml');
      },
      limits: { maxRuns: 1, maxRunsPerProject: 1 },
      onError: (_id, e) => errors.push(e),
    });
    const id = newId();
    store.runs.createQueuedRun(
      {
        id,
        projectId,
        title: 'Q',
        stageNote: null,
        branch: '',
        worktreePath: '',
        runDir: `/runs/${id}`,
        baseRef: 'main',
        baseSha: '',
        headSha: null,
        prNumber: null,
        planPath: '',
        planHash: '',
        implementer: null,
        rounds: ZEROS,
      },
      { repo: root, baseRef: 'main', description: 'x', config: loadRunConfig(root) },
    );
    m.pump();
    await vi.waitFor(() => expect(stageOf(id)).toBe('failed'));
    expect(store.runs.getRun(id)?.stageNote).toMatch(/Could not start: No checks/);
    expect(queuedIds()).toEqual([]);
    expect(errors).toHaveLength(1);
    await m.shutdown();
  });

  it('lets exactly one of a start and a resume take the last slot, in either order', async () => {
    for (const startFirst of [true, false]) {
      const fake = controlled();
      const resumed: string[] = [];
      const m = manager({
        startPipeline: fake.startPipeline,
        continuePipeline: (runId, entry, signal) => {
          resumed.push(runId);
          return new Promise((resolve) =>
            signal.addEventListener('abort', () =>
              resolve({ runId, runDir: '/r', stage: 'interrupted', note: null, prNumber: null }),
            ),
          );
        },
        limits: { maxRuns: 2, maxRunsPerProject: 5 },
      });
      await m.start(startReq()); // one run already going
      const stopped = newId();
      addRun(stopped, 'interrupted');
      // Neither is awaited before the other decides: the same tick.
      let starting: Promise<string>;
      let result: ReturnType<typeof m.resume>;
      if (startFirst) {
        starting = m.start(startReq());
        result = m.resume(stopped);
      } else {
        result = m.resume(stopped);
        starting = m.start(startReq());
      }
      const id = await starting;
      expect(result).toBe('started');
      expect(m.status().inUse).toBe(2);
      const startLaunched = stageOf(id) === 'setup';
      const resumeLaunched = resumed.includes(stopped);
      expect([startLaunched, resumeLaunched].filter(Boolean)).toHaveLength(1);
      expect(stageOf(startLaunched ? stopped : id)).toBe('queued');
      expect(queuedIds()).toContain(startLaunched ? stopped : id);
      expect(queuedIds()).not.toContain(startLaunched ? id : stopped);
      for (const x of fake.calls) x.gate.resolve();
      await m.shutdown();
    }
  });

  it('lets exactly one of two simultaneous starts take the last slot', async () => {
    const fake = controlled();
    const m = manager({
      startPipeline: fake.startPipeline,
      limits: { maxRuns: 2, maxRunsPerProject: 5 },
    });
    await m.start(startReq());
    const [x, y] = await Promise.all([m.start(startReq()), m.start(startReq())]);
    expect(fake.calls).toHaveLength(2);
    expect(m.status().inUse).toBe(2);
    expect([stageOf(x), stageOf(y)].sort()).toEqual(['queued', 'setup']);
    // Same with a plan to write first: the check comes after the write, never before.
    const [p, q] = await Promise.all([
      m.start({ projectId, baseRef: 'main', planText: PLAN }),
      m.start({ projectId, baseRef: 'main', planText: PLAN }),
    ]);
    expect(m.status().inUse).toBe(2);
    expect(queuedIds()).toHaveLength(3);
    expect(new Set([p, q, x, y]).size).toBe(4);
    for (const c of fake.calls) c.gate.resolve();
    await m.shutdown();
  });

  it('says on the run that its answer waits for a slot, and puts the old note back', async () => {
    const fake = controlled();
    const m = manager({
      startPipeline: fake.startPipeline,
      limits: { maxRuns: 1, maxRunsPerProject: 1 },
    });
    const a = await m.start(startReq());
    const call = fake.calls[0]!;
    store.runs.updateRun(a, { stageNote: '1 P2 finding to triage' });
    call.hooks.slots.release();
    const nextB = fake.nextStart();
    await m.start(startReq());
    await nextB;
    const acquiring = call.hooks.slots.acquire(call.input.signal);
    expect(store.runs.getRun(a)?.stageNote).toBe('Waiting for a free slot');
    fake.calls[1]!.gate.resolve();
    await acquiring;
    expect(store.runs.getRun(a)?.stageNote).toBe('1 P2 finding to triage');
    call.gate.resolve();
    await m.shutdown();
  });

  it('keeps a claimed answer queued when shutdown stops it before it moved the run', async () => {
    const fake = controlled();
    const seen: ContinueEntry[] = [];
    const m1 = manager({
      startPipeline: fake.startPipeline,
      continuePipeline: (runId, entry, signal) => {
        seen.push(entry);
        // Stopped at rest: the run never moved, as when the signal is checked on entry.
        return new Promise((resolve) =>
          signal.addEventListener('abort', () =>
            resolve({
              runId,
              runDir: '/r',
              stage: 'awaiting_plan_approval',
              note: null,
              prNumber: null,
            }),
          ),
        );
      },
      limits: { maxRuns: 1, maxRunsPerProject: 1 },
    });
    const id = newId();
    addRun(id, 'awaiting_plan_approval');
    await m1.start(startReq());
    expect(m1.continue(id, { kind: 'plan_revise', note: 'shorter' })).toBe(true);
    expect(stageOf(id)).toBe('queued');
    fake.calls[0]!.gate.resolve();
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(stageOf(id)).toBe('awaiting_plan_approval');
    await m1.shutdown();
    // The answer was not lost: it is queued again with the same entry.
    expect(stageOf(id)).toBe('queued');
    expect(store.runs.listQueued().find((q) => q.runId === id)).toMatchObject({
      from: 'awaiting_plan_approval',
      entry: { kind: 'plan_revise', note: 'shorter' },
    });
    const again: ContinueEntry[] = [];
    const m2 = manager({
      continuePipeline: async (runId, entry) => {
        again.push(entry);
        return { runId, runDir: '/r', stage: 'awaiting_plan_approval', note: null, prNumber: null };
      },
    });
    m2.pump();
    await vi.waitFor(() => expect(again).toEqual([{ kind: 'plan_revise', note: 'shorter' }]));
    await m2.shutdown();
  });

  it('skips git work for a run that was stopped while it waited for the project lock', async () => {
    let ran = false;
    let failure: unknown;
    const gate = deferred();
    const m = manager({
      startPipeline: async (input, hooks) => {
        const id = newId();
        addRun(id, 'setup');
        input.onStarted?.(id);
        const holding = m.withProjectLock(projectId, () => gate.promise);
        const ac = new AbortController();
        const waiting = hooks
          .lockProject(async () => {
            ran = true;
          }, ac.signal)
          .catch((e: unknown) => (failure = e));
        ac.abort(new Error('stopped'));
        gate.resolve();
        await holding;
        await waiting;
        return { runId: id, runDir: '/r', stage: 'cancelled', note: null, prNumber: null };
      },
    });
    await m.start(startReq());
    await m.shutdown();
    expect(ran).toBe(false);
    expect((failure as Error).message).toBe('stopped');
  });

  it('does not count time spent waiting for the project lock toward the start timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const gate = deferred();
      const m = manager({
        startTimeoutMs: 1000,
        startPipeline: async (input, hooks) => {
          await hooks.lockProject(async () => undefined);
          const id = newId();
          addRun(id, 'setup');
          input.onStarted?.(id);
          return { runId: id, runDir: '/r', stage: 'complete', note: null, prNumber: null };
        },
      });
      void m.withProjectLock(projectId, () => gate.promise);
      let outcome: string | Error | undefined;
      void m.start(startReq()).then(
        (id) => (outcome = id),
        (e: Error) => (outcome = e),
      );
      await vi.advanceTimersByTimeAsync(900);
      expect(outcome).toBeUndefined();
      gate.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(typeof outcome).toBe('string');
      await m.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows queued runs their place: the run list reports the position', async () => {
    const fake = controlled();
    const m = manager({
      startPipeline: fake.startPipeline,
      limits: { maxRuns: 1, maxRunsPerProject: 1 },
    });
    await m.start(startReq());
    const q1 = await m.start(startReq());
    const q2 = await m.start(startReq());
    expect(store.runs.listEvents(q2).find((e) => e.type === 'run.queued')?.payload).toEqual({
      position: 2,
    });
    expect(queuedIds()).toEqual([q1, q2]);
    for (const x of fake.calls) x.gate.resolve();
    await m.shutdown();
  });
});

describe('RunManager.withProjectLock', () => {
  it('runs work for one key one at a time, in order, and survives a failure', async () => {
    const m = manager();
    const order: string[] = [];
    const gate1 = deferred();
    const first = m.withProjectLock('p', async () => {
      order.push('first:start');
      await gate1.promise;
      order.push('first:end');
      throw new Error('boom');
    });
    const second = m.withProjectLock('p', async () => {
      order.push('second:start');
      return 2;
    });
    const firstResult = expect(first).rejects.toThrow('boom');
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(['first:start']);
    gate1.resolve();
    await firstResult;
    expect(await second).toBe(2);
    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('does not make different projects wait for each other', async () => {
    const m = manager();
    const gate = deferred();
    const a = m.withProjectLock('a', () => gate.promise);
    const ran = await m.withProjectLock('b', async () => 'b ran');
    expect(ran).toBe('b ran');
    gate.resolve();
    await a;
  });

  it('never lets two setups in one project run `git worktree add` at once', async () => {
    const m = manager({
      limits: { maxRuns: 5, maxRunsPerProject: 5 },
      startPipeline: async (input, hooks) => {
        const id = newRunIdForLock();
        addLockRow(id);
        input.onStarted?.(id);
        // The real pipeline wraps createWorktree like this.
        await hooks.lockProject(async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          entered.push(id);
          await gates[entered.length - 1]!.promise;
          active--;
        });
        return { runId: id, runDir: '/r', stage: 'complete', note: null, prNumber: null };
      },
    });
    let active = 0;
    let maxActive = 0;
    const entered: string[] = [];
    const gates = [deferred(), deferred(), deferred()];
    let n = 0;
    const newRunIdForLock = () => `r20260101-d${String(++n).padStart(5, '0')}`;
    const addLockRow = (id: string) =>
      store.runs.createRun({
        id,
        projectId,
        title: id,
        stage: 'setup',
        stageNote: null,
        branch: 'b',
        worktreePath: '/wt',
        runDir: '/r',
        baseRef: 'main',
        baseSha: 'b',
        headSha: null,
        prNumber: null,
        planPath: '',
        planHash: '',
        implementer: null,
        rounds: { checkFix: 0, reviewFix: 0, ciFix: 0, feedback: 0, checkRuns: 0 },
        ownerPid: null,
        ownerHost: null,
      });
    await m.start({ projectId, baseRef: 'main', description: 'one' });
    await m.start({ projectId, baseRef: 'main', description: 'two' });
    await m.start({ projectId, baseRef: 'main', description: 'three' });
    await new Promise((r) => setImmediate(r));
    expect(entered).toHaveLength(1);
    gates[0]!.resolve();
    await vi.waitFor(() => expect(entered).toHaveLength(2));
    gates[1]!.resolve();
    await vi.waitFor(() => expect(entered).toHaveLength(3));
    gates[2]!.resolve();
    await m.shutdown();
    expect(maxActive).toBe(1);
  });
});
