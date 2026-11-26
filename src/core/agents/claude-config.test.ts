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
  plannerPermissions,
  shellQuote,
  shellRules,
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

  it('gives subagents that can run commands the shell rules', () => {
    const rules = shellRules(['Read', 'Bash(pnpm test:*)', 'Bash(pnpm format:*)']);
    const agents = buildAgents(
      [
        { name: 'implementer', model: 'sonnet' },
        { name: 'explorer', model: 'haiku' },
      ],
      rules,
    );
    expect(agents.implementer?.prompt).toContain(rules);
    expect(agents.explorer?.prompt).not.toContain(rules);
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
    for (const c of [
      'node',
      'git show',
      'git rev-parse',
      'ls',
      'cat',
      'grep',
      'find',
      'head',
      'tail',
      'wc',
    ]) {
      expect(p.allowedTools).toContain(`Bash(${c}:*)`);
    }
    for (const d of ['git push', 'curl', 'wget', 'rm -rf', 'pnpm add', 'npm install', 'gh']) {
      expect(p.disallowedTools).toContain(`Bash(${d}:*)`);
    }
  });
});

describe('plannerPermissions', () => {
  const p = plannerPermissions('/data/runs/r1/plans/v2.md', '/data/runs/r1/report.json');

  it('allows writes only to the plan and the report, with absolute-path rules', () => {
    const writes = p.allowedTools.filter((t) => /^(Write|Edit)\(/.test(t));
    expect(writes.sort()).toEqual([
      'Edit(//data/runs/r1/plans/v2.md)',
      'Edit(//data/runs/r1/report.json)',
      'Write(//data/runs/r1/plans/v2.md)',
      'Write(//data/runs/r1/report.json)',
    ]);
    expect(p.allowedTools).not.toContain('Write');
    expect(p.allowedTools).not.toContain('Edit');
  });

  it('allows reading and the read-only commands, but not committing or running code', () => {
    for (const t of [
      'Read',
      'Glob',
      'Grep',
      'Bash(git status:*)',
      'Bash(git diff:*)',
      'Bash(ls:*)',
    ]) {
      expect(p.allowedTools).toContain(t);
    }
    for (const t of ['Bash(git add:*)', 'Bash(git commit:*)', 'Bash(node:*)']) {
      expect(p.allowedTools).not.toContain(t);
    }
  });

  it('disallows everything the implementer is denied, plus commits', () => {
    for (const d of implementerPermissions([]).disallowedTools) {
      expect(p.disallowedTools).toContain(d);
    }
    expect(p.disallowedTools).toContain('Bash(git add:*)');
    expect(p.disallowedTools).toContain('Bash(git commit:*)');
  });
});

describe('implementerPermissions fix commands', () => {
  it('allows the checks.fix commands too', () => {
    const p = implementerPermissions(['pnpm test'], ['pnpm format', ' ']);
    expect(p.allowedTools).toContain('Bash(pnpm format:*)');
    expect(p.allowedTools).not.toContain('Bash(:*)');
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

describe('shellRules', () => {
  it('lists the approved command prefixes and forbids chaining', () => {
    const r = shellRules(['Read', 'Bash(pnpm test:*)', 'Bash(pnpm install --frozen-lockfile)']);
    expect(r).toContain('`pnpm test`, `pnpm install --frozen-lockfile`');
    expect(r).toMatch(/only if every command in it is on that list/);
    expect(r).not.toContain('Read');
  });
});
