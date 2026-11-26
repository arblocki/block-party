import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runDir, runsRoot, worktreePath, worktreesRoot } from './paths.js';

const env = { BLOCK_PARTY_HOME: '/tmp/bp-home' };

describe('run paths', () => {
  it('builds roots under the data dir', () => {
    expect(runsRoot(env)).toBe(join('/tmp/bp-home', 'runs'));
    expect(worktreesRoot(env)).toBe(join('/tmp/bp-home', 'worktrees'));
    expect(runDir('r20261108-3fa9c1', env)).toBe('/tmp/bp-home/runs/r20261108-3fa9c1');
    expect(worktreePath('o', 'r.x', 'r1', env)).toBe('/tmp/bp-home/worktrees/o__r.x/r1');
  });
  it('rejects unsafe segments', () => {
    for (const bad of ['..', '.', 'a/b', '', 'a b', '../x']) {
      expect(() => runDir(bad, env)).toThrow();
      expect(() => worktreePath(bad, 'r', 'x', env)).toThrow();
      expect(() => worktreePath('o', bad, 'x', env)).toThrow();
    }
  });
});
