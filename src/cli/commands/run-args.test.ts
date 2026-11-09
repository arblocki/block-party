import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRunArgs } from './run.js';

function ok(argv: string[]) {
  const r = parseRunArgs(argv);
  if (!r.ok || r.help) throw new Error('expected parsed args');
  return r.args;
}

describe('parseRunArgs', () => {
  it('requires --plan', () => {
    expect(parseRunArgs([])).toEqual({ ok: false, error: '--plan <file> is required' });
  });

  it('defaults --repo to the current directory', () => {
    const a = ok(['--plan', 'p.md']);
    expect(a.repo).toBe(resolve('.'));
    expect(a.plan).toBe(resolve('p.md'));
    expect(a.base).toBeUndefined();
    expect(a.flags).toEqual({});
  });

  it('parses every flag', () => {
    const a = ok([
      '--repo',
      '/r',
      '--plan',
      '/p.md',
      '--base',
      'develop',
      '--mode',
      'headless',
      '--model',
      'sonnet',
      '--reviewer-model',
      'gpt-x',
      '--no-publish',
      '--no-wait-ci',
      '--title',
      'T',
    ]);
    expect(a).toMatchObject({ repo: '/r', plan: '/p.md', base: 'develop', title: 'T' });
    expect(a.flags).toEqual({
      mode: 'headless',
      model: 'sonnet',
      reviewerModel: 'gpt-x',
      publish: false,
      waitForCi: false,
    });
  });

  it('rejects a bad mode, unknown flags and empty values', () => {
    expect(parseRunArgs(['--plan', 'p', '--mode', 'tmux']).ok).toBe(false);
    expect(parseRunArgs(['--plan', 'p', '--bogus']).ok).toBe(false);
    expect(parseRunArgs(['--plan', 'p', '--model', ' ']).ok).toBe(false);
  });

  it('recognises --help', () => {
    expect(parseRunArgs(['--help'])).toEqual({ ok: true, help: true });
  });
});
