import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunInput, RunOutcome } from '../core/run/pipeline.js';
import { ShutdownError } from '../core/run/pipeline-helpers.js';
import { parsePlan } from '../core/run/plan.js';
import { openStore, type Store } from '../core/store/index.js';
import {
  createRunManager,
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
    rounds: { checkFix: 0, reviewFix: 0 },
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
      input.signal!.addEventListener('abort', () =>
        resolve({
          runId: RUN_ID,
          runDir: '/runs/a',
          stage: input.signal!.reason instanceof ShutdownError ? 'interrupted' : 'cancelled',
          note: null,
          prNumber: null,
        }),
      );
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
    expect(readFileSync(input.planFile, 'utf8')).toBe(PLAN);
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
    expect(m.cancel(RUN_ID)).toBe(false);
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
  it('aborts the in-process run with a plain abort', async () => {
    const fake = fakePipeline();
    const m = manager({ startPipeline: fake.startPipeline });
    const id = await m.start({ projectId, baseRef: 'main', planText: PLAN });
    const signal = fake.inputs[0]!.signal!;
    expect(m.cancel(id)).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).not.toBeInstanceOf(ShutdownError);
    expect(m.cancel(id)).toBe(false); // already cancelled
  });

  it('returns false for a run it does not own', () => {
    expect(manager().cancel('r20260102-bbbbbb')).toBe(false);
  });

  it('forgets a run once its pipeline settles', async () => {
    const fake = fakePipeline();
    const m = manager({ startPipeline: fake.startPipeline });
    const id = await m.start({ projectId, baseRef: 'main', planText: PLAN });
    m.cancel(id);
    await new Promise((r) => setTimeout(r, 0));
    expect(m.cancel(id)).toBe(false);
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
