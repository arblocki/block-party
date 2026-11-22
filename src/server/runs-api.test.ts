import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeGitHub } from '../core/testing/fakes.testutil.js';
import { openStore, type Store } from '../core/store/index.js';
import type { RunInput, RunStore } from '../core/store/runs.js';
import { createApp } from './app.js';
import { TOKEN_HEADER } from './security.js';

const TOKEN = 'test-token';
const PORT = 4321;
const HOST = `127.0.0.1:${PORT}`;
const RUN_A = 'r20260101-aaaaaa';
const RUN_B = 'r20260102-bbbbbb';

function runInput(projectId: string, over: Partial<RunInput> = {}): RunInput {
  return {
    id: RUN_A,
    projectId,
    title: 'Add a thing',
    stage: 'implementing',
    stageNote: null,
    branch: 'bp/add-a-thing-aaaaaa',
    worktreePath: '/wt/a',
    runDir: '/runs/a',
    baseRef: 'main',
    baseSha: 'base0',
    headSha: null,
    prNumber: null,
    planPath: '/runs/a/plans/v1.md',
    planHash: 'hash1',
    implementer: null,
    rounds: { checkFix: 0, reviewFix: 0 },
    ownerPid: null,
    ownerHost: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

let store: Store;
let runs: RunStore;
let projectId: string;
let app: ReturnType<typeof createApp>;

function makeApp(runStore: RunStore = runs) {
  return createApp({
    token: TOKEN,
    port: () => PORT,
    github: fakeGitHub(),
    store: { ...store, runs: runStore },
    streamTiming: { pollMs: 5, heartbeatMs: 1000 },
  });
}

beforeEach(() => {
  store = openStore(':memory:');
  runs = store.runs;
  projectId = runs.upsertProject({
    owner: 'octocat',
    repo: 'hello-world',
    localPath: '/src/hello',
    defaultBase: 'main',
  }).id;
  app = makeApp();
});

afterEach(() => store.close());

function req(path: string, init: RequestInit = {}, a = app) {
  const headers = new Headers(init.headers);
  if (!headers.has('host')) headers.set('host', HOST);
  if (!headers.has(TOKEN_HEADER)) headers.set(TOKEN_HEADER, TOKEN);
  return a.request(path, { ...init, headers });
}

async function json(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const res = await req(path, init);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

interface Frame {
  event?: string;
  id?: string;
  data?: unknown;
  comment?: string;
}

/** Reads SSE frames from a response body until `done(frames)` holds or the timeout passes. */
class FrameReader {
  private buffer = '';
  readonly frames: Frame[] = [];
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private pending: ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']> | undefined;

  constructor(res: Response) {
    this.reader = res.body!.getReader();
  }

  async until(done: (frames: Frame[]) => boolean, timeoutMs = 2000): Promise<Frame[]> {
    const deadline = Date.now() + timeoutMs;
    while (!done(this.frames)) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out; got ${JSON.stringify(this.frames)}`);
      // A read that loses the race stays pending and is reused, so no chunk is dropped.
      this.pending ??= this.reader.read();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        this.pending,
        new Promise<'timeout'>((r) => (timer = setTimeout(() => r('timeout'), left))),
      ]);
      clearTimeout(timer);
      if (chunk === 'timeout') continue;
      this.pending = undefined;
      if (chunk.done) throw new Error('stream ended');
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = this.buffer.indexOf('\n\n')) >= 0) {
        const block = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        const frame: Frame = {};
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) frame.comment = line.slice(1).trim();
          else if (line.startsWith('event: ')) frame.event = line.slice(7);
          else if (line.startsWith('id: ')) frame.id = line.slice(4);
          else if (line.startsWith('data: ')) data.push(line.slice(6));
        }
        if (data.length) frame.data = JSON.parse(data.join('\n'));
        this.frames.push(frame);
      }
    }
    return this.frames;
  }

  cancel(): Promise<void> {
    return this.reader.cancel();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ENDPOINTS: [string, string][] = [
  ['GET', '/api/runs'],
  ['GET', `/api/runs/${RUN_A}`],
  ['GET', `/api/runs/${RUN_A}/events`],
  ['GET', `/api/runs/${RUN_A}/stream`],
  ['GET', '/api/stream'],
  ['GET', '/api/inbox'],
  ['POST', '/api/inbox/1/dismiss'],
  ['GET', '/api/projects'],
];

describe('security', () => {
  it.each(ENDPOINTS)('%s %s requires the token', async (method, path) => {
    runs.createRun(runInput(projectId));
    const res = await app.request(path, { method, headers: { host: HOST } });
    expect(res.status).toBe(401);
  });

  it.each(ENDPOINTS)('%s %s rejects a foreign origin', async (method, path) => {
    runs.createRun(runInput(projectId));
    const res = await req(path, { method, headers: { origin: 'http://evil.example' } });
    expect(res.status).toBe(403);
  });
});

describe('run ids', () => {
  it.each(['nope', 'r1', 'r2026010-aaaaaa', 'r20260101-AAAAAA', 'r20260101-aaaaaaa'])(
    'rejects %j with 400',
    async (id) => {
      for (const suffix of ['', '/events', '/stream']) {
        expect((await req(`/api/runs/${id}${suffix}`)).status).toBe(400);
      }
    },
  );

  it('returns 404 for an unknown run', async () => {
    for (const suffix of ['', '/events', '/stream']) {
      const res = await req(`/api/runs/${RUN_B}${suffix}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'run not found' });
    }
  });
});

describe('JSON endpoints', () => {
  it('lists runs newest first, optionally only active ones', async () => {
    runs.createRun(runInput(projectId, { updatedAt: '2026-01-01T00:00:00.000Z' }));
    runs.createRun(
      runInput(projectId, {
        id: RUN_B,
        title: 'Done thing',
        stage: 'complete',
        prNumber: 12,
        updatedAt: '2026-01-02T00:00:00.000Z',
      }),
    );
    runs.openDecision({ runId: RUN_A, kind: 'blocked', title: 'Q', body: 'b' });
    runs.openDecision({ runId: RUN_A, kind: 'failed', title: 'Q2', body: 'b' });

    const all = await json('/api/runs');
    expect(all).toEqual({
      runs: [
        {
          id: RUN_B,
          title: 'Done thing',
          stage: 'complete',
          stageNote: null,
          owner: 'octocat',
          repo: 'hello-world',
          branch: 'bp/add-a-thing-aaaaaa',
          prNumber: 12,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
          openDecisions: 0,
        },
        expect.objectContaining({ id: RUN_A, stage: 'implementing', openDecisions: 2 }),
      ],
    });
    const active = (await json('/api/runs?active=1')).runs as { id: string }[];
    expect(active.map((r) => r.id)).toEqual([RUN_A]);
    const limited = (await json('/api/runs?limit=1')).runs as { id: string }[];
    expect(limited.map((r) => r.id)).toEqual([RUN_B]);
    expect((await req('/api/runs?limit=x')).status).toBe(400);
  });

  it('returns a run with its stages and decisions', async () => {
    runs.createRun(runInput(projectId));
    const stageId = runs.startStage({ runId: RUN_A, kind: 'implement', round: 0 });
    const decisionId = runs.openDecision({ runId: RUN_A, kind: 'blocked', title: 'Q', body: 'b' });

    const body = await json(`/api/runs/${RUN_A}`);
    expect(body.run).toMatchObject({
      id: RUN_A,
      title: 'Add a thing',
      owner: 'octocat',
      repo: 'hello-world',
      openDecisions: 1,
      baseRef: 'main',
    });
    expect(body.stages).toEqual([
      expect.objectContaining({ id: stageId, kind: 'implement', state: 'running' }),
    ]);
    expect(body.decisions).toEqual([
      expect.objectContaining({ id: decisionId, status: 'open', title: 'Q' }),
    ]);
  });

  it('pages through events', async () => {
    runs.createRun(runInput(projectId));
    runs.createRun(runInput(projectId, { id: RUN_B }));
    const ids = [1, 2, 3].map((n) =>
      runs.appendEvent({ runId: RUN_A, ts: `t${n}`, type: 'log', payload: { n } }),
    );
    runs.appendEvent({ runId: RUN_B, ts: 't', type: 'log' });

    const first = await json(`/api/runs/${RUN_A}/events?limit=2`);
    expect(first.lastId).toBe(ids[1]);
    expect(first.events).toEqual([
      { id: ids[0], runId: RUN_A, stageId: null, ts: 't1', type: 'log', payload: { n: 1 } },
      expect.objectContaining({ id: ids[1] }),
    ]);
    const rest = await json(`/api/runs/${RUN_A}/events?after=${ids[1]}`);
    expect(rest).toEqual({ events: [expect.objectContaining({ id: ids[2] })], lastId: ids[2] });
    const none = await json(`/api/runs/${RUN_A}/events?after=${ids[2]}`);
    expect(none).toEqual({ events: [], lastId: ids[2] });
    expect((await req(`/api/runs/${RUN_A}/events?after=-1`)).status).toBe(400);
    expect((await req(`/api/runs/${RUN_A}/events?limit=0`)).status).toBe(400);
  });

  it('caps the event limit at 2000', async () => {
    runs.createRun(runInput(projectId));
    for (let i = 0; i < 2001; i++) runs.appendEvent({ runId: RUN_A, ts: 't', type: 'log' });
    const page = await json(`/api/runs/${RUN_A}/events?limit=5000`);
    expect((page.events as unknown[]).length).toBe(2000);
    const def = await json(`/api/runs/${RUN_A}/events`);
    expect((def.events as unknown[]).length).toBe(500);
  });

  it('lists the inbox with run titles and dismisses decisions', async () => {
    runs.createRun(runInput(projectId));
    const d1 = runs.openDecision({ runId: RUN_A, kind: 'blocked', title: 'Q1', body: 'b' });
    const d2 = runs.openDecision({ runId: RUN_A, kind: 'failed', title: 'Q2', body: 'b' });

    const open = await json('/api/inbox');
    expect(open.decisions).toEqual([
      expect.objectContaining({ id: d2, runTitle: 'Add a thing', runStage: 'implementing' }),
      expect.objectContaining({ id: d1, runTitle: 'Add a thing', runStage: 'implementing' }),
    ]);

    expect(await json(`/api/inbox/${d1}/dismiss`, { method: 'POST' })).toEqual({ changed: true });
    expect(await json(`/api/inbox/${d1}/dismiss`, { method: 'POST' })).toEqual({ changed: false });
    expect(await json('/api/inbox/999/dismiss', { method: 'POST' })).toEqual({ changed: false });
    expect((await req('/api/inbox/abc/dismiss', { method: 'POST' })).status).toBe(400);

    const stillOpen = (await json('/api/inbox?status=open')).decisions as { id: number }[];
    expect(stillOpen.map((d) => d.id)).toEqual([d2]);
    const all = (await json('/api/inbox?status=all')).decisions as { id: number; status: string }[];
    expect(all.map((d) => [d.id, d.status])).toEqual([
      [d2, 'open'],
      [d1, 'dismissed'],
    ]);
    expect((await req('/api/inbox?status=weird')).status).toBe(400);
  });

  it('lists projects', async () => {
    expect(await json('/api/projects')).toEqual({
      projects: [expect.objectContaining({ id: projectId, owner: 'octocat', repo: 'hello-world' })],
    });
  });
});

describe('GET /api/runs/:id/stream', () => {
  it('streams new events in order with their ids, plus run changes', async () => {
    runs.createRun(runInput(projectId));
    const before = runs.appendEvent({ runId: RUN_A, ts: 't0', type: 'log' });
    const ctrl = new AbortController();
    const res = await req(`/api/runs/${RUN_A}/stream`, { signal: ctrl.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    const reader = new FrameReader(res);
    try {
      const [initial] = await reader.until((f) => f.length >= 1);
      expect(initial).toMatchObject({ event: 'run', data: { id: RUN_A, stage: 'implementing' } });

      const ids = [1, 2, 3].map((n) =>
        runs.appendEvent({ runId: RUN_A, ts: `t${n}`, type: 'log', payload: { n } }),
      );
      runs.createRun(runInput(projectId, { id: RUN_B }));
      runs.appendEvent({ runId: RUN_B, ts: 't', type: 'log' }); // another run's: not sent
      const frames = await reader.until(
        (f) => f.filter((x) => x.event === 'run-event').length >= 3,
      );
      const events = frames.filter((x) => x.event === 'run-event');
      expect(events.map((x) => x.id)).toEqual(ids.map(String));
      expect(events.map((x) => (x.data as { id: number }).id)).toEqual(ids);
      expect(events.some((x) => (x.data as { id: number }).id === before)).toBe(false);

      runs.updateRun(RUN_A, { stage: 'checking' });
      const after = await reader.until((f) => f.filter((x) => x.event === 'run').length >= 2);
      expect(after.filter((x) => x.event === 'run').at(-1)?.data).toMatchObject({
        stage: 'checking',
      });
      expect(after.filter((x) => x.event === 'run-event')).toHaveLength(3);
    } finally {
      ctrl.abort();
      await reader.cancel();
    }
  });

  it('resumes after Last-Event-ID without repeating events', async () => {
    runs.createRun(runInput(projectId));
    const ids = [1, 2, 3, 4].map((n) => runs.appendEvent({ runId: RUN_A, ts: `t${n}`, type: 'x' }));
    const ctrl = new AbortController();
    // Last-Event-ID wins over the original `after`, as a reconnect repeats the URL.
    const res = await req(`/api/runs/${RUN_A}/stream?after=0`, {
      signal: ctrl.signal,
      headers: { 'last-event-id': String(ids[1]) },
    });
    const reader = new FrameReader(res);
    try {
      await reader.until(
        (f) => f.some((x) => x.event === 'run') && f.some((x) => x.event === 'run-event'),
      );
      // Keep reading for a few polls: nothing earlier may be repeated.
      await expect(reader.until(() => false, 50)).rejects.toThrow(/timed out/);
      const events = reader.frames.filter((x) => x.event === 'run-event');
      expect(events.map((x) => x.id)).toEqual([ids[2], ids[3]].map(String));
      expect(reader.frames.filter((x) => x.event === 'run')).toHaveLength(1);
    } finally {
      ctrl.abort();
      await reader.cancel();
    }
  });

  it('starts from `after` when given', async () => {
    runs.createRun(runInput(projectId));
    const ids = [1, 2].map((n) => runs.appendEvent({ runId: RUN_A, ts: `t${n}`, type: 'x' }));
    const ctrl = new AbortController();
    const res = await req(`/api/runs/${RUN_A}/stream?after=${ids[0]}`, { signal: ctrl.signal });
    const reader = new FrameReader(res);
    try {
      const frames = await reader.until((f) => f.some((x) => x.event === 'run-event'));
      expect(frames.filter((x) => x.event === 'run-event').map((x) => x.id)).toEqual([
        String(ids[1]),
      ]);
    } finally {
      ctrl.abort();
      await reader.cancel();
    }
  });

  it('gives a client that drops before any run event a cursor to resume from', async () => {
    runs.createRun(runInput(projectId));
    const before = runs.appendEvent({ runId: RUN_A, ts: 't0', type: 'x' });
    const first = new AbortController();
    const reader1 = new FrameReader(
      await req(`/api/runs/${RUN_A}/stream`, { signal: first.signal }),
    );
    const [initial] = await reader1.until((f) => f.some((x) => x.event === 'run'));
    expect(initial).toMatchObject({ event: 'run', id: String(before) });
    first.abort();
    await reader1.cancel();

    // Appended while disconnected: the reconnect must still deliver it.
    const missed = runs.appendEvent({ runId: RUN_A, ts: 't1', type: 'x' });
    const second = new AbortController();
    const reader2 = new FrameReader(
      await req(`/api/runs/${RUN_A}/stream`, {
        signal: second.signal,
        headers: { 'last-event-id': initial!.id! },
      }),
    );
    try {
      const frames = await reader2.until((f) => f.some((x) => x.event === 'run-event'));
      expect(frames.filter((x) => x.event === 'run-event').map((x) => x.id)).toEqual([
        String(missed),
      ]);
    } finally {
      second.abort();
      await reader2.cancel();
    }
  });

  it('rejects a malformed Last-Event-ID', async () => {
    runs.createRun(runInput(projectId));
    const res = await req(`/api/runs/${RUN_A}/stream`, { headers: { 'last-event-id': 'x' } });
    expect(res.status).toBe(400);
  });

  it('sends heartbeats', async () => {
    runs.createRun(runInput(projectId));
    const a = createApp({
      token: TOKEN,
      port: () => PORT,
      github: fakeGitHub(),
      store,
      streamTiming: { pollMs: 1000, heartbeatMs: 5 },
    });
    const ctrl = new AbortController();
    const reader = new FrameReader(
      await req(`/api/runs/${RUN_A}/stream`, { signal: ctrl.signal }, a),
    );
    try {
      await reader.until((f) => f.some((x) => x.comment === 'hb'));
    } finally {
      ctrl.abort();
      await reader.cancel();
    }
  });
});

describe('GET /api/stream', () => {
  it('sends runs and inbox up front, then again when they change', async () => {
    runs.createRun(runInput(projectId));
    const ctrl = new AbortController();
    const reader = new FrameReader(await req('/api/stream', { signal: ctrl.signal }));
    const count = (f: Frame[], event: string) => f.filter((x) => x.event === event).length;
    try {
      const initial = await reader.until((f) => count(f, 'runs') >= 1 && count(f, 'inbox') >= 1);
      expect(initial.find((x) => x.event === 'runs')?.data).toEqual({
        runs: [expect.objectContaining({ id: RUN_A, stage: 'implementing' })],
      });
      expect(initial.find((x) => x.event === 'inbox')?.data).toEqual({
        openCount: 0,
        decisions: [],
      });
      await expect(reader.until(() => false, 50)).rejects.toThrow(/timed out/);
      expect(count(reader.frames, 'runs')).toBe(1); // nothing changed: nothing re-sent
      expect(count(reader.frames, 'inbox')).toBe(1);

      runs.updateRun(RUN_A, { stage: 'checking' });
      let frames = await reader.until((f) => count(f, 'runs') >= 2);
      expect(frames.filter((x) => x.event === 'runs').at(-1)?.data).toEqual({
        runs: [expect.objectContaining({ id: RUN_A, stage: 'checking' })],
      });

      const id = runs.openDecision({ runId: RUN_A, kind: 'blocked', title: 'Q', body: 'b' });
      frames = await reader.until((f) => count(f, 'inbox') >= 2);
      expect(frames.filter((x) => x.event === 'inbox').at(-1)?.data).toEqual({
        openCount: 1,
        decisions: [expect.objectContaining({ id, runTitle: 'Add a thing', runStage: 'checking' })],
      });
    } finally {
      ctrl.abort();
      await reader.cancel();
    }
  });
});

describe('closing a stream', () => {
  /** `runs` with every method call counted. */
  function counting(target: RunStore): { store: RunStore; calls: () => number } {
    let n = 0;
    const store = new Proxy(target, {
      get(t, key, recv) {
        const value = Reflect.get(t, key, recv) as unknown;
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          n++;
          return (value as (...a: unknown[]) => unknown).apply(t, args);
        };
      },
    });
    return { store, calls: () => n };
  }

  it.each([`/api/runs/${RUN_A}/stream`, '/api/stream'])(
    'stops reading the store after %s is aborted',
    async (path) => {
      runs.createRun(runInput(projectId));
      const spy = counting(runs);
      const a = makeApp(spy.store);
      const ctrl = new AbortController();
      const reader = new FrameReader(await req(path, { signal: ctrl.signal }, a));
      await reader.until((f) => f.length >= 1);
      await sleep(20);
      expect(spy.calls()).toBeGreaterThan(2); // it polls while open

      ctrl.abort();
      await sleep(10); // let an in-flight tick finish
      const atClose = spy.calls();
      await sleep(50);
      expect(spy.calls()).toBe(atClose);
      await reader.cancel();
    },
  );

  it('stops reading the store when the body is cancelled', async () => {
    runs.createRun(runInput(projectId));
    const spy = counting(runs);
    const a = makeApp(spy.store);
    const reader = new FrameReader(await req('/api/stream', {}, a));
    await reader.until((f) => f.length >= 1);
    await reader.cancel();
    await sleep(10);
    const atClose = spy.calls();
    await sleep(50);
    expect(spy.calls()).toBe(atClose);
  });
});
