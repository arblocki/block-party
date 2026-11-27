import { describe, expect, it } from 'vitest';
import { broadPermissionRules, resolveRunConfig } from './config.js';

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
      resumeOnRestart: false,
      maxCiFixRounds: 1,
      autoFix: ['P0', 'P1'],
      ask: ['P2'],
      maxFixLinesPerFinding: 200,
      broadFixFiles: 10,
      sandbox: 'off',
      sandboxAllowedDomains: [],
      sandboxAllowWrite: [],
      stageTimeoutMs: 7_200_000,
      checkTimeoutMs: 900_000,
    });
    expect(c.permissions).toEqual({ allow: [], deny: [] });
    expect(c.publish).toBe(true);
    expect(c.waitForCi).toBe(true);
  });

  it('flags broad project allow rules', () => {
    expect(
      broadPermissionRules([
        'Bash',
        'Edit',
        'Bash(*)',
        'Bash(:*)',
        'Bash(make lint *)',
        'Read(./x)',
      ]),
    ).toEqual(['Bash', 'Edit', 'Bash(*)', 'Bash(:*)']);
  });

  it('reads permission extras and the sandbox switch, and rejects malformed rules', () => {
    const c = resolveRunConfig({
      policy: { sandbox: 'on' },
      permissions: { allow: ['Bash(make lint *)'], deny: ['WebFetch'] },
    });
    expect(c.policy.sandbox).toBe('on');
    expect(c.permissions).toEqual({ allow: ['Bash(make lint *)'], deny: ['WebFetch'] });
    expect(() => resolveRunConfig({ permissions: { allow: ['make lint'] } })).toThrow(
      /permissions\.allow/,
    );
    expect(() => resolveRunConfig({ permissions: { deny: ['Bash(unclosed'] } })).toThrow(
      /permissions\.deny/,
    );
    expect(() => resolveRunConfig({ policy: { sandbox: 'maybe' } })).toThrow(/sandbox/);
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
