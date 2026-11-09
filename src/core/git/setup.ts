import { scrubbedEnv } from '../process/env.js';
import { runShell, type RunShellResult } from '../process/run-shell.js';

export interface RunSetupOptions {
  cwd: string;
  command: string;
  logPath: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Defaults to process.env without credentials. */
  env?: NodeJS.ProcessEnv;
}

export type RunSetupResult = Pick<RunShellResult, 'code' | 'durationMs' | 'timedOut'>;

/** Runs the repo's setup command (e.g. install deps) in the worktree, logging to `logPath`. */
export async function runSetup(opts: RunSetupOptions): Promise<RunSetupResult> {
  const { code, durationMs, timedOut } = await runShell({
    ...opts,
    env: opts.env ?? scrubbedEnv(),
  });
  return { code, durationMs, timedOut };
}
