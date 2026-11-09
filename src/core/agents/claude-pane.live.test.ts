import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanHerdrEnv } from '../terminal/herdr-client.js';
import { createHerdrHost } from '../terminal/herdr.js';
import { buildAgents, buildSettings, hookArgv } from './claude-config.js';
import { createPaneClaude } from './claude-pane.js';
import { HookWatcher } from './hook-events.js';

describe.skipIf(!process.env.BP_LIVE)('pane claude live (session bp-test)', () => {
  it('writes report.json', { timeout: 180_000 }, async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bp-live-')));
    const prev = process.env.BLOCK_PARTY_HOME;
    process.env.BLOCK_PARTY_HOME = home;
    const cwd = path.join(home, 'worktrees', 'o__r', 'live1');
    fs.mkdirSync(cwd, { recursive: true });
    const git = (...a: string[]) => execFileSync('git', a, { cwd, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git(
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@e.com',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'i',
    );
    const runDir = path.join(home, 'runs', 'live1');
    fs.mkdirSync(runDir, { recursive: true });
    const eventsPath = path.join(runDir, 'events.jsonl');
    const settingsPath = path.join(runDir, 'settings.json');
    const agentsPath = path.join(runDir, 'agents.json');
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(
        buildSettings({ hookArgv: hookArgv(), eventsPath, permissionMode: 'acceptEdits' }),
      ),
    );
    fs.writeFileSync(agentsPath, JSON.stringify(buildAgents([])));
    const reportPath = path.join(cwd, 'report.json');
    const host = createHerdrHost({ session: 'bp-test' });
    const adapter = createPaneClaude({
      host,
      claudeBin: 'claude',
      watcherFactory: (p, off) => new HookWatcher(p, { startOffset: off }),
    });
    try {
      const { session, outcome } = await adapter.start({
        runId: 'live1',
        cwd,
        runDir,
        prompt:
          'Write a file report.json containing {"status":"done"} in the current directory, then stop.',
        model: 'haiku',
        agentsPath,
        settingsPath,
        eventsPath,
        reportPath,
        permissionMode: 'acceptEdits',
        allowedTools: [],
        disallowedTools: [],
        timeoutMs: 120_000,
      });
      expect(outcome.kind).toBe('report');
      await adapter.stop(session, { force: true });
    } finally {
      if (prev === undefined) delete process.env.BLOCK_PARTY_HOME;
      else process.env.BLOCK_PARTY_HOME = prev;
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
