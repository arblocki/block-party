import { realpath } from 'node:fs/promises';
import {
  HerdrClient,
  HerdrError,
  ensureServer,
  type HerdrCaller,
  type JsonObject,
} from './herdr-client.js';
import type { AgentState, PaneRef, TerminalHost } from './types.js';

export interface HerdrHostOptions {
  session?: string;
  /** Override the session socket (tests). */
  socketPath?: string;
  /** Injected client; when given, `ensureServer` is skipped. */
  client?: HerdrCaller;
}

interface RawPane {
  paneId: string;
  terminalId: string;
  label: string;
  cwd: string;
}

function asObj(v: unknown): JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as JsonObject) : {};
}

async function real(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

function toState(v: unknown): AgentState {
  return v === 'idle' || v === 'working' || v === 'blocked' ? v : 'unknown';
}

/** The herdr session block-party's panes live in unless told otherwise. */
export const DEFAULT_HERDR_SESSION = 'block-party';

export function createHerdrHost(opts: HerdrHostOptions = {}): TerminalHost {
  const session = opts.session ?? DEFAULT_HERDR_SESSION;
  const client: HerdrCaller =
    opts.client ??
    (opts.socketPath ? new HerdrClient(opts.socketPath) : HerdrClient.forSession(session));
  // In-memory only: label\0cwd -> pane id. Lookups still go through pane.list every time.
  const cache = new Map<string, string>();

  async function call(method: string, params: JsonObject = {}): Promise<JsonObject> {
    try {
      return await client.call(method, params);
    } catch (e) {
      if (e instanceof HerdrError && e.code === 'server_not_running') cache.clear();
      throw e;
    }
  }

  async function panes(): Promise<RawPane[]> {
    const r = await call('pane.list');
    const arr = Array.isArray(r.panes) ? r.panes : [];
    const out: RawPane[] = [];
    for (const p of arr) {
      const o = asObj(p);
      if (typeof o.pane_id !== 'string') continue;
      out.push({
        paneId: o.pane_id,
        terminalId: typeof o.terminal_id === 'string' ? o.terminal_id : '',
        label: typeof o.label === 'string' ? o.label : '',
        cwd: typeof o.cwd === 'string' ? o.cwd : '',
      });
    }
    return out;
  }

  /** Find a pane by label + realpath(cwd). Returns undefined if absent or server down. */
  async function resolve(pane: PaneRef): Promise<string | undefined> {
    if (pane.session !== session)
      throw new HerdrError(
        'wrong_session',
        `pane belongs to session ${pane.session}, host is ${session}`,
      );
    let all: RawPane[];
    try {
      all = await panes();
    } catch (e) {
      if (e instanceof HerdrError && e.code === 'server_not_running') return undefined;
      throw e;
    }
    const want = await real(pane.cwd);
    const key = `${pane.label}\0${want}`;
    const cached = cache.get(key);
    let found: RawPane | undefined;
    for (const p of all) {
      if (p.label !== pane.label) continue;
      if ((await real(p.cwd)) !== want) continue;
      if (!found || p.paneId === cached) found = p;
    }
    if (found) cache.set(key, found.paneId);
    else cache.delete(key);
    return found?.paneId;
  }

  async function need(pane: PaneRef): Promise<string> {
    const id = await resolve(pane);
    if (!id)
      throw new HerdrError('pane_not_found', `no pane labelled ${pane.label} in ${pane.cwd}`);
    return id;
  }

  return {
    async open({ label, cwd, argv, env }) {
      if (!opts.client) await ensureServer(session, { socketPath: opts.socketPath });
      const ws = await call('workspace.create', { cwd, label });
      const tabId = asObj(ws.tab).tab_id;
      if (typeof tabId !== 'string')
        throw new HerdrError('bad_response', 'workspace.create returned no tab_id');
      const root: JsonObject = { type: 'pane', cwd, label, command: argv };
      if (env) root.env = env;
      const applied = await call('layout.apply', { tab_id: tabId, root });
      const paneId = asObj(asObj(applied.layout).root).pane_id;
      const ref: PaneRef = { session, label, cwd: await real(cwd) };
      if (typeof paneId === 'string') cache.set(`${label}\0${ref.cwd}`, paneId);
      return ref;
    },

    async sendText(pane, text, o) {
      const id = await need(pane);
      await call('pane.send_input', { pane_id: id, text, keys: o?.submit ? ['Enter'] : [] });
    },

    async sendKeys(pane, keys) {
      const id = await need(pane);
      await call('pane.send_keys', { pane_id: id, keys });
    },

    async read(pane, lines = 40) {
      const id = await need(pane);
      const r = await call('pane.read', { pane_id: id, source: 'recent', lines });
      const text = asObj(r.read ?? r).text;
      return typeof text === 'string' ? text : '';
    },

    async agentState(pane) {
      const id = await need(pane);
      const r = await call('pane.get', { pane_id: id });
      return toState(asObj(r.pane).agent_status);
    },

    async isAlive(pane) {
      return (await resolve(pane)) !== undefined;
    },

    async close(pane) {
      const id = await resolve(pane);
      if (!id) return;
      await call('pane.close', { pane_id: id });
      cache.delete(`${pane.label}\0${await real(pane.cwd)}`);
    },

    attachCommand(pane) {
      return `herdr --session ${pane.session}  # workspace: ${pane.label}`;
    },

    // `herdr terminal attach` direct-attaches one server-owned terminal: no sidebar, no other
    // panes or workspaces, and no way to create new ones. (`herdr --session` would attach the
    // whole shared session, and `agent attach` refuses a pane herdr hasn't detected an agent
    // in.) Only one writable client owns a terminal, so a second attach exits with an error.
    async attachArgv(pane) {
      const id = await need(pane);
      const found = (await panes()).find((p) => p.paneId === id);
      if (!found?.terminalId) {
        throw new HerdrError('pane_not_found', `pane ${pane.label} has no terminal id`);
      }
      return ['herdr', '--session', pane.session, 'terminal', 'attach', found.terminalId];
    },

    async list() {
      const out: PaneRef[] = [];
      for (const p of await panes()) if (p.label) out.push({ session, label: p.label, cwd: p.cwd });
      return out;
    },
  };
}
