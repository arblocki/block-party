/** Shared helpers for the herdr + interactive Claude spike scripts. */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HerdrClient, ensureServer, type JsonObject } from './herdr-client.js';

export const SESSION = process.env.HERDR_SPIKE_SESSION ?? 'bp-spike';
export const SCRATCH =
  process.env.HERDR_SPIKE_SCRATCH ??
  '/private/tmp/claude-501/-Users-blocki-repos-block-party/0e97487b-bddc-4843-b5a5-3686d42c343b/scratchpad/spikes/herdr-claude';
export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const client = HerdrClient.forSession(SESSION);
// Isolated named session; started headless on demand. Stop with: herdr --session bp-spike server stop
if (SESSION === 'default')
  throw new Error('refusing to run spike scripts against the default herdr session');
export const startedServer = await ensureServer(SESSION);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const log = (...a: unknown[]) =>
  console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a);

export function obj(v: unknown): JsonObject {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('not an object');
  return v as JsonObject;
}
export const str = (v: unknown): string => String(v);

/** Throwaway git repo with one commit. */
export function makeRepo(name: string): string {
  const dir = path.join(SCRATCH, 'repos', name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), '# throwaway\n');
  git('add', '.');
  git('-c', 'user.name=spike', '-c', 'user.email=spike@example.com', 'commit', '-q', '-m', 'init');
  return fs.realpathSync(dir);
}

const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PostToolUse',
  'SubagentStop',
  'Notification',
  'Stop',
  'SessionEnd',
];

/** Write a per-run settings.json that registers the event-logging hooks. */
export function writeRunSettings(
  runDir: string,
  extra: JsonObject = {},
): { settings: string; events: string } {
  fs.mkdirSync(runDir, { recursive: true });
  const events = path.join(runDir, 'events.jsonl');
  const hook = `node ${path.join(HERE, 'hook.js')} ${events}`;
  const hooks: JsonObject = {};
  for (const ev of HOOK_EVENTS) {
    hooks[ev] = [{ hooks: [{ type: 'command', command: hook, timeout: 10 }] }];
  }
  const settings = path.join(runDir, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ hooks, ...extra }, null, 2));
  return { settings, events };
}

export const HELPER_AGENTS = JSON.stringify({
  helper: {
    description: 'Creates small files on request',
    prompt:
      'You create exactly the file you are asked to create, then reply with one short sentence.',
    model: 'haiku',
  },
});

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface Launched {
  workspaceId: string;
  tabId: string;
  paneId: string;
}

/**
 * Launch a command directly (no interactive shell) in a new workspace. workspace.create makes a
 * shell tab; layout.apply with that tab_id replaces it with a single pane running `argv`.
 */
export async function launchInWorkspace(
  label: string,
  cwd: string,
  argv: string[],
): Promise<Launched> {
  const ws = obj(await client.call('workspace.create', { cwd, label }));
  const workspaceId = str(obj(ws.workspace).workspace_id);
  const applied = obj(
    await client.call('layout.apply', {
      tab_id: str(obj(ws.tab).tab_id),
      root: { type: 'pane', cwd, label, command: argv },
    }),
  );
  const layout = obj(applied.layout);
  return { workspaceId, tabId: str(layout.tab_id), paneId: str(obj(layout.root).pane_id) };
}

export function readEvents(file: string): JsonObject[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => obj(JSON.parse(l)));
}

export async function waitFor<T>(
  what: string,
  fn: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs: number,
  everyMs = 500,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(everyMs);
  }
}

export async function readPane(paneId: string, lines = 40): Promise<string> {
  const r = obj(await client.call('pane.read', { pane_id: paneId, source: 'recent', lines }));
  return str(obj(r.read ?? r).text);
}

/**
 * First run in a directory shows "Do you trust this folder?" (default option is "No, exit").
 * Poll until either the dialog or the first hook event shows up; if the dialog, pick "Yes".
 * Returns true when the dialog was answered.
 */
export async function acceptTrustDialog(paneId: string, eventsFile: string): Promise<boolean> {
  const seen = await waitFor(
    'trust dialog or first hook event',
    async () => {
      if (readEvents(eventsFile).length > 0) return 'none';
      return (await readPane(paneId, 30)).includes('Yes, I trust this folder')
        ? 'dialog'
        : undefined;
    },
    30_000,
    250,
  );
  if (seen !== 'dialog') return false;
  const st = obj(obj(await client.call('pane.get', { pane_id: paneId })).pane).agent_status;
  log('trust dialog shown; herdr agent_status =', st);
  await client.call('pane.send_keys', { pane_id: paneId, keys: ['Down', 'Enter'] });
  return true;
}

export { randomUUID };
