import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { JsonObject } from './herdr-client.js';

export type FakeHandler = (params: JsonObject, raw: JsonObject) => JsonObject | Promise<JsonObject>;

export interface FakeHerdr {
  socketPath: string;
  calls: { method: string; params: JsonObject }[];
  /** Script (or replace) the response for a method. Handlers may throw `{code,message}` objects. */
  on(method: string, handler: FakeHandler | JsonObject): void;
  /** Write a raw line to every subscribed connection. */
  push(line: string): void;
  /** Make the next request for `method` hang (never answered). */
  hang(method: string): void;
  /** Send this raw text (e.g. garbage) before answering the next request. */
  garbageBefore(text: string): void;
  close(): Promise<void>;
}

/** Fake herdr: Unix socket server answering scripted responses keyed by method. */
export async function startFakeHerdr(): Promise<FakeHerdr> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-'));
  const socketPath = path.join(dir, 's.sock');
  const handlers = new Map<string, FakeHandler>();
  const hung = new Set<string>();
  const calls: FakeHerdr['calls'] = [];
  const subs = new Set<net.Socket>();
  const conns = new Set<net.Socket>();
  let garbage = '';

  const server = net.createServer((sock) => {
    conns.add(sock);
    sock.on('close', () => {
      conns.delete(sock);
      subs.delete(sock);
    });
    sock.on('error', () => {});
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        void handle(sock, JSON.parse(line) as JsonObject);
      }
    });
  });

  async function handle(sock: net.Socket, msg: JsonObject): Promise<void> {
    const method = String(msg.method);
    const params = (msg.params ?? {}) as JsonObject;
    calls.push({ method, params });
    if (hung.delete(method)) return;
    if (garbage) {
      sock.write(garbage);
      garbage = '';
    }
    if (method === 'events.subscribe') subs.add(sock);
    const h = handlers.get(method);
    try {
      const result = h ? await h(params, msg) : {};
      sock.write(JSON.stringify({ id: msg.id, result }) + '\n');
    } catch (e) {
      const err = e as { code?: string; message?: string };
      sock.write(
        JSON.stringify({
          id: msg.id,
          error: { code: err.code ?? 'internal', message: err.message ?? String(e) },
        }) + '\n',
      );
    }
  }

  await new Promise<void>((r) => server.listen(socketPath, r));

  return {
    socketPath,
    calls,
    on(method, handler) {
      handlers.set(method, typeof handler === 'function' ? handler : () => handler);
    },
    push(line) {
      for (const s of subs) s.write(line + '\n');
    },
    hang: (m) => void hung.add(m),
    garbageBefore: (t) => void (garbage = t),
    async close() {
      for (const c of conns) c.destroy();
      await new Promise<void>((r) => server.close(() => r()));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
