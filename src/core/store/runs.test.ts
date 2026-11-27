import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openStore, type Store } from './index.js';
import type { RunInput, RunStore } from './runs.js';
import { MIGRATIONS } from './schema.js';

function runInput(projectId: string, over: Partial<RunInput> = {}): RunInput {
  return {
    id: 'r1',
    projectId,
    title: 'Add a thing',
    stage: 'setup',
    stageNote: null,
    branch: 'bp/add-a-thing-1',
    worktreePath: '/wt/r1',
    runDir: '/runs/r1',
    baseRef: 'main',
    baseSha: 'base0',
    headSha: null,
    prNumber: null,
    planPath: '/runs/r1/plans/v1.md',
    planHash: 'hash1',
    implementer: null,
    rounds: { checkFix: 0, reviewFix: 0, ciFix: 0, feedback: 0, checkRuns: 0 },
    ownerPid: null,
    ownerHost: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('run store', () => {
  let store: Store;
  let runs: RunStore;
  let projectId: string;

  beforeEach(() => {
    store = openStore(':memory:');
    runs = store.runs;
    projectId = runs.upsertProject({
      owner: 'o',
      repo: 'r',
      localPath: '/src/r',
      defaultBase: 'main',
    }).id;
  });
  afterEach(() => store.close());

  describe('projects', () => {
    it('upserts by local path, keeping the id and updating the other fields', () => {
      const first = runs.getProject(projectId);
      expect(first).toMatchObject({
        owner: 'o',
        repo: 'r',
        localPath: '/src/r',
        defaultBase: 'main',
      });

      const again = runs.upsertProject({
        owner: 'O2',
        repo: 'r2',
        localPath: '/src/r',
        defaultBase: 'develop',
      });
      expect(again.id).toBe(projectId);
      expect(again).toMatchObject({ owner: 'O2', repo: 'r2', defaultBase: 'develop' });
      expect(again.createdAt).toBe(first?.createdAt);
      expect(runs.getProject(projectId)).toEqual(again);

      const other = runs.upsertProject({
        owner: 'o',
        repo: 'r',
        localPath: '/src/other',
        defaultBase: 'main',
      });
      expect(other.id).not.toBe(projectId);
      expect(runs.listProjects().map((p) => p.id)).toEqual([again.id, other.id]);
      expect(runs.getProject('missing')).toBeUndefined();
    });
  });

  describe('runs', () => {
    it('round-trips every column through create, get and update', () => {
      const input = runInput(projectId, {
        stageNote: 'starting',
        headSha: 'head0',
        prNumber: 12,
        implementer: { mode: 'pane', sessionId: 's1', paneLabel: 'impl' },
        rounds: { checkFix: 1, reviewFix: 2, ciFix: 0, feedback: 0, checkRuns: 0 },
        ownerPid: 4242,
        ownerHost: 'host-a',
      });
      const created = runs.createRun(input);
      expect(created).toEqual(input);
      expect(runs.getRun('r1')).toEqual(input);

      const patch = {
        title: 'Renamed',
        stage: 'reviewing' as const,
        stageNote: null,
        branch: 'bp/b',
        worktreePath: '/wt/b',
        runDir: '/runs/b',
        baseRef: 'develop',
        baseSha: 'base1',
        headSha: 'head1',
        prNumber: 99,
        planPath: '/p2.md',
        planHash: 'hash2',
        implementer: { mode: 'headless' as const, sessionId: 's2', paneLabel: null },
        rounds: { checkFix: 3, reviewFix: 4, ciFix: 0, feedback: 0, checkRuns: 0 },
        ownerPid: null,
        ownerHost: null,
      };
      const updated = runs.updateRun('r1', patch);
      expect(updated).toMatchObject({ ...patch, id: 'r1', projectId, createdAt: input.createdAt });
      expect((updated?.updatedAt ?? '') > (input.updatedAt ?? '')).toBe(true);
      expect(runs.getRun('r1')).toEqual(updated);
    });

    it('finds the newest run for a PR of a project, ignoring case and other PRs', () => {
      const other = runs.upsertProject({
        owner: 'o',
        repo: 'other',
        localPath: '/src/other',
        defaultBase: 'main',
      }).id;
      runs.createRun(
        runInput(projectId, { id: 'a', prNumber: 7, createdAt: '2026-01-01T00:00:00.000Z' }),
      );
      runs.createRun(
        runInput(projectId, { id: 'b', prNumber: 7, createdAt: '2026-01-02T00:00:00.000Z' }),
      );
      runs.createRun(runInput(projectId, { id: 'c', prNumber: 8 }));
      runs.createRun(runInput(other, { id: 'd', prNumber: 7 }));
      runs.createRun(runInput(projectId, { id: 'e', prNumber: null }));
      expect(runs.findRunByPr('o', 'r', 7)?.id).toBe('b');
      expect(runs.findRunByPr('O', 'R', 8)?.id).toBe('c');
      expect(runs.findRunByPr('o', 'other', 7)?.id).toBe('d');
      expect(runs.findRunByPr('o', 'r', 9)).toBeUndefined();
      expect(runs.findRunByPr('x', 'r', 7)).toBeUndefined();
    });

    it('advances updatedAt on every update, even within one millisecond', () => {
      vi.useFakeTimers({ now: new Date('2026-05-01T00:00:00.000Z'), toFake: ['Date'] });
      try {
        runs.createRun(runInput(projectId, { updatedAt: '2026-05-01T00:00:00.000Z' }));
        const a = runs.updateRun('r1', { stage: 'implementing' })!.updatedAt;
        const b = runs.updateRun('r1', { stage: 'checking' })!.updatedAt;
        expect(a > '2026-05-01T00:00:00.000Z').toBe(true);
        expect(b > a).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('updates only the given columns and bumps updatedAt', () => {
      runs.createRun(runInput(projectId, { headSha: 'h', stageNote: 'note' }));
      const updated = runs.updateRun('r1', { stage: 'implementing' });
      expect(updated).toMatchObject({
        stage: 'implementing',
        headSha: 'h',
        stageNote: 'note',
        title: 'Add a thing',
      });
      expect((updated?.updatedAt ?? '') > '2026-01-01T00:00:00.000Z').toBe(true);

      const cleared = runs.updateRun('r1', { headSha: null });
      expect(cleared?.headSha).toBeNull();
      expect(cleared?.stage).toBe('implementing');

      expect(runs.updateRun('missing', { stage: 'failed' })).toBeUndefined();
      expect(runs.getRun('missing')).toBeUndefined();
    });

    it('lists newest first, optionally only active runs, with a limit', () => {
      runs.createRun(
        runInput(projectId, { id: 'a', stage: 'implementing', updatedAt: '2026-01-01T00:00:01Z' }),
      );
      runs.createRun(
        runInput(projectId, { id: 'b', stage: 'complete', updatedAt: '2026-01-01T00:00:03Z' }),
      );
      runs.createRun(
        runInput(projectId, { id: 'c', stage: 'waiting_ci', updatedAt: '2026-01-01T00:00:02Z' }),
      );
      runs.createRun(
        runInput(projectId, { id: 'd', stage: 'failed', updatedAt: '2026-01-01T00:00:04Z' }),
      );

      expect(runs.listRuns().map((r) => r.id)).toEqual(['d', 'b', 'c', 'a']);
      expect(runs.listRuns({ active: true }).map((r) => r.id)).toEqual(['c', 'a']);
      expect(runs.listRuns({ limit: 2 }).map((r) => r.id)).toEqual(['d', 'b']);
      expect(runs.listRuns({ active: true, limit: 1 }).map((r) => r.id)).toEqual(['c']);

      // Updating moves a run to the front.
      runs.updateRun('a', { stageNote: 'progress' });
      expect(runs.listRuns({ active: true }).map((r) => r.id)).toEqual(['a', 'c']);
    });

    it('lists resting runs apart from active ones', () => {
      for (const [id, stage] of [
        ['a', 'awaiting_decision'],
        ['b', 'awaiting_plan_approval'],
        ['c', 'awaiting_review'],
        ['d', 'planning'],
        ['e', 'complete'],
      ] as const) {
        runs.createRun(runInput(projectId, { id, stage }));
      }
      expect(
        runs
          .listRuns({ active: true })
          .map((r) => r.id)
          .sort(),
      ).toEqual(['a', 'd']);
      expect(
        runs
          .listRuns({ resting: true })
          .map((r) => r.id)
          .sort(),
      ).toEqual(['b', 'c']);
    });

    it('rejects a run for an unknown project', () => {
      expect(() => runs.createRun(runInput('nope'))).toThrow();
    });
  });

  describe('stages', () => {
    it('starts, ends and lists stage executions', () => {
      runs.createRun(runInput(projectId));
      const s1 = runs.startStage({
        runId: 'r1',
        kind: 'implement',
        round: 0,
        input: { brief: 'b' },
      });
      const s2 = runs.startStage({ runId: 'r1', kind: 'checks', round: 0 });
      expect(s2).toBeGreaterThan(s1);

      expect(runs.endStage(s1, { state: 'succeeded', output: { commits: 2 } })).toBe(true);
      expect(runs.endStage(s1, { state: 'failed' })).toBe(false);
      expect(runs.endStage(12345, { state: 'failed' })).toBe(false);

      const [a, b] = runs.listStages('r1');
      expect(a).toMatchObject({
        id: s1,
        runId: 'r1',
        kind: 'implement',
        round: 0,
        state: 'succeeded',
        input: { brief: 'b' },
        output: { commits: 2 },
      });
      expect(a?.endedAt).toEqual(expect.any(String));
      expect(b).toMatchObject({
        id: s2,
        state: 'running',
        input: null,
        output: null,
        endedAt: null,
      });
      expect(runs.listStages('other')).toEqual([]);
    });
  });

  describe('events', () => {
    it('appends with increasing ids and lists per run after an id', () => {
      expect(runs.latestEventId()).toBe(0);
      runs.createRun(runInput(projectId, { id: 'a' }));
      runs.createRun(runInput(projectId, { id: 'b' }));
      const stageId = runs.startStage({ runId: 'a', kind: 'implement', round: 0 });

      const e1 = runs.appendEvent({ runId: 'a', ts: 't1', type: 'stage', payload: { to: 'x' } });
      const e2 = runs.appendEvent({ runId: 'b', ts: 't2', type: 'note' });
      const e3 = runs.appendEvent({ runId: 'a', stageId, ts: 't3', type: 'tool', payload: [1] });
      const e4 = runs.appendEvent({ runId: 'a', ts: 't4', type: 'stage' });
      expect(e2).toBeGreaterThan(e1);
      expect(e3).toBeGreaterThan(e2);
      expect(e4).toBeGreaterThan(e3);
      expect(runs.latestEventId()).toBe(e4);

      expect(runs.listEvents('a')).toEqual([
        { id: e1, runId: 'a', stageId: null, ts: 't1', type: 'stage', payload: { to: 'x' } },
        { id: e3, runId: 'a', stageId, ts: 't3', type: 'tool', payload: [1] },
        { id: e4, runId: 'a', stageId: null, ts: 't4', type: 'stage', payload: null },
      ]);
      expect(runs.listEvents('a', { afterId: e1 }).map((e) => e.id)).toEqual([e3, e4]);
      expect(runs.listEvents('a', { afterId: e2, limit: 1 }).map((e) => e.id)).toEqual([e3]);
      expect(runs.listEvents('a', { afterId: e4 })).toEqual([]);
      expect(runs.listEvents('b').map((e) => e.id)).toEqual([e2]);
    });
  });

  describe('decisions', () => {
    const options = [
      { id: 'yes', label: 'Yes' },
      { id: 'no', label: 'No' },
    ];

    it('stores options and answers an open decision once', () => {
      runs.createRun(runInput(projectId, { id: 'a' }));
      const id = runs.openDecision({
        runId: 'a',
        kind: 'plan_approval',
        title: 'Approve?',
        body: 'b',
        options,
      });
      expect(runs.getDecision(id)).toMatchObject({ options, answer: null, answeredAt: null });

      expect(runs.answerDecision(id, { choice: 'maybe', note: null })).toBe('bad_choice');
      expect(runs.getDecision(id)?.status).toBe('open');

      expect(runs.answerDecision(id, { choice: 'yes', note: 'go' })).toBe('answered');
      expect(runs.getDecision(id)).toMatchObject({
        status: 'answered',
        answer: { choice: 'yes', note: 'go' },
        answeredAt: expect.any(String),
      });
      expect(runs.answerDecision(id, { choice: 'no', note: null })).toBe('not_open');
      expect(runs.getDecision(id)?.answer?.choice).toBe('yes');
      expect(runs.openDecisionCount()).toBe(0);

      // An answered decision can still be resolved, but not dismissed.
      expect(runs.dismissDecision(id)).toBe(false);
      expect(runs.resolveDecision(id)).toBe(true);
      expect(runs.getDecision(id)?.status).toBe('resolved');
    });

    it('closeOpenQuestions dismisses only open optioned decisions of that run', () => {
      runs.createRun(runInput(projectId, { id: 'a' }));
      runs.createRun(runInput(projectId, { id: 'b' }));
      const q = runs.openDecision({ runId: 'a', kind: 'dispute', title: 'Q', body: 'b', options });
      const answered = runs.openDecision({
        runId: 'a',
        kind: 'dispute',
        title: 'A',
        body: 'b',
        options,
      });
      runs.answerDecision(answered, { choice: 'yes', note: null });
      const plain = runs.openDecision({ runId: 'a', kind: 'blocked', title: 'P', body: 'b' });
      const other = runs.openDecision({
        runId: 'b',
        kind: 'dispute',
        title: 'O',
        body: 'b',
        options,
      });
      expect(runs.closeOpenQuestions('a')).toBe(1);
      expect(runs.getDecision(q)).toMatchObject({
        status: 'dismissed',
        resolvedAt: expect.any(String),
      });
      expect(runs.getDecision(answered)?.status).toBe('answered');
      expect(runs.getDecision(plain)?.status).toBe('open');
      expect(runs.getDecision(other)?.status).toBe('open');
      expect(runs.closeOpenQuestions('a')).toBe(0);
    });

    it('answerDecision returns run_ended when the run is terminal', () => {
      runs.createRun(runInput(projectId, { id: 'a', stage: 'awaiting_decision' }));
      const id = runs.openDecision({ runId: 'a', kind: 'dispute', title: 'Q', body: 'b', options });
      runs.updateRun('a', { stage: 'failed' });
      expect(runs.answerDecision(id, { choice: 'yes', note: null })).toBe('run_ended');
      expect(runs.getDecision(id)?.status).toBe('open');
    });

    it('does not answer unknown, dismissed or option-less decisions', () => {
      runs.createRun(runInput(projectId, { id: 'a' }));
      const plain = runs.openDecision({ runId: 'a', kind: 'blocked', title: 'Q', body: 'b' });
      expect(runs.getDecision(plain)?.options).toBeNull();
      expect(runs.answerDecision(plain, { choice: 'x', note: null })).toBe('bad_choice');
      const d = runs.openDecision({ runId: 'a', kind: 'dispute', title: 'Q', body: 'b', options });
      runs.dismissDecision(d);
      expect(runs.answerDecision(d, { choice: 'yes', note: null })).toBe('not_open');
      expect(runs.answerDecision(999, { choice: 'yes', note: null })).toBe('not_open');
      expect(runs.getDecision(999)).toBeUndefined();
    });

    it('resolves and dismisses only open decisions', () => {
      runs.createRun(runInput(projectId, { id: 'a' }));
      runs.createRun(runInput(projectId, { id: 'b' }));
      const d1 = runs.openDecision({ runId: 'a', kind: 'blocked', title: 'Q', body: 'Which?' });
      const d2 = runs.openDecision({
        runId: 'a',
        kind: 'permission',
        title: 'Allow',
        body: 'rm',
        attach: 'pane-1',
      });
      const d3 = runs.openDecision({ runId: 'b', kind: 'failed', title: 'F', body: 'x' });
      expect(runs.openDecisionCount()).toBe(3);

      expect(runs.resolveDecision(d1)).toBe(true);
      expect(runs.resolveDecision(d1)).toBe(false);
      expect(runs.dismissDecision(d1)).toBe(false);
      expect(runs.dismissDecision(d2)).toBe(true);
      expect(runs.resolveDecision(d2)).toBe(false);
      expect(runs.resolveDecision(999)).toBe(false);

      const open = runs.listDecisions({ status: 'open' });
      expect(open.map((d) => d.id)).toEqual([d3]);
      expect(runs.openDecisionCount()).toBe(open.length);

      const all = runs.listDecisions();
      expect(all.map((d) => d.id)).toEqual([d3, d2, d1]);
      expect(all.find((d) => d.id === d1)).toMatchObject({ status: 'resolved', attach: null });
      expect(all.find((d) => d.id === d2)).toMatchObject({
        status: 'dismissed',
        kind: 'permission',
        attach: 'pane-1',
      });
      expect(all.find((d) => d.id === d1)?.resolvedAt).toEqual(expect.any(String));
      expect(all.find((d) => d.id === d3)?.resolvedAt).toBeNull();

      expect(runs.listDecisions({ runId: 'a' }).map((d) => d.id)).toEqual([d2, d1]);
      expect(runs.listDecisions({ runId: 'a', status: 'open' })).toEqual([]);
    });
  });

  describe('findings', () => {
    const f = (id: string, over: Record<string, unknown> = {}) => ({
      id,
      reviewedSha: 'abcdef1',
      severity: 'P1' as const,
      category: 'correctness',
      title: `t ${id}`,
      body: 'b',
      location: { path: 'a.ts', startLine: 1, endLine: 2 },
      confidence: 'high' as const,
      suggestedFix: null,
      ...over,
    });
    beforeEach(() => {
      runs.createRun(runInput(projectId));
    });

    it('stores rows with run-unique keys, triage and repeatOf, ordered by round', () => {
      runs.insertFindings('r1', 2, [f('f_2_1', { repeatOf: 'r1:f_1_1' })], () => 'record');
      runs.insertFindings('r1', 1, [f('f_1_1'), f('f_1_10', { location: null })], () => 'auto_fix');
      const rows = runs.listFindings('r1');
      expect(rows.map((r) => r.key)).toEqual(['r1:f_1_1', 'r1:f_1_10', 'r2:f_2_1']);
      expect(rows[0]).toMatchObject({ triage: 'auto_fix', status: 'open', repeatOf: null });
      expect(rows[1]!.location).toBeNull();
      expect(rows[2]).toMatchObject({ triage: 'record', repeatOf: 'r1:f_1_1' });
    });

    it('skips a repeated id within a round instead of failing the insert', () => {
      runs.insertFindings('r1', 1, [f('f_1_1'), f('f_1_1')], () => 'auto_fix');
      expect(runs.listFindings('r1')).toHaveLength(1);
    });

    it('sets a status and note, and replaces a round that is stored again', () => {
      runs.insertFindings('r1', 1, [f('f_1_1')], () => 'auto_fix');
      expect(runs.setFindingStatus('r1', 'r1:f_1_1', 'disputed', 'no')).toBe(true);
      expect(runs.setFindingStatus('r1', 'r1:nope', 'fixed', null)).toBe(false);
      expect(runs.listFindings('r1')[0]).toMatchObject({
        status: 'disputed',
        resolutionNote: 'no',
      });
      runs.insertFindings('r1', 1, [f('f_1_1')], () => 'auto_fix');
      expect(runs.listFindings('r1')).toHaveLength(1);
      expect(runs.listFindings('r1')[0]!.status).toBe('open');
    });
  });

  describe('plans', () => {
    const plan = (version: number, over: Record<string, unknown> = {}) => ({
      runId: 'r1',
      version,
      path: `/runs/r1/plans/v${version}.md`,
      contentHash: `hash${version}`,
      title: `Plan ${version}`,
      createdBy: 'agent' as const,
      ...over,
    });
    beforeEach(() => {
      runs.createRun(runInput(projectId));
    });

    it('stores versions as drafts, with feedback, in version order', () => {
      runs.addPlanVersion(plan(2, { feedback: 'smaller please' }));
      runs.addPlanVersion(plan(1));
      const rows = runs.listPlans('r1');
      expect(rows.map((p) => p.version)).toEqual([1, 2]);
      expect(rows[0]).toMatchObject({
        status: 'draft',
        createdBy: 'agent',
        feedback: null,
        title: 'Plan 1',
        contentHash: 'hash1',
      });
      expect(rows[1]!.feedback).toBe('smaller please');
    });

    it('records a pasted plan as approved, created by me', () => {
      const row = runs.addPlanVersion(plan(1, { status: 'approved', createdBy: 'me' }));
      expect(row).toMatchObject({ status: 'approved', createdBy: 'me' });
    });

    it('refuses a second row for the same version', () => {
      runs.addPlanVersion(plan(1));
      expect(() => runs.addPlanVersion(plan(1))).toThrow();
    });

    it('approves one version and supersedes the others', () => {
      runs.addPlanVersion(plan(1));
      runs.addPlanVersion(plan(2));
      expect(runs.approvePlan('r1', 2)).toBe(true);
      expect(runs.listPlans('r1').map((p) => p.status)).toEqual(['superseded', 'approved']);
    });

    it('changes nothing when the version does not exist', () => {
      runs.addPlanVersion(plan(1));
      expect(runs.approvePlan('r1', 5)).toBe(false);
      expect(runs.listPlans('r1')[0]!.status).toBe('draft');
    });

    it('latestPlanVersions gives each run its latest plan version', () => {
      expect(runs.latestPlanVersions().size).toBe(0);
      runs.createRun(
        runInput(projectId, {
          id: 'r2',
          branch: 'bp/add-a-thing-2',
          worktreePath: '/wt/r2',
          runDir: '/runs/r2',
        }),
      );
      runs.createRun(
        runInput(projectId, {
          id: 'r3',
          branch: 'bp/add-a-thing-3',
          worktreePath: '/wt/r3',
          runDir: '/runs/r3',
        }),
      );
      runs.addPlanVersion(plan(2));
      runs.addPlanVersion(plan(1));
      runs.addPlanVersion(plan(3));
      runs.addPlanVersion(plan(1, { runId: 'r2', path: '/runs/r2/plans/v1.md' }));
      const map = runs.latestPlanVersions();
      expect(Object.fromEntries(map)).toEqual({ r1: 3, r2: 1 });
      expect(map.has('r3')).toBe(false);
    });
  });
});

describe('run store on a file', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bp-runs-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('applies the run-tables migration to an older database exactly once', () => {
    const file = join(dir, 'db.sqlite');
    const old = new Database(file);
    for (const m of MIGRATIONS.slice(0, -1)) old.exec(m);
    old.pragma(`user_version = ${MIGRATIONS.length - 1}`);
    old.close();

    const s1 = openStore(file);
    const p = s1.runs.upsertProject({
      owner: 'o',
      repo: 'r',
      localPath: '/x',
      defaultBase: 'main',
    });
    s1.runs.createRun(runInput(p.id));
    s1.close();

    const check = new Database(file);
    expect(check.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    check.close();

    // Re-opening doesn't re-run it (CREATE TABLE would throw) and keeps the data.
    const s2 = openStore(file);
    expect(s2.runs.getRun('r1')?.projectId).toBe(p.id);
    s2.close();
  });

  it('keeps old decision rows when the answerable-decisions migration runs', () => {
    const file = join(dir, 'db.sqlite');
    // The schema before the decisions rebuild: every migration but the last.
    const before = MIGRATIONS.length - 1;
    const old = new Database(file);
    for (const m of MIGRATIONS.slice(0, before)) old.exec(m);
    old.pragma(`user_version = ${before}`);
    old
      .prepare(
        `INSERT INTO projects (id, owner, repo, local_path, default_base, created_at, updated_at)
         VALUES ('p', 'o', 'r', '/x', 'main', 't', 't')`,
      )
      .run();
    const run = runInput('p');
    old
      .prepare(
        `INSERT INTO runs (id, project_id, title, stage, branch, worktree_path, run_dir, base_ref,
           base_sha, plan_path, plan_hash, rounds_json, created_at, updated_at)
         VALUES (?, 'p', 'T', 'implementing', 'b', '/wt', '/rd', 'main', 'sha', '/p', 'h', '{}', 't', 't')`,
      )
      .run(run.id);
    const ins = old.prepare(
      `INSERT INTO decisions (run_id, kind, status, title, body, attach, created_at, resolved_at)
       VALUES (?, ?, ?, ?, 'body', 'pane', '2026-01-01T00:00:00Z', ?)`,
    );
    ins.run(run.id, 'blocked', 'open', 'Q1', null);
    ins.run(run.id, 'failed', 'dismissed', 'Q2', '2026-01-02T00:00:00Z');
    old.close();

    const s = openStore(file);
    try {
      const all = s.runs.listDecisions();
      expect(all.map((d) => [d.title, d.status, d.kind, d.attach, d.resolvedAt])).toEqual([
        ['Q2', 'dismissed', 'failed', 'pane', '2026-01-02T00:00:00Z'],
        ['Q1', 'open', 'blocked', 'pane', null],
      ]);
      for (const d of all)
        expect(d).toMatchObject({ options: null, answer: null, answeredAt: null });
      // The rebuilt table accepts the new status and new rows keep numbering on.
      const id = s.runs.openDecision({
        runId: run.id,
        kind: 'final_review',
        title: 'Q3',
        body: 'b',
        options: [{ id: 'ok', label: 'OK' }],
      });
      expect(id).toBeGreaterThan(Math.max(...all.map((d) => d.id)));
      expect(s.runs.answerDecision(id, { choice: 'ok', note: null })).toBe('answered');
    } finally {
      s.close();
    }
  });

  it("lets two handles on the same file see each other's run writes", () => {
    const file = join(dir, 'db.sqlite');
    const cli = openStore(file);
    const server = openStore(file);
    try {
      const p = cli.runs.upsertProject({
        owner: 'o',
        repo: 'r',
        localPath: '/x',
        defaultBase: 'main',
      });
      cli.runs.createRun(runInput(p.id));
      expect(server.runs.getRun('r1')?.stage).toBe('setup');

      const e = cli.runs.appendEvent({ runId: 'r1', ts: 't', type: 'stage' });
      expect(server.runs.latestEventId()).toBe(e);

      server.runs.openDecision({ runId: 'r1', kind: 'blocked', title: 'Q', body: 'b' });
      expect(cli.runs.openDecisionCount()).toBe(1);

      cli.runs.updateRun('r1', { stage: 'implementing' });
      expect(server.runs.listRuns({ active: true }).map((r) => r.stage)).toEqual(['implementing']);
    } finally {
      cli.close();
      server.close();
    }
  });
});
