import { accessSync, chmodSync, constants } from 'node:fs';
import { STATUS_CODES, type IncomingMessage, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { Duplex } from 'node:stream';
import type { Hono } from 'hono';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { cleanHerdrEnv } from '../core/terminal/herdr-client.js';
import { DEFAULT_HERDR_SESSION } from '../core/terminal/herdr.js';
import type { PaneRef, TerminalHost } from '../core/terminal/types.js';
import { loadRunState, type RunState } from '../core/run/run-state.js';
import type { RunStore } from '../core/store/runs.js';

/** The slice of a node-pty terminal this endpoint uses. */
export interface PtyLike {
  onData(cb: (data: string) => void): unknown;
  onExit(cb: () => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  /** Stop and restart reading output (flow control for a slow viewer). */
  pause?(): void;
  resume?(): void;
}

export type PtyFactory = (
  file: string,
  args: string[],
  opts: { cols: number; rows: number; cwd: string; env: Record<string, string> },
) => PtyLike;

/** Loads the pty implementation on first use; may reject if the native build is missing. */
export type PtyLoader = () => Promise<PtyFactory>;

/**
 * node-pty 1.1.0 ships a prebuilt `spawn-helper`, and pnpm installs it without the exec bit,
 * so every spawn fails with "posix_spawnp failed". Set the bit before the first spawn; if that
 * can't be done and the file still isn't executable, say what to run.
 */
function fixSpawnHelper(): void {
  let helper: string;
  try {
    const req = createRequire(import.meta.url);
    const dir = req.resolve('node-pty/package.json').replace(/package\.json$/, '');
    helper = `${dir}prebuilds/${process.platform}-${process.arch}/spawn-helper`;
    accessSync(helper);
  } catch {
    return; // Not a prebuilt install (compiled from source, or Windows): nothing to fix.
  }
  try {
    accessSync(helper, constants.X_OK);
    return;
  } catch {
    // fall through to chmod
  }
  try {
    chmodSync(helper, 0o755);
    accessSync(helper, constants.X_OK);
  } catch {
    throw new Error(`node-pty's spawn-helper isn't executable: run chmod +x ${helper}`);
  }
}

export const loadNodePty: PtyLoader = async () => {
  const mod = (await import('node-pty')) as typeof import('node-pty') & {
    default?: typeof import('node-pty');
  };
  const spawn = mod.spawn ?? mod.default?.spawn;
  if (typeof spawn !== 'function') throw new Error('node-pty has no spawn function');
  fixSpawnHelper();
  return (file, args, opts) => spawn(file, args, { name: 'xterm-256color', ...opts });
};

/** One writable viewer per terminal: herdr gives input and resize to a single attached client. */
export const TERMINAL_LIMITS = { perRun: 1, total: 8, idleMs: 30 * 60 * 1000 } as const;
const MIN_SIZE = 1;
const MAX_SIZE = 500;
const DEFAULT_SIZE = { cols: 80, rows: 24 };
/** Messages a client may send while the pty is still starting. */
const MAX_QUEUED = 64;
/** Pause the pty when this much output is waiting to be sent; resume once it drains. */
const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;

export interface TerminalDeps {
  runs: Pick<RunStore, 'getRun'>;
  host: TerminalHost;
  /** The terminal host's session name (default: block-party's herdr session). */
  session?: string;
  loadPty?: PtyLoader;
  loadState?: (runDir: string) => Promise<RunState>;
  env?: () => NodeJS.ProcessEnv;
  limits?: { perRun?: number; total?: number; idleMs?: number };
}

export interface TerminalEndpoint {
  /** Registers the guarded route. Call after the token guard so it is covered. */
  register(app: Hono): void;
  /** Handles an HTTP upgrade request; false when the path is not the terminal endpoint. */
  upgrade(app: Hono, req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  /** Closes every open terminal (viewers only; the agents keep running). */
  closeAll(): void;
}

const TERMINAL_PATH = /^\/api\/runs\/[^/?]+\/terminal(?:\?.*)?$/;
const RUN_ID_HEADER = 'x-terminal-run-id';

/** A `{ type: 'resize', cols, rows }` frame: the parsed size, 'invalid', or null if not one. */
function parseResize(text: string): { cols: number; rows: number } | 'invalid' | null {
  if (!text.startsWith('{')) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || (v as { type?: unknown }).type !== 'resize') {
    return null;
  }
  const { cols, rows } = v as { cols?: unknown; rows?: unknown };
  const ok = (n: unknown): n is number =>
    typeof n === 'number' && Number.isInteger(n) && n >= MIN_SIZE && n <= MAX_SIZE;
  return ok(cols) && ok(rows) ? { cols, rows } : 'invalid';
}

function rawToBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

/** The pane to show: the planner's while planning, otherwise the implementer's. */
function livePaneLabel(stage: string, state: RunState): string | null {
  const role = stage === 'planning' ? state.planner : state.implementer;
  return role && role.mode === 'pane' ? role.paneLabel : null;
}

export function createTerminal(deps: TerminalDeps): TerminalEndpoint {
  const session = deps.session ?? DEFAULT_HERDR_SESSION;
  const loadPty = deps.loadPty ?? loadNodePty;
  const loadState = deps.loadState ?? loadRunState;
  const perRun = deps.limits?.perRun ?? TERMINAL_LIMITS.perRun;
  const total = deps.limits?.total ?? TERMINAL_LIMITS.total;
  const idleMs = deps.limits?.idleMs ?? TERMINAL_LIMITS.idleMs;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const perRunCount = new Map<string, number>();
  let open = 0;
  const closers = new Set<() => void>();
  let pty: Promise<PtyFactory> | undefined;

  const factory = (): Promise<PtyFactory> => {
    // A failed load is not remembered, so fixing the install and reconnecting works.
    pty ??= loadPty().catch((e: unknown) => {
      pty = undefined;
      throw e;
    });
    return pty;
  };

  function connection(ws: WebSocket, runId: string): void {
    let proc: PtyLike | undefined;
    let closed = false;
    const queue: RawData[] = [];
    let idle: NodeJS.Timeout | undefined;
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => end(4408, 'Closed after 30 minutes without activity.'), idleMs);
      idle.unref?.();
    };
    const release = () => {
      open -= 1;
      const n = (perRunCount.get(runId) ?? 1) - 1;
      if (n <= 0) perRunCount.delete(runId);
      else perRunCount.set(runId, n);
      closers.delete(closer);
    };
    // Detaches the viewer: kills the pty (the herdr client), never the pane or the agent.
    function stop(): void {
      if (closed) return;
      closed = true;
      clearTimeout(idle);
      try {
        proc?.kill();
      } catch {
        // already gone
      }
      release();
    }
    function end(code: number, reason: string): void {
      stop();
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
        ws.close(code, reason.slice(0, 120));
      }
    }
    const closer = () => end(1001, 'server stopping');

    // The slot is taken before any await, so racing connections cannot exceed the limits.
    if (open >= total) {
      ws.close(4429, `Too many terminals are open (${total}). Close one and try again.`);
      return;
    }
    if ((perRunCount.get(runId) ?? 0) >= perRun) {
      ws.close(4429, "This run's terminal is already open in another tab or window.");
      return;
    }
    open += 1;
    closers.add(closer);
    perRunCount.set(runId, (perRunCount.get(runId) ?? 0) + 1);

    const handle = (data: RawData, isBinary: boolean) => {
      if (!proc) return;
      arm();
      const buf = rawToBuffer(data);
      if (!isBinary) {
        const resize = parseResize(buf.toString('utf8'));
        if (resize === 'invalid') return;
        if (resize) {
          try {
            proc.resize(resize.cols, resize.rows);
          } catch {
            // pty already exited
          }
          return;
        }
      }
      proc.write(buf.toString('utf8'));
    };
    const pendingBinary: boolean[] = [];
    ws.on('message', (data, isBinary) => {
      if (closed) return;
      if (!proc) {
        if (queue.length < MAX_QUEUED) {
          queue.push(data);
          pendingBinary.push(isBinary);
        }
        return;
      }
      handle(data, isBinary);
    });
    ws.on('close', stop);
    ws.on('error', stop);

    void (async () => {
      try {
        const run = deps.runs.getRun(runId);
        if (!run) return end(4404, "This run doesn't exist.");
        let state: RunState;
        try {
          state = await loadState(run.runDir);
        } catch {
          return end(4404, 'This run has no agent session yet.');
        }
        const label = livePaneLabel(run.stage, state);
        if (!label) return end(4404, "This run's agent doesn't run in a terminal.");
        const pane: PaneRef = { session, label, cwd: run.worktreePath };
        let alive = false;
        try {
          alive = await deps.host.isAlive(pane);
        } catch {
          return end(4404, "Couldn't reach the terminal app (herdr).");
        }
        if (!alive) return end(4404, "The agent session isn't running.");
        let spawn: PtyFactory;
        try {
          spawn = await factory();
        } catch (e) {
          return end(4501, (e as Error).message);
        }
        if (closed) return;
        // The command comes from the host adapter and the recorded pane, never the client.
        let argv: string[];
        try {
          argv = await deps.host.attachArgv(pane);
        } catch (e) {
          return end(
            4404,
            (e as { code?: unknown }).code === 'ambiguous_pane'
              ? "Couldn't tell which terminal belongs to this run."
              : "The agent session isn't running.",
          );
        }
        if (closed) return;
        const [file, ...args] = argv;
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(deps.env?.() ?? cleanHerdrEnv())) {
          if (v !== undefined) env[k] = v;
        }
        env.TERM = 'xterm-256color';
        let p: PtyLike;
        try {
          p = spawn(file as string, args, { ...DEFAULT_SIZE, cwd: run.worktreePath, env });
        } catch (e) {
          return end(4501, (e as Error).message);
        }
        proc = p;
        arm();
        let head = '';
        const spawnedAt = Date.now();
        let paused: NodeJS.Timeout | undefined;
        ws.once('close', () => clearInterval(paused));
        p.onData((d) => {
          if (head.length < 2048) head += d;
          if (ws.readyState !== ws.OPEN) return;
          arm();
          ws.send(d);
          if (ws.bufferedAmount > HIGH_WATER && !paused && p.pause) {
            p.pause();
            paused = setInterval(() => {
              if (ws.bufferedAmount > LOW_WATER && ws.readyState === ws.OPEN) return;
              clearInterval(paused);
              paused = undefined;
              p.resume?.();
            }, 50);
            paused.unref?.();
          }
        });
        p.onExit(() =>
          // herdr refuses a second writable client and exits at once, saying so.
          // Only herdr's own startup error counts: it exits right away, so the text must
          // be in the first output and the exit within 2 s (pane content can't fake that).
          Date.now() - spawnedAt < 2000 && /already has an attached client/.test(head)
            ? end(4429, 'This agent is already open in another terminal (maybe your own herdr).')
            : end(1000, 'The terminal session ended.'),
        );
        queue.splice(0).forEach((d, i) => handle(d, pendingBinary[i] ?? false));
      } catch (e) {
        end(4500, `The terminal failed: ${(e as Error).message}`);
      }
    })();
  }

  return {
    register(app) {
      // Only reached by plain HTTP (a WebSocket upgrade is answered by `upgrade`, which runs
      // the request through this route for the host, origin and token checks first).
      app.get('/api/runs/:id/terminal', (c) => {
        c.header(RUN_ID_HEADER, c.req.param('id'));
        return c.text('WebSocket upgrade required', 426);
      });
    },

    upgrade(app, req, socket, head) {
      if (!TERMINAL_PATH.test(req.url ?? '')) return false;
      void (async () => {
        try {
          const headers = new Headers();
          for (const [k, v] of Object.entries(req.headers)) {
            if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
          }
          const host = req.headers.host ?? 'localhost';
          // The raw path goes through untouched (no decoding here); Hono reads the run id.
          const path = (req.url ?? '').split('?')[0];
          const res = await app.fetch(new Request(`http://${host}${path}`, { headers }));
          const runId = res.headers.get(RUN_ID_HEADER);
          // 426 means the guards passed and the route is the terminal one.
          if (res.status !== 426 || runId === null) {
            const body = await res.text();
            socket.end(
              `HTTP/1.1 ${res.status} ${STATUS_CODES[res.status] ?? 'Error'}\r\n` +
                `Content-Type: ${res.headers.get('content-type') ?? 'text/plain'}\r\n` +
                `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
            );
            return;
          }
          wss.handleUpgrade(req, socket, head, (ws) => connection(ws, runId));
        } catch {
          socket.destroy();
        }
      })();
      return true;
    },

    closeAll() {
      for (const close of [...closers]) close();
    },
  };
}

/** Routes the server's HTTP upgrades to the terminal endpoint; any other upgrade is refused. */
export function attachTerminalUpgrade(server: Server, app: Hono, term: TerminalEndpoint): void {
  server.on('upgrade', (req, socket, head) => {
    try {
      if (!term.upgrade(app, req, socket, head)) socket.destroy();
    } catch {
      socket.destroy();
    }
  });
}
