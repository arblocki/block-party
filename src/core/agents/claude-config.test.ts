import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HOOK_EVENT_NAMES,
  buildAgents,
  buildSettings,
  hookArgv,
  implementerPermissions,
  shellQuote,
} from './claude-config.js';

describe('buildAgents', () => {
  it('builds definitions and restricts the explorer to read-only tools', () => {
    const agents = buildAgents([
      { name: 'implementer', model: 'sonnet' },
      { name: 'test-writer', model: 'haiku' },
      { name: 'explorer', model: 'haiku' },
    ]);
    expect(Object.keys(agents)).toEqual(['implementer', 'test-writer', 'explorer']);
    expect(agents.explorer?.tools).toEqual(['Read', 'Glob', 'Grep']);
    expect(agents.implementer?.tools).toBeUndefined();
    expect(agents.implementer?.model).toBe('sonnet');
    for (const a of Object.values(agents)) {
      expect(a.description).not.toBe('');
      expect(a.prompt).toMatch(/never touch anything else/);
    }
  });

  it('honors readOnly', () => {
    const agents = buildAgents([{ name: 'test-writer', model: 'haiku', readOnly: true }]);
    expect(agents['test-writer']?.tools).toEqual(['Read', 'Glob', 'Grep']);
  });
});

describe('buildSettings', () => {
  it('registers a command hook for each event and sets the permission mode', () => {
    const s = buildSettings({
      hookArgv: ['/usr/bin/node', '/x/cli.js', 'hook'],
      eventsPath: '/runs/r1/events.jsonl',
      permissionMode: 'acceptEdits',
    });
    expect(Object.keys(s.hooks)).toEqual([...HOOK_EVENT_NAMES]);
    expect(s.permissions.defaultMode).toBe('acceptEdits');
    expect(s.hooks.Stop?.[0]?.hooks[0]).toMatchObject({
      type: 'command',
      command: `'/usr/bin/node' '/x/cli.js' 'hook' '/runs/r1/events.jsonl'`,
    });
  });

  it('quotes paths with spaces and single quotes', () => {
    expect(shellQuote(`/a b/it's`)).toBe(`'/a b/it'\\''s'`);
    const s = buildSettings({
      hookArgv: ['node', 'hook'],
      eventsPath: `/runs/it's a dir/events.jsonl`,
      permissionMode: 'default',
    });
    const cmd = s.hooks.Stop?.[0]?.hooks[0]?.command ?? '';
    const out = spawnSync('sh', ['-c', `printf '%s\\n' ${cmd.replace(/^'node' 'hook'/, '')}`], {
      encoding: 'utf8',
    });
    expect(out.stdout).toBe(`/runs/it's a dir/events.jsonl\n`);
  });
});

describe('implementerPermissions', () => {
  it('lists the specific check commands and denies dangerous commands', () => {
    const p = implementerPermissions(['pnpm test', 'pnpm lint']);
    expect(p.allowedTools).toContain('Bash(pnpm test:*)');
    expect(p.allowedTools).toContain('Bash(pnpm lint:*)');
    expect(p.allowedTools).toContain('Bash(pnpm install --frozen-lockfile)');
    expect(p.allowedTools).not.toContain('Bash(pnpm:*)');
    for (const d of ['git push', 'curl', 'wget', 'rm -rf', 'pnpm add', 'npm install', 'gh']) {
      expect(p.disallowedTools).toContain(`Bash(${d}:*)`);
    }
  });
});

describe('hookArgv', () => {
  it('runs the hook subcommand and appends the event line', () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'bp-hookargv-')));
    const dir = join(home, 'runs', 'r1');
    mkdirSync(dir, { recursive: true });
    const eventsPath = join(dir, 'events.jsonl');
    // Under vitest process.execArgv has no tsx loader, so pass it explicitly. From dist/ the
    // defaults (plain node, compiled .js entry) need no loader.
    const argv = hookArgv({ execArgv: ['--import', 'tsx'] });
    expect(argv.at(-1)).toBe('hook');
    expect(argv.at(-2)).toMatch(/src\/cli\/index\.ts$/);
    const [cmd, ...args] = argv;
    const r = spawnSync(cmd as string, [...args, eventsPath], {
      input: JSON.stringify({ hook_event_name: 'Stop', session_id: 's1' }),
      env: { ...process.env, BLOCK_PARTY_HOME: home },
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    const lines = readFileSync(eventsPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      payload: { hook_event_name: 'Stop', session_id: 's1' },
    });
  });
});
