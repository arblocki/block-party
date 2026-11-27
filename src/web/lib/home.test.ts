import { describe, expect, it } from 'vitest';
import { RUN_STAGES } from '../../core/run/machine';
import type { DecisionKind } from '../../core/store/runs';
import type { RunSummary } from '../types';
import { decisionLabel, orderRuns, runProject, stageTone, type StageTone } from './home';

const run = (id: string, stage: RunSummary['stage'], updatedAt: string): RunSummary => ({
  id,
  title: id,
  stage,
  stageNote: null,
  owner: 'o',
  repo: 'r',
  branch: 'b',
  prNumber: null,
  createdAt: updatedAt,
  updatedAt,
  openDecisions: 0,
  planVersion: null,
});

describe('stageTone', () => {
  const expected: Record<(typeof RUN_STAGES)[number], StageTone> = {
    setup: 'active',
    implementing: 'active',
    checking: 'active',
    reviewing: 'active',
    fixing: 'active',
    publishing: 'active',
    waiting_ci: 'active',
    planning: 'active',
    awaiting_decision: 'active',
    awaiting_plan_approval: 'waiting',
    awaiting_review: 'waiting',
    complete: 'done',
    blocked: 'attention',
    failed: 'attention',
    cancelled: 'stopped',
    interrupted: 'stopped',
  };
  it.each(RUN_STAGES)('maps %s', (stage) => {
    expect(stageTone(stage)).toBe(expected[stage]);
  });

  it('pins the terminal tones', () => {
    expect(stageTone('cancelled')).toBe('stopped');
    expect(stageTone('interrupted')).toBe('stopped');
    expect(stageTone('failed')).toBe('attention');
  });
});

describe('orderRuns', () => {
  it('puts active runs first, newest first within each group', () => {
    const out = orderRuns([
      run('done-new', 'complete', '2026-01-05T00:00:00Z'),
      run('act-old', 'implementing', '2026-01-01T00:00:00Z'),
      run('done-old', 'failed', '2026-01-02T00:00:00Z'),
      run('act-new', 'waiting_ci', '2026-01-04T00:00:00Z'),
    ]);
    expect(out.map((r) => r.id)).toEqual(['act-new', 'act-old', 'done-new', 'done-old']);
  });

  it('puts resting runs right after active ones', () => {
    const out = orderRuns([
      run('done', 'complete', '2026-01-09T00:00:00Z'),
      run('rest-old', 'awaiting_review', '2026-01-02T00:00:00Z'),
      run('act', 'awaiting_decision', '2026-01-01T00:00:00Z'),
      run('rest-new', 'awaiting_plan_approval', '2026-01-03T00:00:00Z'),
    ]);
    expect(out.map((r) => r.id)).toEqual(['act', 'rest-new', 'rest-old', 'done']);
  });

  it('caps the non-active runs but never the active ones', () => {
    const runs = [
      ...Array.from({ length: 30 }, (_, i) =>
        run(`d${i}`, 'complete', `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`),
      ),
      ...Array.from({ length: 25 }, (_, i) => run(`a${i}`, 'setup', '2026-02-01T00:00:00Z')),
    ];
    const out = orderRuns(runs);
    expect(out.filter((r) => r.stage === 'setup')).toHaveLength(25);
    const done = out.filter((r) => r.stage === 'complete');
    expect(done).toHaveLength(20);
    expect(done[0]?.id).toBe('d29');
  });

  it('does not mutate its input', () => {
    const runs = [
      run('a', 'complete', '2026-01-01T00:00:00Z'),
      run('b', 'setup', '2026-01-01T00:00:00Z'),
    ];
    orderRuns(runs);
    expect(runs.map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('decisionLabel', () => {
  it.each<[DecisionKind, string]>([
    ['blocked', 'Blocked'],
    ['permission', 'Permission'],
    ['interrupted', 'Interrupted'],
    ['cap_reached', 'Cap reached'],
    ['failed', 'Failed'],
    ['plan_approval', 'Plan approval'],
    ['finding_triage', 'Finding triage'],
    ['dispute', 'Dispute'],
    ['broad_fix', 'Broad fix'],
    ['final_review', 'Final review'],
    ['ci_gap', 'CI gap'],
  ])('%s -> %s', (kind, label) => {
    expect(decisionLabel(kind)).toBe(label);
  });
});

describe('runProject', () => {
  it('returns owner and repo, or null when either is missing', () => {
    const r = run('a', 'setup', '2026-01-01');
    expect(runProject(r)).toEqual({ owner: 'o', repo: 'r' });
    expect(runProject({ ...r, owner: null })).toBeNull();
    expect(runProject({ ...r, repo: null })).toBeNull();
    expect(runProject({ ...r, repo: '' })).toBeNull();
  });
});
