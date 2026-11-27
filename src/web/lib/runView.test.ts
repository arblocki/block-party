import { describe, expect, it } from 'vitest';
import type { RunStage } from '../../core/run/machine';
import type { StageKind, StageRow, StageState } from '../types';
import { checksBySha, isNoisyEvent, stageStrip, summarizeEvent } from './runView';

let nextId = 1;
function stage(kind: StageKind, state: StageState, over: Partial<StageRow> = {}): StageRow {
  return {
    id: nextId++,
    runId: 'r20260101-aaaaaa',
    kind,
    round: 1,
    state,
    input: null,
    output: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: state === 'running' ? null : '2026-01-01T00:01:00.000Z',
    ...over,
  };
}

const run = (stage: RunStage) => ({ stage });
const states = (items: ReturnType<typeof stageStrip>) =>
  Object.fromEntries(items.map((i) => [i.key, i.state]));

describe('stageStrip plan step', () => {
  const plan = (stage: RunStage, stages: never[] = []) => stageStrip(stages, run(stage))[0]!;
  it('is first and follows the plan through writing, ready and approved', () => {
    expect(plan('planning')).toMatchObject({ key: 'plan', state: 'running', text: 'writing' });
    expect(plan('awaiting_plan_approval')).toMatchObject({
      state: 'waiting',
      text: 'ready for you',
    });
    expect(plan('implementing')).toMatchObject({ state: 'done', text: 'approved' });
  });
  it('is stopped when the run ended before any work', () => {
    expect(plan('cancelled')).toMatchObject({ state: 'stopped' });
  });
});

describe('stageStrip', () => {
  it('shows a completed run with every step done', () => {
    const stages = [
      stage('implement', 'succeeded'),
      stage('checks', 'failed'),
      stage('check-fix', 'succeeded'),
      stage('checks', 'succeeded', { round: 2 }),
      stage('review', 'succeeded'),
      stage('publish', 'succeeded'),
      stage('wait-ci', 'succeeded'),
    ];
    const strip = stageStrip(stages, run('complete'));
    expect(strip.map((i) => i.label)).toEqual([
      'Plan',
      'Build',
      'Local checks',
      'Codex review',
      'Fix',
      'Open PR',
      'GitHub CI',
    ]);
    expect(states(strip)).toEqual({
      plan: 'done',
      implement: 'done',
      checks: 'done',
      review: 'done',
      fix: 'done',
      publish: 'done',
      ci: 'done',
    });
    expect(strip.find((i) => i.key === 'checks')!.count).toBe(2);
  });

  it('counts CI fix rounds on the CI cell', () => {
    const strip = stageStrip(
      [
        stage('implement', 'succeeded'),
        stage('publish', 'succeeded'),
        stage('wait-ci', 'failed'),
        stage('ci-fix', 'succeeded'),
        stage('publish', 'succeeded'),
        stage('wait-ci', 'succeeded'),
      ],
      run('awaiting_review'),
    );
    const ci = strip.find((i) => i.key === 'ci')!;
    expect(ci).toMatchObject({ state: 'done', count: 2, ciFixes: 1 });
    expect(strip.find((i) => i.key === 'fix')!.state).toBe('done');
    expect(strip.find((i) => i.key === 'publish')!).not.toHaveProperty('ciFixes');
  });

  it('marks steps that never ran as skipped once complete (no-publish run)', () => {
    const stages = [
      stage('implement', 'succeeded'),
      stage('checks', 'succeeded'),
      stage('review', 'succeeded'),
    ];
    expect(states(stageStrip(stages, run('complete')))).toMatchObject({
      fix: 'skipped',
      publish: 'skipped',
      ci: 'skipped',
    });
  });

  it('shows a blocked run with the blocked step and later steps pending', () => {
    const stages = [
      stage('implement', 'succeeded'),
      stage('checks', 'failed'),
      stage('check-fix', 'blocked'),
    ];
    expect(states(stageStrip(stages, run('blocked')))).toEqual({
      plan: 'done',
      implement: 'done',
      checks: 'failed',
      review: 'pending',
      fix: 'blocked',
      publish: 'pending',
      ci: 'pending',
    });
  });

  it('shows a run in progress with the open stage running', () => {
    const stages = [stage('implement', 'succeeded'), stage('checks', 'running')];
    expect(states(stageStrip(stages, run('checking')))).toEqual({
      plan: 'done',
      implement: 'done',
      checks: 'running',
      review: 'pending',
      fix: 'pending',
      publish: 'pending',
      ci: 'pending',
    });
  });

  it('treats a stage left running in a finished run as stopped', () => {
    const strip = stageStrip([stage('implement', 'running')], run('interrupted'));
    expect(strip.find((i) => i.key === 'implement')!.state).toBe('stopped');
  });

  it('is all pending for a run that has not started a stage', () => {
    expect(
      stageStrip([], run('setup'))
        .filter((i) => i.key !== 'plan')
        .every((i) => i.state === 'pending'),
    ).toBe(true);
  });
});

describe('checksBySha', () => {
  it('groups local CI runs by head SHA with per-check results', () => {
    const out = (passed: boolean) => ({
      passed,
      checks: [
        { name: 'test', passed, logPath: '/runs/a/checks/aaa1111/test.log' },
        { name: 'lint', passed: true, logPath: '/runs/a/checks/aaa1111/lint.log' },
      ],
    });
    const groups = checksBySha([
      stage('implement', 'succeeded'),
      stage('checks', 'failed', { input: { headSha: 'aaa1111' }, output: out(false) }),
      stage('checks', 'succeeded', { round: 2, input: { headSha: 'bbb2222' }, output: out(true) }),
      stage('checks', 'running', { round: 3, input: { headSha: 'bbb2222' } }),
    ]);
    expect(groups.map((g) => g.sha)).toEqual(['aaa1111', 'bbb2222']);
    expect(groups[0]!.runs[0]).toMatchObject({ passed: false, state: 'failed' });
    expect(groups[0]!.runs[0]!.checks[0]).toEqual({
      name: 'test',
      passed: false,
      logPath: '/runs/a/checks/aaa1111/test.log',
    });
    expect(groups[1]!.runs).toHaveLength(2);
    expect(groups[1]!.runs[1]).toMatchObject({ passed: null, checks: [] });
  });

  it('survives rows with missing or odd JSON', () => {
    const groups = checksBySha([
      stage('checks', 'failed', { input: 'x', output: { checks: [null, { name: 5 }] } }),
    ]);
    expect(groups[0]!.sha).toBe('unknown');
    expect(groups[0]!.runs[0]!.checks).toEqual([
      { name: '(unnamed)', passed: false, logPath: null },
      { name: '(unnamed)', passed: false, logPath: null },
    ]);
  });
});

describe('summarizeEvent', () => {
  const sum = (type: string, payload?: unknown) => summarizeEvent({ type, payload });

  it('summarizes planner, plan, continuation, repeat, rulings and decision events', () => {
    expect(sum('planner.session', { mode: 'pane', attach: 'x' })).toBe('Planner started');
    expect(sum('planner.session', { mode: 'headless' })).toBe('Planner started');
    expect(sum('plan.approved', { version: 2 })).toBe('Plan v2 approved');
    expect(sum('plan.invalid', { version: 1, errors: ['a', 'b'] })).toBe(
      'Plan v1 is invalid (2 errors)',
    );
    expect(sum('plan.approval_unrecorded', { version: 3 })).toBe(
      'Plan v3 approval could not be recorded',
    );
    expect(sum('planner.waiting_for_human', { notice: 'Needs you' })).toBe('Needs you');
    expect(sum('planner.stop_failed', { error: 'boom' })).toBe('Could not stop the planner: boom');
    expect(sum('continuation.failed', { reason: 'crash' })).toBe('Continuation failed: crash');
    expect(sum('triage.not_asked', { round: 1, findings: ['a'] })).toBe(
      'Did not ask about 1 finding',
    );
    expect(sum('repeat.recorded', { key: 'F1', repeatOf: 'F0' })).toBe(
      'Finding F1 recorded as a repeat',
    );
    expect(sum('rulings.invalid', { skipped: 2 })).toBe('Skipped 2 invalid rulings');
    expect(sum('decision.answered', { id: 4, choice: 'approve' })).toBe('You answered: approve');
  });

  it('summarizes each event type the pipeline writes', () => {
    expect(sum('run.started', { branch: 'bp/x' })).toBe('Run started on bp/x');
    expect(sum('stage', { stage: 'waiting_ci', note: 'PR #4' })).toBe(
      'Waiting for GitHub CI: PR #4',
    );
    expect(sum('stage', { stage: 'implementing' })).toBe('Building');
    expect(sum('stage', { stage: 'cancelled', note: 'cancelled' })).toBe('Cancelled');
    expect(sum('stage', { stage: 'cancelled', note: 'Cancelled by you' })).toBe(
      'Cancelled: Cancelled by you',
    );
    expect(sum('implementer.session', { mode: 'pane', attach: 'x' })).toBe('Implementer started');
    expect(sum('implementer.waiting_for_human', { notice: 'Needs approval' })).toBe(
      'Needs approval',
    );
    expect(sum('agent.tool_use', { name: 'Edit' })).toBe('Tool: Edit');
    expect(sum('agent.result', { numTurns: 3, totalCostUsd: 0.5, isError: false })).toBe(
      'Agent turn finished (3 turns, $0.50)',
    );
    expect(sum('checks.result', { head: 'abc1234', passed: false })).toBe(
      'Local checks failed on abc1234',
    );
    expect(sum('ci.failed', { head: 'abc1234', checks: ['build', 'e2e'] })).toBe(
      'GitHub CI failed on abc1234: build, e2e',
    );
    expect(sum('ci.failed', {})).toBe('GitHub CI failed');
    expect(sum('checks.warning', { warning: 'no lint' })).toBe('no lint');
    expect(sum('drift.stale', { check: 'test', ref: 'ci.yml' })).toBe(
      'Check test is stale (ci.yml)',
    );
    expect(sum('review.result', { round: 2, findings: 1, blocking: 1 })).toBe(
      'Review round 2: 1 finding, 1 blocking',
    );
    expect(sum('triage.asked', { round: 1, findings: ['r1:f_1', 'r1:f_2'] })).toBe(
      'Asked you to triage 2 findings',
    );
    expect(sum('triage.answered', { key: 'r1:f_1', choice: 'skip' })).toBe('Triage r1:f_1: skip');
    expect(sum('dispute.opened', { findings: ['r1:f_1'], decisions: [3] })).toBe(
      '1 finding disputed by the implementer',
    );
    expect(sum('dispute.answered', { key: 'r1:f_1', choice: 'uphold' })).toBe(
      'Dispute r1:f_1: uphold',
    );
    expect(sum('fix.broad', { files: 12, lines: 340 })).toBe(
      'Fix looks broad: 12 files, 340 lines',
    );
    expect(sum('fix.broad')).toBe('fix.broad');
    expect(sum('question', { question: 'Which db?' })).toBe('Question: Which db?');
    expect(sum('pr', { number: 9, url: 'u' })).toBe('Opened PR #9');
    expect(sum('publish.stopped', { code: 'push_failed' })).toBe('Publish stopped (push_failed)');
    expect(sum('db.error', { error: 'disk full' })).toBe('disk full');
    expect(sum('run.interrupted', { stage: 'checking', note: 'server restarted' })).toBe(
      'Run interrupted: server restarted',
    );
  });

  it('falls back to the type for unknown types and missing payloads', () => {
    expect(sum('something.new', { a: 1 })).toBe('something.new');
    expect(sum('pr', null)).toBe('pr');
    expect(sum('review.result')).toBe('review.result');
    expect(sum('stage', 'oops')).toBe('stage');
  });

  it('flags agent events as noisy', () => {
    expect(isNoisyEvent('agent.tool_use')).toBe(true);
    expect(isNoisyEvent('stage')).toBe(false);
  });
});

describe('stageStrip met criteria', () => {
  it('puts the count on the Fix cell when a fix ran', () => {
    const stages = [stage('implement', 'succeeded'), stage('review-fix', 'succeeded')];
    const strip = stageStrip(stages, run('checking'), { met: 5, total: 7 });
    expect(strip.find((i) => i.key === 'fix')!.met).toEqual({ met: 5, total: 7 });
    expect(strip.find((i) => i.key === 'implement')!.met).toBeUndefined();
  });

  it('puts the count on the Implement cell when no fix ran', () => {
    const stages = [stage('implement', 'succeeded'), stage('checks', 'succeeded')];
    const strip = stageStrip(stages, run('checking'), { met: 5, total: 7 });
    expect(strip.find((i) => i.key === 'implement')!.met).toEqual({ met: 5, total: 7 });
    expect(strip.find((i) => i.key === 'fix')!.met).toBeUndefined();
    expect(strip.find((i) => i.key === 'checks')!.met).toBeUndefined();
  });

  it('shows no count without criteria', () => {
    const strip = stageStrip([stage('implement', 'succeeded')], run('checking'), {
      met: 0,
      total: 0,
    });
    expect(strip.every((i) => i.met === undefined)).toBe(true);
  });
});
