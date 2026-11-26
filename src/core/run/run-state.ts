import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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
  /** Which plan version the run implements (Phase 3 planning adds new versions). */
  planVersion: z.number().int().default(1),
  stage: z.enum(RUN_STAGES),
  stageNote: z.string().nullable(),
  implementer: z
    .strictObject({
      mode: z.enum(['pane', 'headless']),
      sessionId: z.string(),
      paneLabel: z.string().nullable(),
    })
    .nullable(),
  /** The implementer process was stopped (the conversation can still be resumed). */
  sessionEnded: z.boolean().default(false),
  rounds: z.strictObject({
    checkFix: z.number().int(),
    reviewFix: z.number().int(),
    /** Fix turns that answered the human's send-back feedback. */
    feedback: z.number().int().default(0),
    /** Local CI runs so far (the round of the next `checks` stage). */
    checkRuns: z.number().int().default(0),
  }),
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

/** Reads and validates `<runDir>/run.json`; fields added later take their defaults. */
export async function loadRunState(runDir: string): Promise<RunState> {
  const text = await readFile(join(runDir, 'run.json'), 'utf8');
  return RunStateSchema.parse(JSON.parse(text));
}
