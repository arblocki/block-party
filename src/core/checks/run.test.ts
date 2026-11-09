import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runChecks, tailLog } from './run.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'bp-run-'));
}

describe('runChecks', () => {
  it('runs all checks sequentially, continuing after failures, with logs', async () => {
    const cwd = tmp();
    const logDir = join(tmp(), 'logs');
    mkdirSync(join(cwd, 'sub'));
    const res = await runChecks({
      cwd,
      logDir,
      headSha: 'abc',
      checks: [
        { name: 'ok', run: 'echo hello' },
        { name: 'bad', run: 'echo oops >&2; false' },
        { name: 'three', run: 'exit 3' },
        { name: 'sub', run: 'pwd', cwd: 'sub' },
      ],
    });
    expect(res.headSha).toBe('abc');
    expect(res.passed).toBe(false);
    expect(res.results.map((r) => r.exitCode)).toEqual([0, 1, 3, 0]);
    expect(readFileSync(join(logDir, 'ok.log'), 'utf8')).toContain('hello');
    expect(readFileSync(join(logDir, 'bad.log'), 'utf8')).toContain('oops');
    expect(readFileSync(join(logDir, 'sub.log'), 'utf8').trim().endsWith('sub')).toBe(true);
  });

  it('passes when all pass', async () => {
    const res = await runChecks({
      cwd: tmp(),
      logDir: tmp(),
      headSha: 'x',
      checks: [{ name: 'a', run: 'true' }],
    });
    expect(res.passed).toBe(true);
  });

  it('rejects a cwd that escapes the worktree without running it', async () => {
    const cwd = tmp();
    const logDir = tmp();
    const marker = join(tmp(), 'ran');
    const runShell = vi.fn();
    const res = await runChecks({
      cwd,
      logDir,
      headSha: 'x',
      runShell,
      checks: [
        { name: 'esc', run: `touch ${marker}`, cwd: '../..' },
        { name: 'abs', run: 'true', cwd: '/' },
      ],
    });
    expect(runShell).not.toHaveBeenCalled();
    expect(existsSync(marker)).toBe(false);
    expect(res.passed).toBe(false);
    expect(res.results.every((r) => r.exitCode === null)).toBe(true);
    expect(readFileSync(join(logDir, 'esc.log'), 'utf8')).toContain('escapes');
  });

  it('reports timeouts as failures', async () => {
    const runShell = vi.fn(() =>
      Promise.resolve({ code: null, signal: 'SIGTERM', durationMs: 5, timedOut: true }),
    );
    const res = await runChecks({
      cwd: tmp(),
      logDir: tmp(),
      headSha: 'x',
      runShell,
      timeoutMs: 10,
      checks: [{ name: 'slow', run: 'sleep 9' }],
    });
    expect(res.passed).toBe(false);
    expect(res.results[0]?.timedOut).toBe(true);
    expect(runShell).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 10 }));
  });
});

describe('tailLog', () => {
  it('returns the last lines, or empty for a missing file', () => {
    const p = join(tmp(), 'l.log');
    writeFileSync(p, Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n') + '\n');
    expect(tailLog(p, 3)).toBe('l7\nl8\nl9');
    expect(tailLog(join(tmp(), 'nope.log'))).toBe('');
  });
});
