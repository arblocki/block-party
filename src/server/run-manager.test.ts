import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContinueEntry, RunInput, RunOutcome } from '../core/run/pipeline.js';
import { ShutdownError } from '../core/run/pipeline-helpers.js';
import { parsePlan } from '../core/run/plan.js';
import { openStore, type Store } from '../core/store/index.js';
import {
  createRunManager,
  InvalidStartError,
  PlanValidationError,
  UnknownProjectError,
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
