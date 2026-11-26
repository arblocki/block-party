import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../core/store/index.js';
import type { RunInput } from '../core/store/runs.js';
import { pidAlive, reconcileRuns } from './reconcile.js';

const HOST = 'this-host';
const DEAD = 4001;
const LIVE = 4002;

let store: Store;
let projectId: string;

beforeEach(() => {
  store = openStore(':memory:');
  projectId = store.runs.upsertProject({
    owner: 'o',
    repo: 'r',
    localPath: '/src/r',
    defaultBase: 'main',
  }).id;
});

afterEach(() => store.close());

function addRun(id: string, over: Partial<RunInput> = {}) {
  return store.runs.createRun({
    id,
    projectId,
    title: 'T',
    stage: 'checking',
    stageNote: 'abc1234',
    branch: `bp/t-${id}`,
    worktreePath: '/wt',
    runDir: '/runs',
    baseRef: 'main',
    baseSha: 'base',
    headSha: null,
    prNumber: null,
    planPath: '/p',
    planHash: 'h',
    implementer: null,
    rounds: { checkFix: 0, reviewFix: 0 },
    ownerPid: DEAD,
    ownerHost: HOST,
    ...over,
  });
}

const reconcile = () =>
  reconcileRuns({
    runs: store.runs,
    hostname: HOST,
    isAlive: (pid) => pid === LIVE,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  });

describe('reconcileRuns', () => {
  it('marks an active run whose local owner is gone interrupted, with an event and decision', () => {
    addRun('r20260101-aaaaaa');
    expect(reconcile()).toEqual(['r20260101-aaaaaa']);

    const run = store.runs.getRun('r20260101-aaaaaa');
    expect(run).toMatchObject({
      stage: 'interrupted',
      stageNote: `owner process ${DEAD} is gone`,
    });
    expect(store.runs.listEvents('r20260101-aaaaaa')).toEqual([
      expect.objectContaining({
        type: 'run.interrupted',
        ts: '2026-01-01T00:00:00.000Z',
        payload: { stage: 'checking', note: `owner process ${DEAD} is gone` },
      }),
    ]);
    expect(store.runs.listDecisions({ runId: 'r20260101-aaaaaa' })).toEqual([
      expect.objectContaining({
        kind: 'interrupted',
        status: 'open',
        title: 'Run interrupted',
        body: `The run stopped while checking (abc1234): owner process ${DEAD} is gone.`,
        attach: null,
      }),
    ]);
  });

  it('attaches the pane command the implementer session recorded', () => {
    addRun('r20260101-aaaaaa', {
      stage: 'implementing',
      stageNote: null,
      implementer: { mode: 'pane', sessionId: 's', paneLabel: 'bp-x-impl' },
    });
    store.runs.appendEvent({
      runId: 'r20260101-aaaaaa',
      ts: 't',
      type: 'implementer.session',
      payload: { mode: 'pane', attach: 'herdr attach 3 (workspace bp-x-impl)' },
    });
    reconcile();
    expect(store.runs.listDecisions({ runId: 'r20260101-aaaaaa' })[0]).toMatchObject({
      body: `The run stopped while implementing: owner process ${DEAD} is gone.`,
      attach: 'herdr attach 3 (workspace bp-x-impl)',
    });
  });

  it('leaves terminal runs, live owners, other hosts and ownerless runs alone', () => {
    addRun('r20260101-aaaaaa', { stage: 'complete' });
    addRun('r20260101-bbbbbb', { stage: 'cancelled' });
    addRun('r20260101-cccccc', { ownerPid: LIVE });
    addRun('r20260101-dddddd', { ownerHost: 'other-host' });
    addRun('r20260101-eeeeee', { ownerPid: null, ownerHost: null });
    const before = store.runs.listRuns();

    expect(reconcile()).toEqual([]);
    expect(store.runs.listRuns()).toEqual(before);
    expect(store.runs.listDecisions()).toEqual([]);
    for (const r of before) expect(store.runs.listEvents(r.id)).toEqual([]);
  });

  it('leaves resting runs alone even when their owner is gone', () => {
    addRun('r20260101-aaaaaa', { stage: 'awaiting_plan_approval' });
    addRun('r20260101-bbbbbb', { stage: 'awaiting_review' });
    const before = store.runs.listRuns();
    expect(reconcile()).toEqual([]);
    expect(store.runs.listRuns()).toEqual(before);
    expect(store.runs.listDecisions()).toEqual([]);
  });

  it('marks a dead-owner awaiting_decision run interrupted', () => {
    addRun('r20260101-aaaaaa', { stage: 'awaiting_decision', stageNote: null });
    expect(reconcile()).toEqual(['r20260101-aaaaaa']);
    expect(store.runs.getRun('r20260101-aaaaaa')?.stage).toBe('interrupted');
    expect(store.runs.listEvents('r20260101-aaaaaa')[0]).toMatchObject({
      payload: { stage: 'awaiting_decision' },
    });
  });

  it('dismisses the open optioned decisions of an interrupted run', () => {
    addRun('r20260101-aaaaaa', { stage: 'awaiting_decision' });
    const q = store.runs.openDecision({
      runId: 'r20260101-aaaaaa',
      kind: 'dispute',
      title: 'Q',
      body: 'b',
      options: [{ id: 'a', label: 'A' }],
    });
    reconcile();
    expect(store.runs.getDecision(q)?.status).toBe('dismissed');
    // Only the interrupted decision is left open.
    expect(store.runs.listDecisions({ status: 'open' }).map((d) => d.kind)).toEqual([
      'interrupted',
    ]);
  });

  it('changes a run only once', () => {
    addRun('r20260101-aaaaaa');
    expect(reconcile()).toHaveLength(1);
    expect(reconcile()).toEqual([]);
    expect(store.runs.listDecisions()).toHaveLength(1);
  });
});

describe('pidAlive', () => {
  it('is true for this process and false for a pid that cannot exist', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2 ** 22 + 12345)).toBe(false);
  });
});
