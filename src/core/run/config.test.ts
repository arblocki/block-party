import { describe, expect, it } from 'vitest';
import { resolveRunConfig } from './config.js';

describe('resolveRunConfig', () => {
  it('applies defaults', () => {
    const c = resolveRunConfig(undefined);
    expect(c.implementer).toEqual({ model: 'opus', mode: 'pane' });
    expect(c.subagents).toEqual({
      implementer: 'sonnet',
      'test-writer': 'sonnet',
      explorer: 'sonnet',
    });
    expect(c.reviewer.model).toBeNull();
    expect(c.policy).toEqual({
      maxCheckFixRounds: 2,
      maxReviewFixRounds: 1,
      maxCiFixRounds: 1,
      autoFix: ['P0', 'P1'],
      ask: ['P2'],
      maxFixLinesPerFinding: 200,
      broadFixFiles: 10,
      stageTimeoutMs: 7_200_000,
      checkTimeoutMs: 900_000,
    });
    expect(c.publish).toBe(true);
    expect(c.waitForCi).toBe(true);
  });

  it('lets file values fill in and flags override them', () => {
    const c = resolveRunConfig(
      { implementer: { mode: 'headless' }, policy: { maxReviewFixRounds: 3 }, publish: false },
      { mode: 'pane', model: 'haiku', publish: true, reviewerModel: 'm' },
    );
    expect(c.implementer).toEqual({ model: 'haiku', mode: 'pane' });
    expect(c.policy.maxReviewFixRounds).toBe(3);
    expect(c.publish).toBe(true);
    expect(c.reviewer.model).toBe('m');
  });

  it('rejects invalid sections with a readable error', () => {
    expect(() => resolveRunConfig({ implementer: { mode: 'x' } })).toThrow(/Invalid run: config/);
  });
});
