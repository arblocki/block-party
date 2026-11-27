import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { configDir } from '../core/paths.js';

/** How many runs may be driven at once. */
export interface Limits {
  /** Runs driven at the same time, over all projects. */
  maxRuns: number;
  /** Runs driven at the same time in one project. */
  maxRunsPerProject: number;
}

export const DEFAULT_LIMITS: Limits = { maxRuns: 3, maxRunsPerProject: 2 };

const LimitsSchema = z.strictObject({
  maxRuns: z.number().int().min(1).default(DEFAULT_LIMITS.maxRuns),
  maxRunsPerProject: z.number().int().min(1).default(DEFAULT_LIMITS.maxRunsPerProject),
});

/** The settings file named by the person is not usable; the server should not start. */
export class LimitsConfigError extends Error {
  constructor(file: string, detail: string) {
    super(`Cannot use the limits in ${file}: ${detail}`);
    this.name = 'LimitsConfigError';
  }
}

export interface ReadLimitsOptions {
  /** The settings file (default `<config dir>/config.yaml`). */
  file?: string;
  /** Reads a file's text, or returns undefined when it does not exist (default: the disk). */
  readFile?: (file: string) => string | undefined;
}

function readFromDisk(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

/**
 * The run limits: the `limits` key of `~/.config/block-party/config.yaml`, with defaults for
 * what it leaves out. Nothing else in the file is read. A missing file (or no `limits` key)
 * means the defaults; a file that cannot be read or parsed, or limits that are not whole
 * numbers of at least 1, throw a `LimitsConfigError`.
 */
export function readLimits(opts: ReadLimitsOptions = {}): Limits {
  const file = opts.file ?? join(configDir(), 'config.yaml');
  let text: string | undefined;
  try {
    text = (opts.readFile ?? readFromDisk)(file);
  } catch (e) {
    throw new LimitsConfigError(file, `the file could not be read (${(e as Error).message})`);
  }
  if (text === undefined) return { ...DEFAULT_LIMITS };
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    throw new LimitsConfigError(file, `the file is not valid YAML (${(e as Error).message})`);
  }
  if (doc === null || doc === undefined) return { ...DEFAULT_LIMITS };
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    throw new LimitsConfigError(file, 'the file must be a mapping of settings');
  }
  const raw = (doc as Record<string, unknown>).limits;
  if (raw === undefined || raw === null) return { ...DEFAULT_LIMITS };
  const parsed = LimitsSchema.safeParse(raw);
  if (!parsed.success) {
    const why = parsed.error.issues
      .map((i) => `${['limits', ...i.path].join('.')}: ${i.message}`)
      .join('; ');
    throw new LimitsConfigError(file, `${why}. Use whole numbers of 1 or more.`);
  }
  return parsed.data;
}
