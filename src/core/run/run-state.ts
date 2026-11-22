import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { RUN_STAGES } from './machine.js';

export const RunStateSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  repoPath: z.string(),
  owner: z.string(),
  repo: z.string(),
  baseRef: z.string(),
  baseSha: z.string(),
  branch: z.string(),
  worktreePath: z.string(),
  headSha: z.string().nullable(),
  planPath: z.string(),
  planHash: z.string(),
  stage: z.enum(RUN_STAGES),
  stageNote: z.string().nullable(),
  implementer: z
    .strictObject({
      mode: z.enum(['pane', 'headless']),
      sessionId: z.string(),
      paneLabel: z.string().nullable(),
    })
    .nullable(),
  rounds: z.strictObject({ checkFix: z.number().int(), reviewFix: z.number().int() }),
  prNumber: z.number().int().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type RunState = z.infer<typeof RunStateSchema>;

/** Atomically writes `<runDir>/run.json` (temp file + rename). */
export async function saveRunState(runDir: string, state: RunState): Promise<void> {
  const valid = RunStateSchema.parse(state);
  await mkdir(runDir, { recursive: true });
  const tmp = join(runDir, `run.json.${randomUUID()}.tmp`);
  await writeFile(tmp, JSON.stringify(valid, null, 2) + '\n');
  await rename(tmp, join(runDir, 'run.json'));
}
