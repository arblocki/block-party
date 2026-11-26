import { describe, expect, it } from 'vitest';
import type { Finding } from './findings.js';
import { scoreCase, type Expectation } from './eval-score.js';

let n = 0;
function finding(
  over: Partial<Finding> & { path?: string; start?: number; end?: number },
): Finding {
  const { path = 'a.ts', start = 1, end = 1, ...rest } = over;
  return {
    id: `f${++n}`,
    reviewedSha: 'abcdef1',
    severity: 'P1',
    category: 'correctness',
    title: 'something',
    body: 'details',
    location: { path, startLine: start, endLine: end },
    confidence: 'high',
    suggestedFix: null,
    repeatOf: null,
    ...rest,
  };
}
const exp = (over: Partial<Expectation> = {}): Expectation => ({
  path: 'a.ts',
  minSeverity: 'P1',
  keywords: ['inject'],
  ...over,
});

describe('scoreCase', () => {
  it('matches by keyword case-insensitively in title or body', () => {
    const s = scoreCase([exp()], [finding({ body: 'SQL Injection here' })]);
    expect(s.matched).toHaveLength(1);
    expect(s.matched[0]?.by).toBe('keywords');
    expect(s.recall).toBe(1);
    expect(s.missed).toEqual([]);
  });

  it('matches by overlapping lines without a keyword', () => {
    const s = scoreCase([exp({ lines: [10, 12] })], [finding({ start: 12, end: 20 })]);
    expect(s.matched[0]?.by).toBe('lines');
  });

  it('does not match when lines are disjoint and no keyword hits', () => {
    const s = scoreCase([exp({ lines: [10, 12] })], [finding({ start: 13, end: 14 })]);
    expect(s.matched).toEqual([]);
    expect(s.missed).toEqual([0]);
    expect(s.extra).toHaveLength(1);
    expect(s.recall).toBe(0);
  });

  it('requires the same path (ignoring ./) and a location', () => {
    expect(scoreCase([exp()], [finding({ path: 'b.ts', body: 'inject' })]).matched).toEqual([]);
    expect(scoreCase([exp()], [finding({ path: './a.ts', body: 'inject' })]).matched).toHaveLength(
      1,
    );
    expect(scoreCase([exp()], [finding({ body: 'inject', location: null })]).matched).toEqual([]);
  });

  it('enforces severity rank: P0 < P1 < P2 < P3', () => {
    const f = (severity: Finding['severity']) => finding({ severity, body: 'inject' });
    expect(scoreCase([exp({ minSeverity: 'P1' })], [f('P0')]).matched).toHaveLength(1);
    expect(scoreCase([exp({ minSeverity: 'P1' })], [f('P1')]).matched).toHaveLength(1);
    expect(scoreCase([exp({ minSeverity: 'P1' })], [f('P2')]).matched).toEqual([]);
    expect(scoreCase([exp({ minSeverity: 'P3' })], [f('P3')]).matched).toHaveLength(1);
  });

  it('lets a finding satisfy at most one expectation', () => {
    const s = scoreCase([exp(), exp()], [finding({ body: 'inject' })]);
    expect(s.matched).toHaveLength(1);
    expect(s.missed).toHaveLength(1);
    expect(s.recall).toBe(0.5);
  });

  it('finds a maximum matching, not a greedy one (regression)', () => {
    const both = finding({ body: 'alpha beta' });
    const alphaOnly = finding({ body: 'alpha' });
    const s = scoreCase(
      [exp({ keywords: ['alpha'] }), exp({ keywords: ['beta'] })],
      [both, alphaOnly],
    );
    expect(s.recall).toBe(1);
    expect(s.missed).toEqual([]);
    expect(s.matched.map((m) => m.findingId)).toEqual([alphaOnly.id, both.id]);
  });

  it('prefers the better match when matchings are the same size', () => {
    const e0 = exp({ keywords: ['inject'] });
    const e1 = exp({ lines: [5, 6], keywords: ['inject'] });
    const generic = finding({ start: 90, end: 90, body: 'inject' });
    const precise = finding({ start: 5, end: 6, body: 'inject' });
    const s = scoreCase([e0, e1], [generic, precise]);
    expect(s.matched).toEqual([
      { expectation: 0, findingId: generic.id, by: 'keywords' },
      { expectation: 1, findingId: precise.id, by: 'lines' },
    ]);
  });

  it('reports extras for unmatched findings on positive cases without counting false positives', () => {
    const s = scoreCase([exp()], [finding({ body: 'inject' }), finding({ title: 'nit' })]);
    expect(s.extra).toHaveLength(1);
    expect(s.falsePositives).toEqual([]);
  });

  it('counts P0-P2 findings as false positives on negative cases, not P3', () => {
    const s = scoreCase(
      [],
      [finding({ severity: 'P2' }), finding({ severity: 'P3' }), finding({ severity: 'P0' })],
    );
    expect(s.recall).toBeNull();
    expect(s.falsePositives.map((f) => f.severity)).toEqual(['P2', 'P0']);
    expect(s.extra).toHaveLength(3);
  });

  it('scores an empty review of a negative case as clean', () => {
    const s = scoreCase([], []);
    expect(s).toEqual({ matched: [], missed: [], extra: [], recall: null, falsePositives: [] });
  });
});
