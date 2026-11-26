import { describe, expect, it } from 'vitest';
import { resolveRunConfig } from './config.js';
import { assessFix, mayInherit, parseRulings } from './triage.js';
import type { Finding } from '../reviewer/findings.js';

const policy = resolveRunConfig(undefined).policy;

describe('parseRulings', () => {
  it('keeps valid entries and counts the invalid ones', () => {
    const r = parseRulings([
      { key: 'r1:f_1', ruling: 'skip', note: '' },
      { key: 'r1:f_2', ruling: 'nope', note: '' },
      { key: 'r1:f_3', ruling: 'uphold', note: 'n', spent: true },
    ]);
    expect(r.rulings.map((x) => x.key)).toEqual(['r1:f_1', 'r1:f_3']);
    expect(r.invalid).toBe(1);
    expect(parseRulings(undefined)).toEqual({ rulings: [], invalid: 0 });
    expect(parseRulings({})).toEqual({ rulings: [], invalid: 1 });
  });
});

describe('mayInherit', () => {
  it('only passes a ruling down to an equal or milder finding', () => {
    expect(mayInherit(policy, 'P2', 'P2')).toBe(true);
    expect(mayInherit(policy, 'P2', 'P3')).toBe(true);
    expect(mayInherit(policy, 'P2', 'P1')).toBe(false);
    expect(mayInherit(policy, 'P2', 'P0')).toBe(false);
    expect(mayInherit(policy, 'P1', 'P2')).toBe(true);
  });
});

describe('assessFix', () => {
  const f = { severity: 'P1', location: { path: 'a.ts', startLine: 1, endLine: 1 } } as Finding;
  it('is not broad for a small change in the findings path', () => {
    expect(
      assessFix([{ path: './a.ts', added: 5, deleted: 1, status: 'M' }], [f], policy).broad,
    ).toBe(false);
  });
  it('flags a rename or delete', () => {
    const a = assessFix([{ path: 'a.ts', added: 0, deleted: 3, status: 'D' }], [f], policy);
    expect(a.reasons.join()).toContain('deleted or renamed');
  });
});
