import { appendFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';
import {
  runShell as realRunShell,
  type RunShellOptions,
  type RunShellResult,
} from '../process/run-shell.js';
import type { CheckConfig } from './config.js';

export interface CheckResult {
  name: string;
  command: string;
  cwd: string;
  /** null when killed by a signal or rejected before running. */
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  logPath: string;
}

export interface ChecksRunResult {
  headSha: string;
  passed: boolean;
  results: CheckResult[];
}

export interface RunChecksOptions {
  cwd: string;
  checks: readonly CheckConfig[];
  logDir: string;
  headSha: string;
  timeoutMs?: number;
  runShell?: (opts: RunShellOptions) => Promise<RunShellResult>;
}

export const DEFAULT_CHECK_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Resolves a check's cwd inside the worktree, following symlinks. Throws when it escapes or
 * cannot be resolved (e.g. missing directory).
 */
function resolveCwd(root: string, cwd: string | undefined): string {
  const realRoot = realpathSync(root);
  const real = realpathSync(resolve(realRoot, cwd ?? '.'));
  const rel = relative(realRoot, real);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`cwd escapes the worktree: ${cwd}`);
  }
  return real;
}

function logFileName(name: string): string {
  return `${name.replace(/[^A-Za-z0-9._-]/g, '_')}.log`;
}

/** Runs the checks one after another; a failure does not stop the rest. */
export async function runChecks(opts: RunChecksOptions): Promise<ChecksRunResult> {
  const run = opts.runShell ?? realRunShell;
  const results: CheckResult[] = [];
  const used = new Set<string>();
  for (const check of opts.checks) {
    let file = logFileName(check.name);
    for (let i = 2; used.has(file); i++) file = logFileName(`${check.name}-${i}`);
    used.add(file);
    const logPath = join(opts.logDir, file);
    try {
      const cwd = resolveCwd(opts.cwd, check.cwd);
      const r = await run({
        command: check.run,
        cwd,
        logPath,
        timeoutMs: opts.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
      });
      results.push({
        name: check.name,
        command: check.run,
        cwd,
        exitCode: r.code,
        durationMs: r.durationMs,
        timedOut: r.timedOut,
        logPath,
      });
    } catch (err) {
      try {
        mkdirSync(opts.logDir, { recursive: true });
        appendFileSync(logPath, `${(err as Error).message}\n`);
      } catch {
        // The failed result below still records the check as failed.
      }
      results.push({
        name: check.name,
        command: check.run,
        cwd: check.cwd ?? '.',
        exitCode: null,
        durationMs: 0,
        timedOut: false,
        logPath,
      });
    }
  }
  return {
    headSha: opts.headSha,
    passed: results.every((r) => r.exitCode === 0 && !r.timedOut),
    results,
  };
}

/** Last `lines` lines of a log, for fix prompts. Empty when the log is missing. */
export function tailLog(path: string, lines = 80): string {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return '';
  }
  const all = text.replace(/\n$/, '').split('\n');
  return all.slice(-lines).join('\n');
}
