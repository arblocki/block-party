/**
 * Minimal herdr socket client: newline-delimited JSON request/response plus
 * a dedicated connection for `events.subscribe`. Spike code, no retries.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export interface HerdrErrorBody {
  code: string;
  message: string;
}

export class HerdrError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
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

/** Split a stream into parsed JSON lines. */
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
      const parsed: unknown = JSON.parse(line);
      if (isObject(parsed)) onLine(parsed);
    }
  });
}

/** One-shot request on a fresh connection. Returns the `result` object. */
export function request(
  socketPath: string,
  method: string,
  params: JsonObject = {},
  timeoutMs = 10_000,
): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    const id = `bp:${method}:${Date.now()}`;
    const sock = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`timeout waiting for ${method}`));
    }, timeoutMs);
    lineReader(sock, (msg) => {
      if (msg.id !== id) return;
      clearTimeout(timer);
      sock.end();
      const err = msg.error;
      if (isObject(err)) {
        reject(new HerdrError(String(err.code), String(err.message)));
      } else if (isObject(msg.result)) {
        resolve(msg.result);
      } else {
        reject(new Error(`unexpected response: ${JSON.stringify(msg)}`));
      }
    });
    sock.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    sock.on('connect', () => sock.write(JSON.stringify({ id, method, params }) + '\n'));
  });
}

export interface Subscription {
  close(): void;
}

/**
 * Subscribe to events. Entries are a type string or a full subscription object (e.g.
 * `{ type: 'pane.agent_status_changed', pane_id }`, which requires a pane_id). Each pushed line
 * is passed to `onEvent` as-is. Resolves once the subscription ack arrives.
 */
export function subscribe(
  socketPath: string,
  types: (string | JsonObject)[],
  onEvent: (msg: JsonObject) => void,
): Promise<Subscription> {
  return new Promise((resolve, reject) => {
    const id = `bp:sub:${Date.now()}`;
    const sock = net.createConnection(socketPath);
    let acked = false;
    lineReader(sock, (msg) => {
      if (msg.id === id && !acked) {
        acked = true;
        if (isObject(msg.error))
          reject(new HerdrError(String(msg.error.code), String(msg.error.message)));
        else resolve({ close: () => sock.destroy() });
        return;
      }
      onEvent(msg);
    });
    sock.on('error', reject);
    sock.on('connect', () =>
      sock.write(
        JSON.stringify({
          id,
          method: 'events.subscribe',
          params: { subscriptions: types.map((t) => (typeof t === 'string' ? { type: t } : t)) },
        }) + '\n',
      ),
    );
  });
}

/** Convenience wrapper bound to one socket. */
export class HerdrClient {
  constructor(readonly socketPath: string) {}

  static forSession(session: string): HerdrClient {
    return new HerdrClient(sessionSocketPath(session));
  }

  call(method: string, params: JsonObject = {}, timeoutMs?: number): Promise<JsonObject> {
    return request(this.socketPath, method, params, timeoutMs);
  }

  ping(): Promise<JsonObject> {
    return this.call('ping');
  }

  subscribe(
    types: (string | JsonObject)[],
    onEvent: (msg: JsonObject) => void,
  ): Promise<Subscription> {
    return subscribe(this.socketPath, types, onEvent);
  }
}

/** Environment for spawning herdr from inside a herdr pane: HERDR_* makes the CLI refuse ("nested herdr"). */
export function cleanHerdrEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('HERDR_') || k === 'TERM_PROGRAM' || k === 'SSH_AUTH_SOCK') continue;
    out[k] = v;
  }
  return out;
}

/**
 * Ping the session socket; if nobody answers, start a headless server for that session
 * (`herdr --session <name> server`, detached) and wait for the socket. The CLI itself never
 * auto-starts a server (`server_not_running`), so the caller has to.
 * Returns true when this call started the server.
 */
export async function ensureServer(session: string, timeoutMs = 8_000): Promise<boolean> {
  const sock = sessionSocketPath(session);
  try {
    await request(sock, 'ping', {}, 1_000);
    return false;
  } catch {
    // not running
  }
  const args = session === 'default' ? ['server'] : ['--session', session, 'server'];
  spawn('herdr', args, { detached: true, stdio: 'ignore', env: cleanHerdrEnv() }).unref();
  const start = Date.now();
  for (;;) {
    try {
      await request(sock, 'ping', {}, 1_000);
      return true;
    } catch {
      if (Date.now() - start > timeoutMs)
        throw new Error(`herdr server for session ${session} did not come up`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}
