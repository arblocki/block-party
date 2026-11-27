import { describe, expect, it } from 'vitest';
import type { StageKind, StageRow, StageState } from '../types';
import { evidenceFor, headLine, staleLines } from './evidence';

let id = 1;
function stage(
  kind: StageKind,
  state: StageState,
  input: unknown,
  output: unknown,
  round = 1,
): StageRow {
  return {
    id: id++,
    runId: 'r20260101-aaaaaa',
    kind,
    round,
    state,
    input,
    output,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:01:00.000Z',
  };
}

const HEAD = 'abc1234def';
const OLD = '1111111aaa';
const checks = (sha: string, passed: boolean) =>
  stage('checks', passed ? 'succeeded' : 'failed', { headSha: sha }, { passed, checks: [] });
const review = (sha: string, round: number, blocking: number) =>
  stage('review', 'succeeded', { reviewedSha: sha }, { findings: blocking, blocking }, round);

describe('evidenceFor', () => {
  it('summarizes a head with checks, a clean review and pending CI', () => {
    const stages = [
      checks(HEAD, true),
      review(HEAD, 2, 0),
      stage('publish', 'succeeded', { headSha: HEAD }, null),
    ];
    const ev = evidenceFor(HEAD, stages);
    expect(ev).toEqual({
      head: HEAD,
      checks: 'passed',
      review: { round: 2, blocking: 0, open: 0 },
      ci: 'pending',
      stale: {},
    });
    expect(headLine(ev)).toBe('abc1234 · local CI passed · review r2 clean · GitHub CI pending');
  });

  it('counts open findings of the round when findings are given', () => {
    const rounds = [
      {
        round: 1,
        reviewedSha: HEAD,
        summary: '',
        findings: [{ status: 'open' }, { status: 'fixed' }],
      },
    ] as never;
    const ev = evidenceFor(HEAD, [review(HEAD, 1, 2)], rounds);
    expect(ev.review).toEqual({ round: 1, blocking: 2, open: 1 });
    expect(headLine(ev)).toContain('review r1 1 open');
  });

  it('reports a review on an older head as stale', () => {
    const stages = [checks(HEAD, true), review(OLD, 2, 0)];
    const ev = evidenceFor(HEAD, stages);
    expect(ev.review).toBeNull();
    expect(ev.stale.review).toEqual({ round: 2, sha: OLD, blocking: 0 });
    expect(staleLines(ev)).toEqual(['review round 2 was on 1111111, not the current head']);
    expect(headLine(ev)).toContain('not reviewed');
  });

  it('has nothing for a run with no checks yet', () => {
    const ev = evidenceFor(HEAD, [stage('checks', 'running', { headSha: HEAD }, null)]);
    expect(ev).toEqual({ head: HEAD, checks: 'none', review: null, ci: 'none', stale: {} });
    expect(headLine(ev)).toBe('abc1234 · no local CI · not reviewed · not published');
    expect(staleLines(ev)).toEqual([]);
  });

  it('uses the latest checks run and the wait-ci result of the head', () => {
    const stages = [
      checks(HEAD, false),
      checks(HEAD, true),
      stage('publish', 'succeeded', { headSha: HEAD }, null),
      stage('wait-ci', 'succeeded', { prNumber: 1, headSha: HEAD }, { state: 'no_ci' }),
    ];
    const ev = evidenceFor(HEAD, stages);
    expect(ev.checks).toBe('passed');
    expect(ev.ci).toBe('no_ci');
  });

  it('marks CI from an older head stale', () => {
    const stages = [
      stage('wait-ci', 'failed', { prNumber: 1, headSha: OLD }, { state: 'failure' }),
      checks(HEAD, true),
    ];
    const ev = evidenceFor(HEAD, stages);
    expect(ev.ci).toBe('none');
    expect(ev.stale.ci).toEqual({ sha: OLD, state: 'failure' });
  });
});
