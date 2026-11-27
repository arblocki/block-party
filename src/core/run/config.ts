import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { REPO_CONFIG_FILES } from '../risk/repo-config.js';

const SeveritySchema = z.enum(['P0', 'P1', 'P2', 'P3']);

export const RunConfigSchema = z.object({
  implementer: z
    .object({
      model: z.string().min(1).default('opus'),
      mode: z.enum(['pane', 'headless']).default('pane'),
    })
    .prefault({}),
  subagents: z
    .object({
      implementer: z.string().min(1).default('sonnet'),
      'test-writer': z.string().min(1).default('sonnet'),
      explorer: z.string().min(1).default('sonnet'),
    })
    .prefault({}),
  reviewer: z.object({ model: z.string().min(1).nullable().default(null) }).prefault({}),
  policy: z
    .object({
      maxCheckFixRounds: z.number().int().min(0).default(2),
      maxReviewFixRounds: z.number().int().min(0).default(1),
      /** Fix rounds for a GitHub CI failure after local CI passed, per pass. */
      maxCiFixRounds: z.number().int().min(0).default(1),
      autoFix: z.array(SeveritySchema).default(['P0', 'P1']),
      /** Severities that are not fixed automatically but asked about in the inbox. */
      ask: z.array(SeveritySchema).default(['P2']),
      /** A fix turn that changes more lines than this per finding it fixes is a broad fix. */
      maxFixLinesPerFinding: z.number().int().positive().default(200),
      /** A fix turn that touches more files than this outside the fix set's paths is broad. */
      broadFixFiles: z.number().int().min(0).default(10),
      /** When the server starts, resume runs whose driving process died (default: ask first). */
      resumeOnRestart: z.boolean().default(false),
      stageTimeoutMs: z
        .number()
        .int()
        .positive()
        .default(2 * 60 * 60 * 1000),
      checkTimeoutMs: z
        .number()
        .int()
        .positive()
        .default(15 * 60 * 1000),
    })
    .prefault({}),
  publish: z.boolean().default(true),
  waitForCi: z.boolean().default(true),
});

export type RunConfig = z.infer<typeof RunConfigSchema>;

/** CLI flags that override the file config. Unset fields leave the config alone. */
export interface RunFlagOverrides {
  mode?: 'pane' | 'headless';
  model?: string;
  reviewerModel?: string;
  publish?: boolean;
  waitForCi?: boolean;
}

/** The raw `run:` section of the repo's `.block-party.yaml` (undefined when absent). */
export function readRunSection(repoDir: string): unknown {
  for (const file of REPO_CONFIG_FILES) {
    let text: string;
    try {
      text = readFileSync(join(repoDir, file), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error(`Could not read ${file}: ${(err as Error).message}`, { cause: err });
    }
    let raw: unknown;
    try {
      raw = parseYaml(text);
    } catch (err) {
      throw new Error(`${file}: invalid YAML: ${(err as Error).message.split('\n')[0]}`, {
        cause: err,
      });
    }
    return typeof raw === 'object' && raw !== null ? (raw as { run?: unknown }).run : undefined;
  }
  return undefined;
}

/** Parses the `run:` section (defaults fill gaps), then applies flag overrides. */
export function resolveRunConfig(section: unknown, flags: RunFlagOverrides = {}): RunConfig {
  const parsed = RunConfigSchema.safeParse(section ?? {});
  if (!parsed.success) {
    throw new Error(
      `Invalid run: config: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}`,
    );
  }
  const c = parsed.data;
  if (flags.mode) c.implementer.mode = flags.mode;
  if (flags.model) c.implementer.model = flags.model;
  if (flags.reviewerModel) c.reviewer.model = flags.reviewerModel;
  if (flags.publish !== undefined) c.publish = flags.publish;
  if (flags.waitForCi !== undefined) c.waitForCi = flags.waitForCi;
  return c;
}

export function loadRunConfig(repoDir: string, flags: RunFlagOverrides = {}): RunConfig {
  return resolveRunConfig(readRunSection(repoDir), flags);
}
