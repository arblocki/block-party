import { fileURLToPath } from 'node:url';

export type SubagentName = 'implementer' | 'test-writer' | 'explorer';

export interface SubagentSpec {
  name: SubagentName;
  model: string;
  readOnly?: boolean;
}

export interface AgentDef {
  description: string;
  prompt: string;
  model: string;
  tools?: string[];
}

const OWNERSHIP =
  'Only edit the files or modules the driver explicitly assigned to you; never touch anything else, ' +
  'because other subagents may be editing in parallel. Do not push, open PRs, or rewrite history.';

const ROLES: Record<SubagentName, { description: string; prompt: string }> = {
  implementer: {
    description: 'Implements a bounded piece of the plan in the files assigned to it',
    prompt: `You implement one bounded piece of an approved plan, exactly as instructed by the driver. ${OWNERSHIP} Reply with a short summary of what you changed.`,
  },
  'test-writer': {
    description: 'Writes or adjusts tests for the files and behavior assigned to it',
    prompt: `You write tests for the behavior the driver describes. ${OWNERSHIP} Reply with a short summary of the tests you added.`,
  },
  explorer: {
    description: 'Read-only codebase exploration: finds code and answers questions about it',
    prompt: `You explore the codebase and answer the driver's question concisely, citing file paths. You are read-only and must not edit any file. ${OWNERSHIP}`,
  },
};

const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'];

/** The object serialized to `agents.json` for `claude --agents`. */
export function buildAgents(subagents: SubagentSpec[]): Record<string, AgentDef> {
  const out: Record<string, AgentDef> = {};
  for (const s of subagents) {
    const role = ROLES[s.name];
    const def: AgentDef = { description: role.description, prompt: role.prompt, model: s.model };
    if (s.name === 'explorer' || s.readOnly) def.tools = [...READ_ONLY_TOOLS];
    out[s.name] = def;
  }
  return out;
}

export const HOOK_EVENT_NAMES = [
  'SessionStart',
  'UserPromptSubmit',
  'PostToolUse',
  'SubagentStop',
  'Notification',
  'Stop',
  'SessionEnd',
] as const;

/** POSIX single-quote escaping for one shell word. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface Settings {
  hooks: Record<string, { hooks: { type: 'command'; command: string; timeout: number }[] }[]>;
  permissions: { defaultMode: string };
}

/** The object serialized to `settings.json` for `claude --settings`. */
export function buildSettings(opts: {
  hookArgv: string[];
  eventsPath: string;
  permissionMode: string;
}): Settings {
  const command = [...opts.hookArgv, opts.eventsPath].map(shellQuote).join(' ');
  const hooks: Settings['hooks'] = {};
  for (const ev of HOOK_EVENT_NAMES) {
    hooks[ev] = [{ hooks: [{ type: 'command', command, timeout: 10 }] }];
  }
  return { hooks, permissions: { defaultMode: opts.permissionMode } };
}

/**
 * Permission profile for the implementer (docs/spikes/claude-headless.md), with the specific
 * check commands allowed instead of `Bash(pnpm:*)` (which would allow `pnpm dlx`/`pnpm exec`).
 */
export function implementerPermissions(checkCommands: string[]): {
  allowedTools: string[];
  disallowedTools: string[];
} {
  const checks = checkCommands.map((c) => c.trim()).filter((c) => c.length > 0);
  const allowedTools = [
    'Read',
    'Edit',
    'Write',
    'Glob',
    'Grep',
    'Bash(git status:*)',
    'Bash(git diff:*)',
    'Bash(git log:*)',
    'Bash(git add:*)',
    'Bash(git commit:*)',
    'Bash(pnpm install --frozen-lockfile)',
    ...checks.map((c) => `Bash(${c}:*)`),
  ];
  const disallowedTools = [
    'Bash(git push:*)',
    'Bash(curl:*)',
    'Bash(wget:*)',
    'Bash(rm -rf:*)',
    'Bash(pnpm add:*)',
    'Bash(npm install:*)',
    'Bash(gh:*)',
  ];
  return { allowedTools: [...new Set(allowedTools)], disallowedTools };
}

export interface HookArgvOptions {
  execPath?: string;
  execArgv?: string[];
  /** Absolute path of the CLI entry; defaults to the entry next to this build. */
  entry?: string;
}

/**
 * argv that runs this build's `block-party hook` subcommand (it ends with `hook`; the
 * events path is appended by buildSettings).
 *
 * The entry is derived from this module's own URL, not process.argv[1] (which is the test
 * runner under vitest). From `src/` (tsx) this module is `.ts` so the entry is
 * `src/cli/index.ts` and `process.execArgv` carries tsx's loader flags. From `dist/` this
 * module is `.js`, the entry is `dist/cli/index.js`, and plain `node` needs no loader.
 */
export function hookArgv(opts: HookArgvOptions = {}): string[] {
  const ext = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const entry = opts.entry ?? fileURLToPath(new URL(`../../cli/index.${ext}`, import.meta.url));
  return [opts.execPath ?? process.execPath, ...(opts.execArgv ?? process.execArgv), entry, 'hook'];
}
