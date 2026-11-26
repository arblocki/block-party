import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { runSetup } from './setup.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bp-setup-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('runSetup logs output and reports exit status', async () => {
  const logPath = join(dir, 'setup.log');
  const r = await runSetup({ cwd: dir, command: 'echo installing', logPath, timeoutMs: 5000 });
  expect(r.code).toBe(0);
  expect(r.timedOut).toBe(false);
  expect(readFileSync(logPath, 'utf8')).toContain('installing');
});

it('runSetup reports a timeout', async () => {
  const r = await runSetup({
    cwd: dir,
    command: 'sleep 30',
    logPath: join(dir, 's.log'),
    timeoutMs: 200,
  });
  expect(r.timedOut).toBe(true);
});
