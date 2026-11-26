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

/**
 * How to run shell commands without stopping the run: which command prefixes are approved
 * (from an implementer allowlist) and that each Bash call must be a single command, since a
 * chain or pipe needs every part approved. Given to the implementer and its subagents.
 */
export function shellRules(allowedTools: string[]): string {
  const prefixes = allowedTools
    .filter((t) => t.startsWith('Bash(') && t.endsWith(')'))
    .map((t) => `\`${t.slice(5, -1).replace(/:\*$/, '')}\``);
  return (
    'Edit files with the Edit/Write tools, not shell scripts (python/sed/heredocs). ' +
    `Shell commands you may run without approval: ${prefixes.join(', ')}. ` +
    'A chain or pipe (`;`, `&&`, `|`) runs without approval only if every command in it is ' +
    'on that list, so prefer one command per Bash call. Anything else stops the run until a ' +
    'human approves it.'
  );
}

/**
 * The object serialized to `agents.json` for `claude --agents`. `rules` (see shellRules) is
 * appended to the prompt of every subagent that can run commands.
 */
export function buildAgents(subagents: SubagentSpec[], rules?: string): Record<string, AgentDef> {
  const out: Record<string, AgentDef> = {};
  for (const s of subagents) {
    const role = ROLES[s.name];
    const readOnly = s.name === 'explorer' || s.readOnly;
    const prompt = rules && !readOnly ? `${role.prompt} ${rules}` : role.prompt;
    const def: AgentDef = { description: role.description, prompt, model: s.model };
    if (readOnly) def.tools = [...READ_ONLY_TOOLS];
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
/**
 * `checkCommands` are the project's required checks; `fixCommands` its `checks.fix` commands
 * (formatters and the like). Both may be run without approval.
 */
export function implementerPermissions(
  checkCommands: string[],
  fixCommands: string[] = [],
): {
  allowedTools: string[];
  disallowedTools: string[];
} {
  const checks = [...checkCommands, ...fixCommands]
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  // This allowlist is not a sandbox: check commands (and `node`) already run arbitrary repo
  // code. Its job is to keep the agent off the network, away from publishing, and from
  // changing dependencies, and to avoid approval prompts for routine read-only commands.
  const allowedTools = [
    'Read',
    'Edit',
    'Write',
    'Glob',
    'Grep',
    'Bash(git status:*)',
    'Bash(git diff:*)',
    'Bash(git log:*)',
    'Bash(git show:*)',
    'Bash(git rev-parse:*)',
    'Bash(git add:*)',
    'Bash(git commit:*)',
    'Bash(pnpm install --frozen-lockfile)',
    'Bash(node:*)',
    'Bash(ls:*)',
    'Bash(cat:*)',
    'Bash(grep:*)',
    'Bash(find:*)',
    'Bash(head:*)',
    'Bash(tail:*)',
    'Bash(wc:*)',
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

/**
 * Permission profile for the planner: it explores with Read, Glob and Grep, and writes only
 * the plan file and its report. It gets no `Bash(...)` rules: a prefix rule matches any
 * trailing arguments, and `find -exec`, `find -delete` or `git diff --output=<file>` write
 * anywhere. Every shell command therefore asks a human. The rules for those two files use Claude Code's absolute-path form, a
 * leading `//`. Used with permission mode `default`, so anything else that would write asks a
 * human instead of being denied or silently allowed.
 */
export function plannerPermissions(
  planPath: string,
  reportPath: string,
): { allowedTools: string[]; disallowedTools: string[] } {
  const base = implementerPermissions([]);
  const absolute = (p: string) => `//${p.replace(/^\/+/, '')}`;
  const writable = [planPath, reportPath].map(absolute);
  const allowedTools = [
    'Read',
    'Glob',
    'Grep',
    ...writable.flatMap((p) => [`Write(${p})`, `Edit(${p})`]),
  ];
  return {
    allowedTools: [...new Set(allowedTools)],
    disallowedTools: [...base.disallowedTools, 'Bash(git add:*)', 'Bash(git commit:*)'],
  };
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
