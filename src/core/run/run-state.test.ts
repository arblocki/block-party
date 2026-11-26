import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUN_STAGES } from './machine.js';
import { loadRunState, RunStateSchema, saveRunState, type RunState } from './run-state.js';

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
  planVersion: 1,
  sessionEnded: false,
  stage: 'setup',
  stageNote: null,
  implementer: null,
  planner: null,
  rounds: { checkFix: 0, reviewFix: 0, feedback: 0, checkRuns: 0 },
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
  it('accepts every stage in RUN_STAGES, including cancelled and interrupted', () => {
    for (const stage of RUN_STAGES)
      expect(RunStateSchema.parse({ ...state, stage }).stage).toBe(stage);
    expect(RunStateSchema.shape.stage.options).toEqual([...RUN_STAGES]);
  });
  it('rejects invalid stage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bp-state-'));
    await expect(saveRunState(dir, { ...state, stage: 'nope' as never })).rejects.toThrow();
  });
  it('survives overlapping saves', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bp-state-'));
    const stages = ['setup', 'implementing', 'checking', 'reviewing', 'fixing'] as const;
    await Promise.all(stages.map((stage) => saveRunState(dir, { ...state, stage })));
    const back = RunStateSchema.parse(JSON.parse(await readFile(join(dir, 'run.json'), 'utf8')));
    expect(stages).toContain(back.stage);
    expect(await readdir(dir)).toEqual(['run.json']);
  });
  it('loads an old run.json without the Phase 3 fields, with defaults', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bp-state-'));
    const old: Record<string, unknown> = { ...state };
    delete old.planVersion;
    delete old.sessionEnded;
    await writeFile(
      join(dir, 'run.json'),
      JSON.stringify({ ...old, rounds: { checkFix: 1, reviewFix: 2 } }),
    );
    const back = await loadRunState(dir);
    expect(back).toMatchObject({
      planVersion: 1,
      sessionEnded: false,
      rounds: { checkFix: 1, reviewFix: 2, feedback: 0, checkRuns: 0 },
    });
  });
  it('round-trips the new fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bp-state-'));
    await saveRunState(dir, {
      ...state,
      planVersion: 3,
      sessionEnded: true,
      rounds: { checkFix: 0, reviewFix: 0, feedback: 2, checkRuns: 0 },
    });
    expect(await loadRunState(dir)).toMatchObject({
      planVersion: 3,
      sessionEnded: true,
      rounds: { feedback: 2 },
    });
  });
});
