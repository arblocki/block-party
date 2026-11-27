import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveRunConfig } from './config.js';
import { loadContext } from './context.js';
import { openStore } from '../store/index.js';
import { RunLog } from './events.js';
import { RunRecorder } from './recorder.js';
import type { RunStage } from './machine.js';
import type { PipelineDeps } from './pipeline.js';
import { saveRunState, type RunState } from './run-state.js';

const PLAN = `# Add widgets

## Goal
Widgets.

## Approach
Do it.

## Acceptance criteria
- [ ] Widgets render

## Out of scope
Gadgets.
`;

const finding = (id: string) => ({
  id,
  reviewedSha: 'x'.repeat(7),
  severity: 'P1',
  category: 'correctness',
  title: `Finding ${id}`,
  body: 'Broken',
  location: { path: 'a.ts', startLine: 1, endLine: 2 },
  confidence: 'high',
  suggestedFix: null,
});

const report = (summary: string, resolutions: unknown[] = []) => ({
  status: 'done',
  summary,
  acceptance: [{ criterion: 'Widgets render', status: 'met', evidence: 'test' }],
  questions: [],
  findingResolutions: resolutions,
});

function write(path: string, value: unknown) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
}

function setup(stage: RunStage) {
  const root = mkdtempSync(join(tmpdir(), 'bp-context-'));
  const runDir = join(root, 'runs', 'r1');
  const planPath = join(runDir, 'plans', 'v1.md');
  write(planPath, PLAN);
  write(join(runDir, 'inputs', 'config.json'), resolveRunConfig({ publish: false }));
  write(join(runDir, 'reviews', 'round-1', 'findings.json'), {
    reviewedSha: 'a'.repeat(7),
    summary: 'First',
    findings: [finding('f_1_1'), finding('f_1_2')],
  });
  write(join(runDir, 'reviews', 'round-2', 'findings.json'), {
    reviewedSha: 'b'.repeat(7),
    summary: 'Second',
    findings: [finding('f_2_1')],
  });
  // Review round 1 started the first (and only) review-fix.
  write(join(runDir, 'inputs', 'findings-round-1.json'), [finding('f_1_1'), finding('f_1_2')]);
  write(join(runDir, 'reports', 'implement-1.json'), report('Built it'));
  write(
    join(runDir, 'reports', 'review-fix-1.json'),
    report('Fixed one', [
      { findingId: 'f_1_1', resolution: 'fixed', note: 'guarded' },
      { findingId: 'f_1_2', resolution: 'disputed', note: 'intended' },
    ]),
  );
  const st: RunState = {
    id: 'r1',
    title: 'Add widgets',
    repoPath: '/repo',
    owner: 'o',
    repo: 'r',
    baseRef: 'main',
    baseSha: 'b'.repeat(40),
    branch: 'bp/add-widgets-r1',
    worktreePath: '/wt/r1',
    headSha: 'c'.repeat(40),
    planPath,
    planHash: 'h',
    planVersion: 1,
    stage,
    stageNote: null,
    implementer: { mode: 'pane', sessionId: 's-9', paneLabel: 'pane-1' },
    planner: null,
    sessionEnded: true,
    rounds: { checkFix: 1, reviewFix: 1, ciFix: 0, feedback: 0, checkRuns: 0 },
    prNumber: 7,
    createdAt: '2026-11-22T10:00:00.000Z',
    updatedAt: '2026-11-22T10:00:00.000Z',
  };
  const deps = {
    paths: { runDir: () => runDir },
    loadProjectChecks: () => ({
      config: { required: [{ name: 'test', run: 'pnpm test' }] },
    }),
    createLog: (dir: string) => new RunLog(dir),
  } as unknown as PipelineDeps;
  return { runDir, st, deps };
}

describe('loadContext', () => {
  it('takes statuses from stored rows for rounds that have them, files for the rest', async () => {
    const { runDir, st, deps } = setup('awaiting_review');
    await saveRunState(runDir, st);
    const store = openStore(':memory:').runs;
    new RunRecorder(new RunLog(runDir), store).state(st);
    // Round 2 has rows (its finding was set aside); round 1 has none: the report files apply.
    store.insertFindings('r1', 2, [finding('f_2_1') as never], () => 'auto_fix');
    store.setFindingStatus('r1', 'r2:f_2_1', 'wont_fix', 'not worth it');
    const ctx = await loadContext('r1', { ...deps, store } as PipelineDeps);
    expect(ctx.rounds[0]!.resolutions.f_1_1).toEqual({ resolution: 'fixed', note: 'guarded' });
    expect(ctx.rounds[1]!.resolutions).toEqual({
      f_2_1: { resolution: 'wont_fix', note: 'not worth it' },
    });
  });

  it('rebuilds rounds, resolutions, reports, config and session from the run directory', async () => {
    const { runDir, st, deps } = setup('awaiting_review');
    await saveRunState(runDir, st);
    const ctx = await loadContext('r1', deps);
    expect(ctx.st.stage).toBe('awaiting_review');
    expect(ctx.plan.title).toBe('Add widgets');
    expect(ctx.input.config.publish).toBe(false);
    expect(ctx.checks.required).toHaveLength(1);
    expect(ctx.rounds.map((r) => [r.round, r.reviewedSha, r.summary])).toEqual([
      [1, 'a'.repeat(7), 'First'],
      [2, 'b'.repeat(7), 'Second'],
    ]);
    expect(ctx.rounds[0]!.resolutions).toEqual({
      f_1_1: { resolution: 'fixed', note: 'guarded' },
      f_1_2: { resolution: 'disputed', note: 'intended' },
    });
    expect(ctx.rounds[1]!.resolutions).toEqual({});
    expect(ctx.reports.map((r) => [r.kind, r.round])).toEqual([
      ['implement', 1],
      ['review-fix', 1],
    ]);
    expect(ctx.lastReport?.summary).toBe('Fixed one');
    expect(ctx.session).toEqual({
      mode: 'pane',
      sessionId: 's-9',
      cwd: '/wt/r1',
      paneLabel: 'pane-1',
    });
    expect(ctx.fixBase).toEqual({ checkFix: 1, reviewFix: 1, ciFix: 0 });
  });

  it('refuses a run that is not resting', async () => {
    const { runDir, st, deps } = setup('complete');
    await saveRunState(runDir, st);
    await expect(loadContext('r1', deps)).rejects.toThrow(/not resting \(stage: complete\)/);
  });

  it('refuses a run with no saved config', async () => {
    const { runDir, st, deps } = setup('awaiting_review');
    write(join(runDir, 'inputs', 'config.json'), 'not json');
    await saveRunState(runDir, st);
    await expect(loadContext('r1', deps)).rejects.toThrow(/no saved config/);
  });
});
