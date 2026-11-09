import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runChecks, tailLog } from './run.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'bp-run-'));
}

describe('runChecks', () => {
  it('kills a running check promptly when aborted and skips the rest', async () => {
    const cwd = tmp();
    const ac = new AbortController();
    const started = Date.now();
    const p = runChecks({
      cwd,
      logDir: join(tmp(), 'logs'),
      headSha: 'abc',
      signal: ac.signal,
      checks: [
        { name: 'slow', run: 'sleep 30' },
        { name: 'never', run: 'echo hi' },
      ],
    });
    setTimeout(() => ac.abort(), 100);
    const res = await p;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(res.passed).toBe(false);
    expect(res.results.map((r) => r.name)).toEqual(['slow']);
  });

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

describe('runChecks cwd safety and errors', () => {
  it('rejects a symlinked cwd pointing outside the worktree', async () => {
    const cwd = tmp();
    const outside = tmp();
    symlinkSync(outside, join(cwd, 'external'));
    const marker = join(outside, 'ran');
    const res = await runChecks({
      cwd,
      logDir: tmp(),
      headSha: 'x',
      checks: [{ name: 'link', run: 'touch ran', cwd: 'external' }],
    });
    expect(existsSync(marker)).toBe(false);
    expect(res.results[0]?.exitCode).toBeNull();
    expect(res.passed).toBe(false);
  });

  it('records a missing cwd as a failure and keeps going', async () => {
    const logDir = tmp();
    const res = await runChecks({
      cwd: tmp(),
      logDir,
      headSha: 'x',
      checks: [
        { name: 'missing', run: 'true', cwd: 'nope' },
        { name: 'fine', run: 'true' },
      ],
    });
    expect(res.results).toHaveLength(2);
    expect(res.results[0]?.exitCode).toBeNull();
    expect(res.results[1]?.exitCode).toBe(0);
    expect(res.passed).toBe(false);
    expect(readFileSync(join(logDir, 'missing.log'), 'utf8').length).toBeGreaterThan(0);
  });

  it('records a rejecting runShell as a failure and keeps going', async () => {
    const logDir = tmp();
    let n = 0;
    const runShell = vi.fn(() =>
      ++n === 1
        ? Promise.reject(new Error('spawn boom'))
        : Promise.resolve({ code: 0, signal: null, durationMs: 1, timedOut: false }),
    );
    const res = await runChecks({
      cwd: tmp(),
      logDir,
      headSha: 'x',
      runShell,
      checks: [
        { name: 'a', run: 'x' },
        { name: 'b', run: 'y' },
      ],
    });
    expect(res.results.map((r) => r.exitCode)).toEqual([null, 0]);
    expect(readFileSync(join(logDir, 'a.log'), 'utf8')).toContain('spawn boom');
    expect(res.passed).toBe(false);
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
