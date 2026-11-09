import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunStateSchema, saveRunState, type RunState } from './run-state.js';

const state: RunState = {
  id: 'r20261108-3fa9c1',
  title: 't',
  repoPath: '/r',
  owner: 'o',
  repo: 'r',
  baseRef: 'main',
  baseSha: 'abc',
  branch: 'bp/t-3fa9c1',
  worktreePath: '/w',
  headSha: null,
  planPath: '/p.md',
  planHash: 'deadbeef',
  stage: 'setup',
  stageNote: null,
  implementer: null,
  rounds: { checkFix: 0, reviewFix: 0 },
  prNumber: null,
  createdAt: '2026-11-08T00:00:00Z',
  updatedAt: '2026-11-08T00:00:00Z',
};

describe('run state', () => {
  it('saves atomically and round-trips', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'bp-state-')), 'run');
    await saveRunState(dir, state);
    await saveRunState(dir, { ...state, stage: 'implementing' });
    expect(await readdir(dir)).toEqual(['run.json']);
    const back = RunStateSchema.parse(JSON.parse(await readFile(join(dir, 'run.json'), 'utf8')));
    expect(back.stage).toBe('implementing');
  });
  it('rejects invalid stage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bp-state-'));
    await expect(saveRunState(dir, { ...state, stage: 'nope' as never })).rejects.toThrow();
  });
});
