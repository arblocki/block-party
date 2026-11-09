import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runShell } from './run-shell.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bp-shell-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Polls until the pid is gone. kill(pid, 0) succeeds on unreaped zombies, so allow a short wait. */
const goneWithin = async (pid: number, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  return !alive(pid);
};

describe('runShell', () => {
  it('captures stdout and stderr in the log and reports the exit code', async () => {
    const logPath = join(dir, 'logs', 'out.log');
    const r = await runShell({
      command: 'echo out; echo err 1>&2; exit 3',
      cwd: dir,
      logPath,
      timeoutMs: 5000,
    });
    expect(r).toMatchObject({ code: 3, timedOut: false });
    const log = readFileSync(logPath, 'utf8');
    expect(log).toContain('out');
    expect(log).toContain('err');
  });

  it('passes env and runs in cwd', async () => {
    const logPath = join(dir, 'o.log');
    await runShell({
      command: 'echo "$FOO"; pwd -P',
      cwd: dir,
      logPath,
      timeoutMs: 5000,
      env: { ...process.env, FOO: 'bar' },
    });
    const log = readFileSync(logPath, 'utf8');
    expect(log).toContain('bar');
    expect(log).toContain(dir.replace(/^\/private/, ''));
  });

  it('kills the process group on timeout', async () => {
    const logPath = join(dir, 't.log');
    const pidFile = join(dir, 'pid');
    const started = Date.now();
    const r = await runShell({
      command: `sleep 30 & echo $! > ${pidFile}; wait`,
      cwd: dir,
      logPath,
      timeoutMs: 1000,
    });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(pid).toBeGreaterThan(0);
    // The orphaned sleep may linger as an unreaped zombie until init/launchd reaps it.
    expect(await goneWithin(pid)).toBe(true);
  });

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    const r = await runShell({
      command: `trap '' TERM; sleep 30`,
      cwd: dir,
      logPath: join(dir, 'k.log'),
      timeoutMs: 100,
      killGraceMs: 200,
    });
    expect(r.timedOut).toBe(true);
    expect(r.durationMs).toBeLessThan(5000);
  });

  it('kills background descendants left behind when the leader exits', async () => {
    const logPath = join(dir, 'bg.log');
    const started = Date.now();
    const r = await runShell({
      command: 'sleep 30 & echo $!; exit 1',
      cwd: dir,
      logPath,
      timeoutMs: 10_000,
      killGraceMs: 200,
    });
    expect(r).toMatchObject({ code: 1, timedOut: false });
    expect(Date.now() - started).toBeLessThan(5000);
    const pid = Number(readFileSync(logPath, 'utf8').trim());
    expect(await goneWithin(pid)).toBe(true);
  });
});
