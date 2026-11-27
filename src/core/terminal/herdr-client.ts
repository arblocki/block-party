/**
 * Minimal herdr socket client: newline-delimited JSON request/response (one connection per
 * request) plus a dedicated connection for `events.subscribe`. Wire format verified in
 * docs/spikes/herdr-claude.md.
 */
import { agentEnv } from '../agents/env.js';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** `server_not_running`, `timeout`, `connection_closed`, `bad_response`, or a server-sent code. */
export class HerdrError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'HerdrError';
  }
}

/** Socket path for a named session (`default` lives directly in ~/.config/herdr). */
export function sessionSocketPath(session: string): string {
  const base = path.join(os.homedir(), '.config', 'herdr');
  return session === 'default'
    ? path.join(base, 'herdr.sock')
    : path.join(base, 'sessions', session, 'herdr.sock');
}

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Split a stream into parsed JSON object lines. Malformed lines are ignored. */
function lineReader(sock: net.Socket, onLine: (obj: JsonObject) => void): void {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (chunk: string) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (isObject(parsed)) onLine(parsed);
    }
  });
}

function connectError(e: NodeJS.ErrnoException, socketPath: string): HerdrError {
  if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED' || e.code === 'ENOTSOCK')
    return new HerdrError('server_not_running', `no herdr server at ${socketPath} (${e.code})`);
  return new HerdrError(e.code ?? 'socket_error', e.message);
}

let seq = 0;

/** One-shot request on a fresh connection. Returns the `result` object. */
export function request(
  socketPath: string,
  method: string,
  params: JsonObject = {},
  { timeoutMs = 10_000 }: { timeoutMs?: number } = {},
): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    const id = `bp:${method}:${Date.now()}:${seq++}`;
    const sock = net.createConnection(socketPath);
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new HerdrError('timeout', `timeout waiting for ${method}`))),
      timeoutMs,
    );
    lineReader(sock, (msg) => {
      if (msg.id !== id) return;
      const err = msg.error;
      if (isObject(err)) {
        finish(() => reject(new HerdrError(String(err.code), String(err.message))));
      } else if (isObject(msg.result)) {
        const result = msg.result;
        finish(() => resolve(result));
      } else {
        finish(() =>
          reject(new HerdrError('bad_response', `unexpected response: ${JSON.stringify(msg)}`)),
        );
      }
    });
    sock.on('error', (e: NodeJS.ErrnoException) =>
      finish(() => reject(connectError(e, socketPath))),
    );
    sock.on('close', () =>
      finish(() => reject(new HerdrError('connection_closed', `closed before ${method} reply`))),
    );
    sock.on('connect', () => sock.write(JSON.stringify({ id, method, params }) + '\n'));
  });
}

export interface Subscription {
  close(): void;
}

/**
 * Subscribe to events on a dedicated connection. Entries are a type string or a full
 * subscription object (e.g. `{ type: 'pane.agent_status_changed', pane_id }`). Each pushed line is
 * passed to `onEvent` as-is. Resolves once the ack arrives.
 */
export function subscribe(
  socketPath: string,
  events: (string | JsonObject)[],
  onEvent: (msg: JsonObject) => void,
  { timeoutMs = 10_000 }: { timeoutMs?: number } = {},
): Promise<Subscription> {
  return new Promise((resolve, reject) => {
    const id = `bp:sub:${Date.now()}:${seq++}`;
    const sock = net.createConnection(socketPath);
    let acked = false;
    const fail = (e: HerdrError) => {
      if (acked) return;
      acked = true;
      clearTimeout(timer);
      sock.destroy();
      reject(e);
    };
    const timer = setTimeout(
      () => fail(new HerdrError('timeout', 'timeout subscribing')),
      timeoutMs,
    );
    lineReader(sock, (msg) => {
      if (msg.id === id && !acked) {
        if (isObject(msg.error)) {
          fail(new HerdrError(String(msg.error.code), String(msg.error.message)));
        } else {
          acked = true;
          clearTimeout(timer);
          resolve({ close: () => sock.destroy() });
        }
        return;
      }
      onEvent(msg);
    });
    sock.on('error', (e: NodeJS.ErrnoException) => fail(connectError(e, socketPath)));
    sock.on('close', () =>
      fail(new HerdrError('connection_closed', 'closed before subscribe ack')),
    );
    sock.on('connect', () =>
      sock.write(
        JSON.stringify({
          id,
          method: 'events.subscribe',
          params: { subscriptions: events.map((t) => (typeof t === 'string' ? { type: t } : t)) },
        }) + '\n',
      ),
    );
  });
}

/** What the terminal host needs from a client; lets tests inject a fake. */
export interface HerdrCaller {
  readonly socketPath: string;
  call(method: string, params?: JsonObject, opts?: { timeoutMs?: number }): Promise<JsonObject>;
}

export class HerdrClient implements HerdrCaller {
  constructor(readonly socketPath: string) {}

  static forSession(session: string): HerdrClient {
    return new HerdrClient(sessionSocketPath(session));
  }

  call(method: string, params: JsonObject = {}, opts: { timeoutMs?: number } = {}) {
    return request(this.socketPath, method, params, opts);
  }

  subscribe(
    events: (string | JsonObject)[],
    onEvent: (msg: JsonObject) => void,
  ): Promise<Subscription> {
    return subscribe(this.socketPath, events, onEvent);
  }
}

/**
 * Environment for the herdr server block-party starts, which is what its panes inherit (a
 * pane's own `env` is applied on top of it, per herdr's socket API docs, so it cannot remove
 * a variable). It has what an agent gets (`agentEnv`: no tokens or other API keys) and no
 * HERDR_* (which makes the CLI refuse: "nested herdr"), TERM_PROGRAM or SSH_AUTH_SOCK. A
 * server started outside block-party keeps the environment it was started with.
 */
export function cleanHerdrEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = agentEnv(env);
  for (const k of Object.keys(out)) {
    if (k.startsWith('HERDR_') || k === 'TERM_PROGRAM' || k === 'SSH_AUTH_SOCK') delete out[k];
  }
  return out;
}

export type HerdrSpawnFn = (
  command: string,
  args: string[],
  opts: { detached: true; stdio: 'ignore'; env: NodeJS.ProcessEnv },
) => { unref(): void; on?(event: 'error', cb: (e: NodeJS.ErrnoException) => void): unknown };

export interface EnsureServerOptions {
  herdrBin?: string;
  spawnFn?: HerdrSpawnFn;
  timeoutMs?: number;
  /** Override the session socket path (tests). */
  socketPath?: string;
}

/**
 * Ping the session socket; if nobody answers, start a headless server for that session
 * (`herdr --session <name> server`, detached, HERDR_* stripped) and poll until it answers.
 * Returns true when this call started the server.
 */
export async function ensureServer(
  session: string,
  { herdrBin = 'herdr', spawnFn, timeoutMs = 8_000, socketPath }: EnsureServerOptions = {},
): Promise<boolean> {
  const sock = socketPath ?? sessionSocketPath(session);
  const ping = () => request(sock, 'ping', {}, { timeoutMs: 1_000 });
  try {
    await ping();
    return false;
  } catch {
    // not running
  }
  const args = session === 'default' ? ['server'] : ['--session', session, 'server'];
  const doSpawn: HerdrSpawnFn = spawnFn ?? ((c, a, o) => spawn(c, a, o));
  const child = doSpawn(herdrBin, args, {
    detached: true,
    stdio: 'ignore',
    env: cleanHerdrEnv(),
  });
  let spawnError: HerdrError | undefined;
  child.on?.('error', (e) => {
    spawnError = new HerdrError(
      e.code === 'ENOENT' ? 'not_installed' : 'spawn_failed',
      `could not start ${herdrBin}: ${e.message}`,
    );
  });
  child.unref();
  const start = Date.now();
  for (;;) {
    if (spawnError) throw spawnError;
    try {
      await ping();
      return true;
    } catch {
      if (spawnError) throw spawnError;
      if (Date.now() - start > timeoutMs)
        throw new HerdrError(
          'server_not_running',
          `herdr server for session ${session} did not come up`,
        );
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
