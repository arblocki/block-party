import { describe, expect, it } from 'vitest';
import { matchCriteria, normalizeCriterion, wordOverlap } from './acceptance-match.js';

const PLAN_1 =
  '`pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` and `pnpm build` all pass.';
const REPORT_1 = 'pnpm typecheck, pnpm lint, pnpm format:check, pnpm test and pnpm build all pass.';
const PLAN_2 =
  'The existing test `gives the latest plan version on the run summary and detail` (`src/server/runs-api.test.ts:844`) still passes unchanged.';
const REPORT_2 =
  "The existing test 'gives the latest plan version on the run summary and detail' still passes unchanged.";

describe('normalizeCriterion', () => {
  it('makes a plan criterion and its report wording equal', () => {
    expect(normalizeCriterion(PLAN_1)).toBe(normalizeCriterion(REPORT_1));
  });

  it('strips emphasis, unifies quotes and ellipses, drops trailing periods', () => {
    expect(normalizeCriterion('**Bold** and _it_  “quoted” ‘x’…')).toBe(
      normalizeCriterion('bold and it "quoted" \'x\'...'),
    );
    expect(normalizeCriterion('Done.')).toBe('done');
  });
});

describe('matchCriteria', () => {
  it('matches exact normalized text', () => {
    expect([...matchCriteria([PLAN_1], [REPORT_1])]).toEqual([[0, 0]]);
  });

  it('falls back to word overlap when the report dropped a parenthetical', () => {
    expect(normalizeCriterion(PLAN_2)).not.toBe(normalizeCriterion(REPORT_2));
    expect(wordOverlap(PLAN_2, REPORT_2)).toBeGreaterThanOrEqual(0.8);
    expect([...matchCriteria([PLAN_2], [REPORT_2])]).toEqual([[0, 0]]);
  });

  it('does not match unrelated criteria', () => {
    expect(matchCriteria(['Widgets are blue'], ['The build passes on CI'])).toEqual(new Map());
    expect(matchCriteria([PLAN_1], [REPORT_2])).toEqual(new Map());
  });

  it('uses each entry once', () => {
    const m = matchCriteria([PLAN_2, PLAN_2], [REPORT_2]);
    expect(m.size).toBe(1);
  });
});
