import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../core/store/index.js';
import type { RunInput } from '../core/store/runs.js';
import { pidAlive, reconcileRuns, reopenStrandedRests, resumeOnRestart } from './reconcile.js';

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
    rounds: { checkFix: 0, reviewFix: 0, ciFix: 0, feedback: 0, checkRuns: 0 },
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
  it('marks an active run whose local owner is gone interrupted, with an event and decision', async () => {
    addRun('r20260101-aaaaaa');
    expect(await reconcile()).toEqual(['r20260101-aaaaaa']);

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
        body: `The run stopped while checking (abc1234): owner process ${DEAD} is gone. The agent had not yet written its report.`,
        attach: null,
      }),
    ]);
  });

  it('attaches the pane command the implementer session recorded', async () => {
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
    await reconcile();
    expect(store.runs.listDecisions({ runId: 'r20260101-aaaaaa' })[0]).toMatchObject({
      body: `The run stopped while implementing: owner process ${DEAD} is gone. The agent had not yet written its report.`,
      attach: 'herdr attach 3 (workspace bp-x-impl)',
    });
  });

  it('leaves terminal runs, live owners, other hosts and ownerless runs alone', async () => {
    addRun('r20260101-aaaaaa', { stage: 'complete' });
    addRun('r20260101-bbbbbb', { stage: 'cancelled' });
    addRun('r20260101-cccccc', { ownerPid: LIVE });
    addRun('r20260101-dddddd', { ownerHost: 'other-host' });
    addRun('r20260101-eeeeee', { ownerPid: null, ownerHost: null });
    const before = store.runs.listRuns();

    expect(await reconcile()).toEqual([]);
    expect(store.runs.listRuns()).toEqual(before);
    expect(store.runs.listDecisions()).toEqual([]);
    for (const r of before) expect(store.runs.listEvents(r.id)).toEqual([]);
  });

  it('leaves resting runs alone even when their owner is gone', async () => {
    addRun('r20260101-aaaaaa', { stage: 'awaiting_plan_approval' });
    addRun('r20260101-bbbbbb', { stage: 'awaiting_review' });
    const before = store.runs.listRuns();
    expect(await reconcile()).toEqual([]);
    expect(store.runs.listRuns()).toEqual(before);
    expect(store.runs.listDecisions()).toEqual([]);
  });

  it('marks a dead-owner awaiting_decision run interrupted', async () => {
    addRun('r20260101-aaaaaa', { stage: 'awaiting_decision', stageNote: null });
    expect(await reconcile()).toEqual(['r20260101-aaaaaa']);
    expect(store.runs.getRun('r20260101-aaaaaa')?.stage).toBe('interrupted');
    expect(store.runs.listEvents('r20260101-aaaaaa')[0]).toMatchObject({
      payload: { stage: 'awaiting_decision' },
    });
  });

  it('dismisses the open optioned decisions of an interrupted run', async () => {
    addRun('r20260101-aaaaaa', { stage: 'awaiting_decision' });
    const q = store.runs.openDecision({
      runId: 'r20260101-aaaaaa',
      kind: 'dispute',
      title: 'Q',
      body: 'b',
      options: [{ id: 'a', label: 'A' }],
    });
    await reconcile();
    expect(store.runs.getDecision(q)?.status).toBe('dismissed');
    // Only the interrupted decision is left open.
    expect(store.runs.listDecisions({ status: 'open' }).map((d) => d.kind)).toEqual([
      'interrupted',
    ]);
  });

  it('changes a run only once', async () => {
    addRun('r20260101-aaaaaa');
    expect(await reconcile()).toHaveLength(1);
    expect(await reconcile()).toEqual([]);
    expect(store.runs.listDecisions()).toHaveLength(1);
  });
});

function runDirWith(lines: string[], config?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'bp-reconcile-'));
  if (lines.length) writeFileSync(join(dir, 'events.jsonl'), lines.join('\n') + '\n');
  if (config !== undefined) {
    mkdirSync(join(dir, 'inputs'));
    writeFileSync(join(dir, 'inputs', 'config.json'), JSON.stringify(config));
  }
  return dir;
}
const hook = (name: string) =>
  JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', payload: { hook_event_name: name } });

describe('reconcile evidence', () => {
  it('replays hook events exactly once across two restarts, picking up later lines', async () => {
    const dir = runDirWith([hook('SessionStart'), hook('Stop')]);
    addRun('r20260101-aaaaaa', { runDir: dir });
    await reconcile();
    const hooks = () =>
      store.runs.listEvents('r20260101-aaaaaa').filter((e) => e.type === 'agent.hook');
    expect(hooks().map((e) => (e.payload as { event: string }).event)).toEqual([
      'SessionStart',
      'Stop',
    ]);
    // Second restart (the run was resumed and died again): only the new line is copied.
    store.runs.updateRun('r20260101-aaaaaa', { stage: 'checking', ownerPid: DEAD });
    appendFileSync(join(dir, 'events.jsonl'), hook('SessionEnd') + '\n');
    await reconcile();
    // A third pass over an unchanged file copies nothing.
    store.runs.updateRun('r20260101-aaaaaa', { stage: 'checking', ownerPid: DEAD });
    await reconcile();
    expect(hooks().map((e) => (e.payload as { event: string }).event)).toEqual([
      'SessionStart',
      'Stop',
      'SessionEnd',
    ]);
  });

  it('records pane_alive for a live terminal and says Resume will re-attach', async () => {
    const dir = runDirWith([]);
    addRun('r20260101-aaaaaa', {
      runDir: dir,
      implementer: { mode: 'pane', sessionId: 's', paneLabel: 'bp-r20260101-aaaaaa-impl' },
    });
    writeFileSync(join(dir, 'report.json'), '{}');
    const pane = { session: 'block-party', label: 'bp-r20260101-aaaaaa-impl', cwd: '/wt' };
    await reconcileRuns({
      runs: store.runs,
      hostname: HOST,
      isAlive: () => false,
      terminal: { list: async () => [pane], agentState: async () => 'working' },
    });
    const events = store.runs.listEvents('r20260101-aaaaaa');
    expect(events.map((e) => e.type)).toEqual(['run.interrupted', 'reconcile.pane_alive']);
    expect(events[1]!.payload).toEqual({ label: pane.label, state: 'working' });
    const [d] = store.runs.listDecisions({ runId: 'r20260101-aaaaaa' });
    expect(d!.body).toContain('still running in its terminal; Resume will re-attach to it');
    expect(d!.body).toContain('had written its report');
    expect(store.runs.getRun('r20260101-aaaaaa')?.stage).toBe('interrupted');
  });

  it('notes a closed terminal, and survives a herdr that is not running', async () => {
    addRun('r20260101-aaaaaa', {
      implementer: { mode: 'pane', sessionId: 's', paneLabel: 'bp-r20260101-aaaaaa-impl' },
    });
    await reconcileRuns({
      runs: store.runs,
      hostname: HOST,
      isAlive: () => false,
      terminal: {
        list: async () => {
          throw new Error('server_not_running');
        },
        agentState: async () => 'unknown',
      },
    });
    expect(store.runs.listEvents('r20260101-aaaaaa').map((e) => e.type)).toEqual([
      'run.interrupted',
    ]);
    expect(store.runs.listDecisions()[0]!.body).toContain('no longer open');
  });
});

describe('resumeOnRestart', () => {
  const calls: string[] = [];
  const manager = {
    resume: (id: string) => {
      calls.push(id);
      return 'started' as const;
    },
  };
  beforeEach(() => (calls.length = 0));
  const ids = ['r20260101-aaaaaa', 'r20260101-bbbbbb', 'r20260101-cccccc', 'r20260101-dddddd'];

  it('resumes only runs whose config asks for it', async () => {
    addRun(ids[0]!, { runDir: runDirWith([], { policy: { resumeOnRestart: true } }) });
    addRun(ids[1]!, { runDir: runDirWith([], {}) });
    addRun(ids[2]!, { runDir: '/nowhere' });
    expect(resumeOnRestart(store.runs, manager, ids.slice(0, 3))).toEqual([ids[0]]);
    expect(calls).toEqual([ids[0]]);
  });

  it('leaves runs interrupted by default and stops at the limit', async () => {
    for (const id of ids) {
      addRun(id, { runDir: runDirWith([], { policy: { resumeOnRestart: true } }) });
    }
    expect(resumeOnRestart(store.runs, manager, ids)).toHaveLength(3);
    expect(resumeOnRestart(store.runs, manager, ids, 1)).toHaveLength(1);
    const off = addRun('r20260101-eeeeee', { runDir: runDirWith([], {}) });
    expect(resumeOnRestart(store.runs, manager, [off.id])).toEqual([]);
  });
});

describe('pidAlive', () => {
  it('is true for this process and false for a pid that cannot exist', async () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2 ** 22 + 12345)).toBe(false);
  });
});

describe('reopenStrandedRests', () => {
  it('reopens the question of a resting run whose answer was taken, and only once', async () => {
    addRun('r20260101-cccccc', { stage: 'awaiting_review', ownerPid: null, ownerHost: null });
    const id = store.runs.openDecision({
      runId: 'r20260101-cccccc',
      kind: 'final_review',
      title: 'Ready for your review',
      body: 'b',
      options: [{ id: 'approve', label: 'Approve' }],
    });
    store.runs.answerDecision(id, { choice: 'approve', note: null });
    expect(reopenStrandedRests(store.runs)).toEqual(['r20260101-cccccc']);
    const open = store.runs.listDecisions({ runId: 'r20260101-cccccc', status: 'open' });
    expect(open).toHaveLength(1);
    expect(open[0]!.body).toContain('the server stopped before carrying out your answer');
    // Already open now: nothing more to do.
    expect(reopenStrandedRests(store.runs)).toEqual([]);
  });

  it('leaves active runs alone', async () => {
    addRun('r20260101-dddddd');
    expect(reopenStrandedRests(store.runs)).toEqual([]);
  });

  it('leaves a resting run whose owner is alive on this host alone', async () => {
    const run = addRun('r20260101-ffffff', {
      stage: 'awaiting_review',
      ownerPid: LIVE,
      ownerHost: HOST,
    });
    const id = store.runs.openDecision({
      runId: run.id,
      kind: 'final_review',
      title: 'Ready for your review',
      body: 'b',
      options: [{ id: 'approve', label: 'Approve' }],
    });
    store.runs.answerDecision(id, { choice: 'approve', note: null });
    const opts = { hostname: HOST, isAlive: (pid: number) => pid === LIVE };
    expect(reopenStrandedRests(store.runs, opts)).toEqual([]);
    // Once that owner is gone, the run is stranded and gets its question back.
    expect(reopenStrandedRests(store.runs, { ...opts, isAlive: () => false })).toEqual([run.id]);
  });
});
