import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openStore } from '../store/index.js';
import type { RunStore } from '../store/runs.js';
import { RunLog } from './events.js';
import { RunRecorder } from './recorder.js';
import type { RunState } from './run-state.js';

function runState(over: Partial<RunState> = {}): RunState {
  return {
    id: 'r1',
    title: 'Add widgets',
    repoPath: '/repo',
    owner: 'o',
    repo: 'r',
    baseRef: 'main',
    baseSha: 'b'.repeat(40),
    branch: 'bp/add-widgets-r1',
    worktreePath: '/wt/r1',
    headSha: null,
    planPath: '/runs/r1/plans/v1.md',
    planHash: 'h',
    stage: 'setup',
    stageNote: null,
    implementer: null,
    rounds: { checkFix: 0, reviewFix: 0 },
    prNumber: null,
    createdAt: '2026-11-22T10:00:00.000Z',
    updatedAt: '2026-11-22T10:00:00.000Z',
    ...over,
  };
}

function setup(store?: RunStore) {
  const dir = mkdtempSync(join(tmpdir(), 'bp-recorder-'));
  const log = new RunLog(dir);
  const rec = new RunRecorder(log, store, { pid: 4242, host: 'box' });
  const fileEvents = () =>
    readFileSync(log.path, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { ts: string; type: string; data?: unknown });
  return { dir, log, rec, fileEvents };
}

/** A store whose every method throws. */
function brokenStore(): RunStore {
  return new Proxy({} as RunStore, {
    get: () => () => {
      throw new Error('disk on fire');
    },
  });
}

describe('RunRecorder', () => {
  it('without a store only writes the events file', () => {
    const { rec, fileEvents } = setup();
    rec.state(runState());
    rec.startStage('implement', 1);
    rec.event('hello', { a: 1 });
    rec.endStage('succeeded');
    rec.openDecision('blocked', 't', 'b', null);
    expect(fileEvents().map((e) => e.type)).toEqual(['hello']);
  });

  it('creates the project and run row, then updates it', () => {
    const store = openStore(':memory:').runs;
    const { dir, rec } = setup(store);
    rec.state(runState());
    const [project] = store.listProjects();
    expect(project).toMatchObject({
      owner: 'o',
      repo: 'r',
      localPath: '/repo',
      defaultBase: 'main',
    });
    expect(store.getRun('r1')).toMatchObject({
      projectId: project!.id,
      stage: 'setup',
      runDir: dir,
      ownerPid: 4242,
      ownerHost: 'box',
      createdAt: '2026-11-22T10:00:00.000Z',
    });
    rec.state(runState({ stage: 'implementing', headSha: 'c'.repeat(40), prNumber: 3 }));
    expect(store.getRun('r1')).toMatchObject({
      stage: 'implementing',
      headSha: 'c'.repeat(40),
      prNumber: 3,
    });
    expect(store.listRuns()).toHaveLength(1);
  });

  it('defaults the owner to this process', () => {
    const store = openStore(':memory:').runs;
    const dir = mkdtempSync(join(tmpdir(), 'bp-recorder-'));
    new RunRecorder(new RunLog(dir), store).state(runState());
    expect(store.getRun('r1')?.ownerPid).toBe(process.pid);
    expect(store.getRun('r1')?.ownerHost).toBeTruthy();
  });

  it('mirrors events with the file ts and the open stage id', () => {
    const store = openStore(':memory:').runs;
    const { rec, fileEvents } = setup(store);
    rec.state(runState());
    rec.event('before', { x: 1 });
    rec.startStage('checks', 2, { headSha: 'abc' });
    rec.event('during');
    rec.endStage('failed', { passed: false });
    rec.event('after');

    const [stage] = store.listStages('r1');
    expect(stage).toMatchObject({
      kind: 'checks',
      round: 2,
      state: 'failed',
      input: { headSha: 'abc' },
      output: { passed: false },
    });
    const rows = store.listEvents('r1');
    expect(rows.map((e) => [e.ts, e.type, e.payload])).toEqual(
      fileEvents().map((e) => [e.ts, e.type, e.data ?? null]),
    );
    expect(rows.map((e) => e.stageId)).toEqual([null, stage!.id, null]);
  });

  it('skips writes that need the run row until it exists', () => {
    const store = openStore(':memory:').runs;
    const { rec, fileEvents } = setup(store);
    rec.event('early');
    expect(store.latestEventId()).toBe(0);
    expect(fileEvents().map((e) => e.type)).toEqual(['early']);
  });

  it('opens decisions and resolves permission waits', () => {
    const store = openStore(':memory:').runs;
    const { rec } = setup(store);
    rec.state(runState());
    // Claude reports each prompt twice (agent state, then Notification hook), and a turn may
    // prompt again: one open item per run is enough until the turn moves on.
    rec.permissionWait('rm -rf?', 'attach-cmd');
    rec.permissionWait('Claude needs your permission', 'attach-cmd');
    rec.permissionWait('curl?', null);
    expect(store.listDecisions({ status: 'open' })).toHaveLength(1);
    const [p] = store.listDecisions({ status: 'open' });
    expect(p).toMatchObject({
      kind: 'permission',
      title: 'Implementer needs approval',
      body: 'rm -rf?',
    });
    rec.resolvePermissions();
    expect(store.openDecisionCount()).toBe(0);
    rec.permissionWait('again?', null);
    expect(store.openDecisionCount()).toBe(1);
    rec.resolvePermissions();
    rec.openDecision('blocked', 'Run blocked', 'note', 'attach-cmd');
    expect(store.listDecisions({ status: 'open' })).toEqual([
      expect.objectContaining({ kind: 'blocked', body: 'note', attach: 'attach-cmd' }),
    ]);
  });

  it('logs db.error to the file only and never throws when the store fails', () => {
    const { rec, fileEvents } = setup(brokenStore());
    expect(() => {
      rec.state(runState());
      rec.event('hello');
      rec.startStage('implement', 1);
      rec.endStage('succeeded');
      rec.permissionWait('m', null);
      rec.resolvePermissions();
      rec.openDecision('failed', 't', 'b', null);
    }).not.toThrow();
    const events = fileEvents();
    expect(events.map((e) => e.type)).toEqual(['db.error', 'hello']);
    expect(events[0]!.data).toEqual({ op: 'createRun', error: 'disk on fire' });
  });

  it('retries creating the run row after a failed attempt', () => {
    const real = openStore(':memory:').runs;
    let fail = true;
    const flaky = new Proxy(real, {
      get(target, key: keyof RunStore) {
        if (key === 'createRun' && fail) {
          return () => {
            throw new Error('busy');
          };
        }
        return target[key];
      },
    });
    const { rec, fileEvents } = setup(flaky);
    rec.state(runState());
    fail = false;
    rec.state(runState({ stage: 'implementing' }));
    rec.event('hi');
    expect(real.getRun('r1')?.stage).toBe('implementing');
    expect(real.listEvents('r1').map((e) => e.type)).toEqual(['hi']);
    expect(fileEvents()[0]!.type).toBe('db.error');
  });
});
