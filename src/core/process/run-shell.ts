import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

export interface RunShellOptions {
  command: string;
  cwd: string;
  /** stdout and stderr are appended here. */
  logPath: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  /** After SIGTERM on timeout, wait this long before SIGKILL (default 2000ms). */
  killGraceMs?: number;
}

export interface RunShellResult {
  code: number | null;
  signal: string | null;
  durationMs: number;
  timedOut: boolean;
}

const POSIX = process.platform !== 'win32';
const POST_KILL_WAIT_MS = 1000;

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs `sh -c <command>` in its own process group, streaming stdout+stderr to `logPath`.
 * On timeout the whole group gets SIGTERM, then SIGKILL after a grace period; the promise
 * resolves only once the group is gone (or a hard wait elapses).
 */
export function runShell(opts: RunShellOptions): Promise<RunShellResult> {
  const { command, cwd, logPath, timeoutMs } = opts;
  const killGraceMs = opts.killGraceMs ?? 2000;
  const started = Date.now();

  return new Promise((resolve, reject) => {
    let fd: number;
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      fd = openSync(logPath, 'a');
    } catch (err) {
      reject(err);
      return;
    }
    let child;
    try {
      child = spawn('sh', ['-c', command], {
        cwd,
        env: opts.env ?? process.env,
        detached: POSIX,
        stdio: ['ignore', fd, fd],
      });
    } catch (err) {
      closeSync(fd);
      reject(err);
      return;
    }
    const pgid = POSIX ? child.pid : undefined;

    let settled = false;
    let timedOut = false;
    let stopping = false;
    let leaderExited = false;
    let code: number | null = null;
    let sig: string | null = null;
    let timer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    let hardTimer: NodeJS.Timeout | undefined;
    let poll: NodeJS.Timeout | undefined;

    const onProcessExit = () => {
      if (pgid) {
        try {
          process.kill(-pgid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    };
    process.once('exit', onProcessExit);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      clearTimeout(hardTimer);
      clearInterval(poll);
      process.removeListener('exit', onProcessExit);
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
      fn();
    };
    const done = () =>
      finish(() => resolve({ code, signal: sig, durationMs: Date.now() - started, timedOut }));
    const signalTree = (s: NodeJS.Signals) => {
      try {
        if (pgid) process.kill(-pgid, s);
        else child.kill(s);
      } catch {
        /* already gone */
      }
    };
    const settleIfStopped = () => {
      if (stopping && leaderExited && !(pgid && groupAlive(pgid))) done();
    };
    // SIGTERM the group, SIGKILL after the grace period; settle once the group is gone.
    const stop = () => {
      if (stopping || settled) return;
      stopping = true;
      clearTimeout(timer);
      signalTree('SIGTERM');
      poll = setInterval(settleIfStopped, 25);
      graceTimer = setTimeout(() => {
        signalTree('SIGKILL');
        hardTimer = setTimeout(done, POST_KILL_WAIT_MS);
      }, killGraceMs);
    };

    child.on('error', (err) => finish(() => reject(err)));
    child.on('close', (c, s) => {
      leaderExited = true;
      code = c;
      sig = s;
      if (stopping) settleIfStopped();
      else if (pgid && groupAlive(pgid))
        stop(); // leader left background descendants behind
      else done();
    });

    if (Number.isFinite(timeoutMs)) {
      timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);
    }
  });
}
