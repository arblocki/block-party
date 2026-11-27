import { createServer, type Server } from 'node:http';
import net from 'node:net';
import { getRequestListener } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { openStore, type Store } from '../core/store/index.js';
import type { RunInput } from '../core/store/runs.js';
import type { RunState } from '../core/run/run-state.js';
import type { PaneRef, TerminalHost } from '../core/terminal/types.js';
import { fakeGitHub } from '../core/testing/fakes.testutil.js';
import { createApp } from './app.js';
import { TOKEN_HEADER } from './security.js';
import {
  attachTerminalUpgrade,
  createTerminal,
  type PtyFactory,
  type PtyLike,
  type TerminalDeps,
} from './terminal.js';

const TOKEN = 'test-token';
const RUN = 'r20260101-aaaaaa';

class FakePty implements PtyLike {
  written: string[] = [];
  resizes: [number, number][] = [];
  killed = 0;
  paused = 0;
  resumed = 0;
  private data: ((d: string) => void)[] = [];
  private exit: (() => void)[] = [];
  constructor(
    readonly file: string,
    readonly args: string[],
    readonly opts: { cols: number; rows: number; cwd: string; env: Record<string, string> },
  ) {}
  onData(cb: (d: string) => void) {
    this.data.push(cb);
  }
  onExit(cb: () => void) {
    this.exit.push(cb);
  }
  write(d: string) {
    this.written.push(d);
  }
  resize(c: number, r: number) {
    this.resizes.push([c, r]);
  }
  kill() {
    this.killed += 1;
  }
  pause() {
    this.paused += 1;
  }
  resume() {
    this.resumed += 1;
  }
  emit(d: string) {
    this.data.forEach((f) => f(d));
  }
  end() {
    this.exit.forEach((f) => f());
  }
}

class FakeHost implements TerminalHost {
  closed: PaneRef[] = [];
  alive = true;
  async open(): Promise<PaneRef> {
    throw new Error('not used');
  }
  async sendText() {}
  async sendKeys() {}
  async read() {
    return '';
  }
  async agentState() {
    return 'idle' as const;
  }
  async isAlive() {
    return this.alive;
  }
  async close(p: PaneRef) {
    this.closed.push(p);
  }
  attachCommand(p: PaneRef) {
    return `herdr --session ${p.session}`;
  }
  async attachArgv(p: PaneRef) {
    if (!this.alive) throw new Error('gone');
    return ['fake-herdr', '--session', p.session, 'terminal', 'attach', `term-of-${p.label}`];
  }
  async list() {
    return [];
  }
}

let store: Store;
let host: FakeHost;
let ptys: FakePty[];
let server: Server;
let port: number;
let term: ReturnType<typeof createTerminal>;
let state: RunState | 'missing';

const runState = (over: Partial<RunState> = {}): RunState =>
  ({
    implementer: { mode: 'pane', sessionId: 's', paneLabel: 'bp-impl' },
    planner: { mode: 'pane', sessionId: 'p', paneLabel: 'bp-plan' },
    ...over,
  }) as RunState;

function seedRun(over: Partial<RunInput> = {}) {
  const projectId = store.runs.upsertProject({
    owner: 'o',
    repo: 'r',
    localPath: '/src/r',
    defaultBase: 'main',
  }).id;
  store.runs.createRun({
    id: RUN,
    projectId,
    title: 't',
    stage: 'implementing',
    stageNote: null,
    branch: 'b',
    worktreePath: '/wt/a',
    runDir: '/runs/a',
    baseRef: 'main',
    baseSha: 'x',
    headSha: null,
    prNumber: null,
    planPath: '',
    planHash: '',
    implementer: null,
    rounds: { checkFix: 0, reviewFix: 0, ciFix: 0, feedback: 0, checkRuns: 0 },
    ownerPid: null,
    ownerHost: null,
    ...over,
  });
}

async function start(over: Partial<TerminalDeps> = {}) {
  const factory: PtyFactory = (file, args, opts) => {
    const p = new FakePty(file, args, opts);
    ptys.push(p);
    return p;
  };
  term = createTerminal({
    runs: store.runs,
    host,
    loadPty: async () => factory,
    loadState: async () => {
      if (state === 'missing') throw new Error('no run.json');
      return state;
    },
    env: () => ({ PATH: '/bin', HOME: '/h' }),
    ...over,
  });
  const app = createApp({
    token: TOKEN,
    port: () => port,
    github: fakeGitHub(),
    store,
    terminal: term,
  });
  server = createServer(getRequestListener(app.fetch));
  attachTerminalUpgrade(server, app, term);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
}

beforeEach(() => {
  store = openStore(':memory:');
  host = new FakeHost();
  ptys = [];
  state = runState();
});
afterEach(async () => {
  term?.closeAll();
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function connect(
  path = `/api/runs/${RUN}/terminal`,
  headers: Record<string, string> = { [TOKEN_HEADER]: TOKEN },
) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
  const result = new Promise<{ code: number; reason: string; opened: boolean }>((resolve) => {
    let opened = false;
    ws.on('open', () => (opened = true));
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString(), opened }));
    ws.on('error', () => {});
  });
  return { ws, closed: result };
}

async function ready(path?: string, headers?: Record<string, string>) {
  const before = ptys.length;
  const c = connect(path, headers);
  await new Promise((r) => c.ws.once('open', r));
  // The pty may be spawned before or after the client sees the socket open.
  for (let i = 0; i < 200 && ptys.length === before; i++) await sleep(5);
  return c;
}

/** The HTTP status of a refused upgrade. */
function refused(headers: Record<string, string>) {
  return new Promise<number>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/runs/${RUN}/terminal`, { headers });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('error', () => {});
  });
}

describe('terminal websocket: who may connect', () => {
  beforeEach(async () => {
    seedRun();
    await start();
  });

  it('rejects a missing token', async () => {
    expect(await refused({})).toBe(401);
    expect(ptys).toEqual([]);
  });

  it('rejects a wrong token', async () => {
    expect(await refused({ [TOKEN_HEADER]: 'nope' })).toBe(401);
  });

  it('rejects a foreign Origin', async () => {
    expect(await refused({ [TOKEN_HEADER]: TOKEN, origin: 'http://evil.example' })).toBe(403);
    expect(ptys).toEqual([]);
  });

  it('rejects a foreign Host', async () => {
    expect(await refused({ [TOKEN_HEADER]: TOKEN, host: 'evil.example' })).toBe(403);
  });

  it('rejects cookie auth that is not same-origin', async () => {
    const cookie = `__Host-bp_session=${TOKEN}`;
    expect(await refused({ cookie, 'sec-fetch-site': 'cross-site' })).toBe(403);
  });

  it('accepts the session cookie from a same-origin request', async () => {
    const c = await ready(undefined, {
      cookie: `__Host-bp_session=${TOKEN}`,
      'sec-fetch-site': 'same-origin',
      origin: `http://127.0.0.1:${port}`,
    });
    expect(ptys).toHaveLength(1);
    c.ws.close();
    await c.closed;
  });

  it('answers plain HTTP with 426 and refuses other upgrade paths', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/runs/${RUN}/terminal`, {
      headers: { [TOKEN_HEADER]: TOKEN },
    });
    expect(res.status).toBe(426);
    const other = connect('/api/other');
    expect((await other.closed).opened).toBe(false);
  });

  it('survives a malformed percent-encoded path: no crash, no spawn', async () => {
    // Without a token the request is refused; with one it is just an unknown run.
    const bad = '/api/runs/%E0%A4%A/terminal';
    const refusedReply = await new Promise<string>((resolve) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write(
          `GET ${bad} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\n` +
            'Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
        );
      });
      let got = '';
      sock.on('data', (d) => (got += d.toString()));
      sock.on('close', () => resolve(got));
      sock.on('error', () => {});
    });
    expect(refusedReply).not.toContain('101 Switching');
    const c = connect(bad);
    expect((await c.closed).code).toBe(4404);
    expect(ptys).toEqual([]);
    const health = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { [TOKEN_HEADER]: TOKEN },
    });
    expect(health.status).toBe(200);
  });

  it('answers a refusal with the proper status text', async () => {
    const reply = await new Promise<string>((resolve) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write(
          `GET /api/runs/${RUN}/terminal HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
            'Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n' +
            `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nOrigin: http://evil.example\r\n` +
            `x-block-party-token: ${TOKEN}\r\n\r\n`,
        );
      });
      let got = '';
      sock.on('data', (d) => (got += d.toString()));
      sock.on('close', () => resolve(got));
      sock.on('error', () => {});
    });
    expect(reply.startsWith('HTTP/1.1 403 Forbidden')).toBe(true);
  });
});

describe('terminal websocket: which runs have a terminal', () => {
  beforeEach(async () => {
    await start();
  });

  it('closes 4404 for an unknown run', async () => {
    const c = connect('/api/runs/nope/terminal');
    expect(await c.closed).toMatchObject({ code: 4404, reason: "This run doesn't exist." });
    expect(ptys).toEqual([]);
  });

  it('closes 4404 for a headless run', async () => {
    seedRun();
    state = runState({ implementer: { mode: 'headless', sessionId: 's', paneLabel: null } });
    const c = connect();
    const r = await c.closed;
    expect(r.code).toBe(4404);
    expect(r.reason).toBe("This run's agent doesn't run in a terminal.");
    expect(ptys).toEqual([]);
  });

  it('closes 4404 for a run with no recorded session', async () => {
    seedRun();
    state = 'missing';
    expect((await connect().closed).code).toBe(4404);
    state = runState({ implementer: null });
    expect((await connect().closed).code).toBe(4404);
  });

  it('closes 4404 when the pane is not running', async () => {
    seedRun();
    host.alive = false;
    expect(await connect().closed).toMatchObject({ code: 4404 });
    expect(ptys).toEqual([]);
  });

  it('shows the planner while planning and the implementer otherwise', async () => {
    seedRun({ stage: 'planning' });
    const c = await ready();
    expect(ptys[0]?.args).toContain('term-of-bp-plan');
    c.ws.close();
    await c.closed;
  });
});

describe('terminal websocket: the pty', () => {
  beforeEach(async () => {
    seedRun();
    await start();
  });

  it('spawns the host argv for the run pane in the worktree with the scrubbed env', async () => {
    const c = await ready();
    const p = ptys[0]!;
    expect(p.file).toBe('fake-herdr');
    expect(p.args).toEqual(['--session', 'block-party', 'terminal', 'attach', 'term-of-bp-impl']);
    expect(p.opts.cwd).toBe('/wt/a');
    expect(p.opts.env).toEqual({ PATH: '/bin', HOME: '/h', TERM: 'xterm-256color' });
    c.ws.close();
    await c.closed;
  });

  it('does not let the query string or messages change what is spawned', async () => {
    const c = await ready(`/api/runs/${RUN}/terminal?cmd=rm%20-rf&argv=x`);
    c.ws.send(JSON.stringify({ type: 'spawn', argv: ['sh'] }));
    c.ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30, argv: ['sh'] }));
    await sleep(30);
    expect(ptys).toHaveLength(1);
    expect(ptys[0]?.file).toBe('fake-herdr');
    expect(ptys[0]?.args).toEqual([
      '--session',
      'block-party',
      'terminal',
      'attach',
      'term-of-bp-impl',
    ]);
    c.ws.close();
    await c.closed;
  });

  it('passes data both ways', async () => {
    const c = await ready();
    const got = new Promise<string>((r) => c.ws.once('message', (d) => r(d.toString())));
    ptys[0]!.emit('hello');
    expect(await got).toBe('hello');
    c.ws.send(Buffer.from('ls\r'));
    c.ws.send('plain text');
    await sleep(30);
    expect(ptys[0]!.written).toEqual(['ls\r', 'plain text']);
    c.ws.close();
    await c.closed;
  });

  it('applies valid resize frames and ignores ones outside 1-500', async () => {
    const c = await ready();
    c.ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
    for (const bad of [
      { cols: 0, rows: 10 },
      { cols: 501, rows: 10 },
      { cols: 10, rows: -1 },
      { cols: 10.5, rows: 10 },
      { cols: '10', rows: 10 },
      { cols: 10 },
    ]) {
      c.ws.send(JSON.stringify({ type: 'resize', ...bad }));
    }
    c.ws.send(JSON.stringify({ type: 'resize', cols: 500, rows: 1 }));
    await sleep(40);
    expect(ptys[0]!.resizes).toEqual([
      [120, 40],
      [500, 1],
    ]);
    // Invalid resize frames are not typed into the session either.
    expect(ptys[0]!.written).toEqual([]);
    c.ws.close();
    await c.closed;
  });

  it('kills the pty, and not the pane, when the socket closes', async () => {
    const c = await ready();
    c.ws.close();
    await c.closed;
    await sleep(20);
    expect(ptys[0]!.killed).toBe(1);
    expect(host.closed).toEqual([]);
  });

  it('tells a second viewer when herdr already has a writable client', async () => {
    const c = await ready();
    ptys[0]!.emit('herdr: terminal term_x already has an attached client; retry with --takeover\n');
    ptys[0]!.end();
    const r = await c.closed;
    expect(r.code).toBe(4429);
    expect(r.reason).toContain('already open');
  });

  it('pauses the pty while the viewer is far behind and resumes when it drains', async () => {
    const c = await ready();
    c.ws.pause();
    ptys[0]!.emit('x'.repeat(8 * 1024 * 1024));
    await sleep(100);
    expect(ptys[0]!.paused).toBe(1);
    expect(ptys[0]!.resumed).toBe(0);
    c.ws.resume();
    for (let i = 0; i < 100 && ptys[0]!.resumed === 0; i++) await sleep(20);
    expect(ptys[0]!.resumed).toBe(1);
    c.ws.close();
  });

  it('closes the socket when the pty exits', async () => {
    const c = await ready();
    ptys[0]!.end();
    expect((await c.closed).code).toBe(1000);
    expect(host.closed).toEqual([]);
  });
});

describe('terminal websocket: limits', () => {
  it('allows one terminal per run by default (herdr gives one client the input)', async () => {
    seedRun();
    await start();
    const a = await ready();
    const c = connect();
    expect(await c.closed).toMatchObject({ code: 4429 });
    expect(ptys).toHaveLength(1);
    a.ws.close();
  });

  it('allows two terminals per run when configured and refuses a third', async () => {
    seedRun();
    await start({ limits: { perRun: 2 } });
    const a = await ready();
    const b = await ready();
    const c = connect();
    expect(await c.closed).toMatchObject({ code: 4429 });
    expect(ptys).toHaveLength(2);
    a.ws.close();
    await a.closed;
    await sleep(20);
    const d = await ready();
    expect(ptys).toHaveLength(3);
    b.ws.close();
    d.ws.close();
  });

  it('refuses a terminal beyond the total', async () => {
    seedRun();
    await start({ limits: { total: 1, perRun: 5 } });
    const a = await ready();
    expect(await connect().closed).toMatchObject({ code: 4429 });
    a.ws.close();
  });

  it('closes an idle socket and kills its pty', async () => {
    seedRun();
    await start({ limits: { idleMs: 60 } });
    const c = await ready();
    expect(await c.closed).toMatchObject({ code: 4408 });
    expect(ptys[0]!.killed).toBe(1);
  });

  it('input and output keep a socket from going idle', async () => {
    seedRun();
    await start({ limits: { idleMs: 300 } });
    const c = await ready();
    // Send first: the client may have taken a while to see the socket open.
    for (let i = 0; i < 5; i++) {
      c.ws.send('x');
      await sleep(100);
    }
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    c.ws.close();
  });
});

describe('terminal websocket: node-pty unavailable', () => {
  it('still serves the app and tells the viewer why', async () => {
    seedRun();
    await start({
      loadPty: async () => {
        throw new Error('native build missing');
      },
    });
    const c = connect();
    const r = await c.closed;
    expect(r.code).toBe(4501);
    expect(r.reason).toBe('native build missing');
    const health = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { [TOKEN_HEADER]: TOKEN },
    });
    expect(health.status).toBe(200);
  });

  it('retries the load on the next connection', async () => {
    seedRun();
    let tries = 0;
    await start({
      loadPty: async () => {
        if (++tries === 1) throw new Error('first try fails');
        return (f, a, o) => {
          const p = new FakePty(f, a, o);
          ptys.push(p);
          return p;
        };
      },
    });
    expect((await connect().closed).code).toBe(4501);
    const c = await ready();
    expect(ptys).toHaveLength(1);
    c.ws.close();
  });
});
