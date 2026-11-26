import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { cleanHerdrEnv } from './herdr-client.js';
import { createHerdrHost } from './herdr.js';

describe.skipIf(!process.env.BP_LIVE)('herdr live (session bp-test)', () => {
  it('opens, reads, closes a pane', { timeout: 60_000 }, async () => {
    const host = createHerdrHost({ session: 'bp-test' });
    const cwd = fs.realpathSync(os.tmpdir());
    try {
      const pane = await host.open({
        label: 'bp-live-test',
        cwd,
        argv: ['sh', '-c', 'echo hi; sleep 5'],
      });
      expect(await host.isAlive(pane)).toBe(true);
      let text = '';
      for (let i = 0; i < 20 && !text.includes('hi'); i++) {
        await new Promise((r) => setTimeout(r, 300));
        text = await host.read(pane, 20);
      }
      expect(text).toContain('hi');
      expect(['idle', 'working', 'blocked', 'unknown']).toContain(await host.agentState(pane));
      await host.close(pane);
      expect(await host.isAlive(pane)).toBe(false);
    } finally {
      try {
        execFileSync('herdr', ['--session', 'bp-test', 'server', 'stop'], {
          env: cleanHerdrEnv(),
          stdio: 'ignore',
        });
      } catch {
        // already stopped
      }
    }
  });
});
