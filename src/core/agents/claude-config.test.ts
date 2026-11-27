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
  const scope = { worktree: '/work/wt', runDir: '/data/runs/r1' };

  it('lists the specific check commands exactly and denies dangerous commands', () => {
    const p = implementerPermissions(['pnpm test', 'pnpm lint']);
    for (const c of ['pnpm test', 'pnpm lint']) {
      expect(p.allowedTools).toContain(`Bash(${c})`);
      expect(p.allowedTools).toContain(`Bash(${c} *)`);
      expect(p.allowedTools).not.toContain(`Bash(${c}:*)`);
    }
    expect(p.allowedTools).toContain('Bash(pnpm install --frozen-lockfile)');
    expect(p.allowedTools).not.toContain('Bash(pnpm:*)');
    for (const c of ['git show', 'git rev-parse', 'ls']) {
      expect(p.allowedTools).toContain(`Bash(${c}:*)`);
    }
    for (const d of [
      'git push',
      'git config',
      'git remote',
      'git reset --hard',
      'git clean',
      'git checkout --',
      'git worktree',
      'curl',
      'wget',
      'rm -rf',
      'pnpm add',
      'npm install',
      'gh',
    ]) {
      expect(p.disallowedTools).toContain(`Bash(${d}:*)`);
    }
  });

  it('allows no command that runs arbitrary programs', () => {
    const p = implementerPermissions(['pnpm test'], [], scope);
    expect(p.allowedTools.filter((t) => /^Bash\((node|find|sh|bash|python|npx)\b/.test(t))).toEqual(
      [],
    );
  });

  it('allows what a normal turn needs without prompts', () => {
    const p = implementerPermissions(['pnpm typecheck', 'pnpm test'], ['pnpm format'], scope);
    expect(p.allowedTools).toEqual(
      expect.arrayContaining([
        'Read(//work/wt/**)',
        'Edit(//work/wt/**)',
        'Read(//data/runs/r1/**)',
        'Bash(git status:*)',
        'Bash(git diff:*)',
        'Bash(git add:*)',
        'Bash(git commit:*)',
        'Bash(pnpm test)',
        'Bash(pnpm typecheck *)',
        'Bash(pnpm format)',
      ]),
    );
    // no rule covers the whole run directory
    expect(p.allowedTools).not.toContain('Edit(//data/runs/r1/**)');
    expect(p.allowedTools).toContain('Edit(//data/runs/r1/report.json)');
    // nothing a turn needs is also denied
    for (const rule of p.allowedTools) expect(p.disallowedTools).not.toContain(rule);
  });

  it('scopes file rules to the worktree and keeps secrets and inputs off limits', () => {
    const p = implementerPermissions([], [], scope);
    expect(p.allowedTools).not.toContain('Read');
    expect(p.allowedTools).not.toContain('Edit');
    expect(p.allowedTools).not.toContain('Write');
    expect(p.disallowedTools).toEqual(
      expect.arrayContaining([
        'Read(~/.ssh/**)',
        'Read(~/.aws/**)',
        'Read(~/.config/gh/**)',
        'Edit(//data/runs/r1/inputs/**)',
      ]),
    );
  });

  it('appends project extras and lets deny win', () => {
    const p = implementerPermissions([], [], {
      ...scope,
      extra: {
        allow: ['Bash(make lint *)', 'Bash(make deploy *)', 'Bash(git push *)'],
        deny: ['Bash(make deploy *)'],
      },
    });
    expect(p.allowedTools).toContain('Bash(make lint *)');
    expect(p.allowedTools).not.toContain('Bash(make deploy *)');
    expect(p.disallowedTools).toContain('Bash(make deploy *)');
    // a project allow that equals a built-in deny is dropped, and the deny stays
    const q = implementerPermissions([], [], {
      ...scope,
      extra: { allow: ['Bash(git push:*)', 'Bash(git remote:*)'] },
    });
    expect(q.allowedTools).not.toContain('Bash(git push:*)');
    expect(q.allowedTools).not.toContain('Bash(git remote:*)');
    expect(q.disallowedTools).toEqual(
      expect.arrayContaining(['Bash(git push:*)', 'Bash(git remote:*)']),
    );
  });

  it('denies the run directory files an agent could use to change its own rules', () => {
    const p = implementerPermissions([], [], scope);
    for (const f of [
      'settings.json',
      'agents.json',
      'run.json',
      'events.jsonl',
      'reviews/**',
      'briefs/**',
      'inputs/**',
    ]) {
      expect(p.disallowedTools).toContain(`Edit(//data/runs/r1/${f})`);
    }
  });

  it('protects every run directory path the pipeline reads back', () => {
    const p = implementerPermissions([], [], scope);
    const edits = p.disallowedTools.filter((t) => t.startsWith('Edit('));
    const covered = (rel: string) =>
      edits.some((t) => {
        const rule = t.slice('Edit(//data/runs/r1/'.length, -1);
        return rule.endsWith('/**') ? rel.startsWith(rule.slice(0, -2)) : rel === rule;
      });
    for (const rel of [
      'inputs/rulings.json',
      'inputs/config.json',
      'inputs/findings-round-1.json',
      'reports/implement-1.json',
      'reviews/round-1/review.json',
      'plans/v1.md',
      'run.json',
      'events.jsonl',
      'run-events.jsonl',
      'settings.json',
      'agents.json',
    ]) {
      expect(covered(rel), rel).toBe(true);
    }
    // the one file the agent writes is not covered
    expect(covered('report.json')).toBe(false);
  });

  it('allows no shell read that bypasses the Read denies', () => {
    const p = implementerPermissions(['pnpm test'], [], scope);
    for (const c of ['cat', 'head', 'tail', 'grep', 'wc', 'find', 'node']) {
      expect(p.allowedTools.some((t) => t.startsWith(`Bash(${c}`))).toBe(false);
    }
  });

  it('denies git diff, log and show writing files with --output', () => {
    const p = implementerPermissions([], [], scope);
    for (const c of ['diff', 'log', 'show']) {
      expect(p.disallowedTools).toContain(`Bash(git ${c} *--ou*)`);
    }
  });

  it('splits compound check commands and allows each part exactly', () => {
    const p = implementerPermissions(['pnpm lint && pnpm test; pnpm build || true'], [], scope);
    for (const c of ['pnpm lint', 'pnpm test', 'pnpm build', 'true']) {
      expect(p.allowedTools).toContain(`Bash(${c})`);
    }
    expect(p.allowedTools.some((t) => t.includes('&&'))).toBe(false);
  });
});

describe('shellRules with exact rules', () => {
  it('names each command once', () => {
    const rules = shellRules(['Bash(pnpm test)', 'Bash(pnpm test *)', 'Bash(git status:*)']);
    expect(rules.match(/`pnpm test`/g)).toHaveLength(1);
    expect(rules).toContain('`git status`');
  });
});

describe('buildSettings sandbox', () => {
  const base = {
    hookArgv: ['x', 'hook'],
    eventsPath: '/e/events.jsonl',
    permissionMode: 'default',
  };

  it('has no sandbox section by default', () => {
    expect(buildSettings(base)).not.toHaveProperty('sandbox');
  });

  it('writes the sandbox settings when asked', () => {
    const s = buildSettings({
      ...base,
      sandbox: { gitDir: '/repo/.git', extraAllowedDomains: ['example.org'] },
    });
    expect(s.sandbox).toEqual({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowWrite: ['/repo/.git'],
        denyRead: ['~/.ssh', '~/.aws', '~/.config/gh', '~/.netrc'],
      },
      network: {
        allowedDomains: [
          'registry.npmjs.org',
          '*.npmjs.org',
          'registry.yarnpkg.com',
          'example.org',
        ],
      },
    });
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

  it('allows reading, and no shell command at all', () => {
    for (const t of ['Read', 'Glob', 'Grep']) expect(p.allowedTools).toContain(t);
    expect(p.allowedTools.filter((t) => t.startsWith('Bash('))).toEqual([]);
  });

  it('denies the run files an agent must not change, but not the plans', () => {
    expect(p.disallowedTools).toContain('Edit(//data/runs/r1/settings.json)');
    expect(p.disallowedTools).toContain('Edit(//data/runs/r1/run.json)');
    expect(p.disallowedTools).not.toContain('Edit(//data/runs/r1/plans/**)');
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
    expect(p.allowedTools).toContain('Bash(pnpm format)');
    expect(p.allowedTools).toContain('Bash(pnpm format *)');
    expect(p.allowedTools).not.toContain('Bash( *)');
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
