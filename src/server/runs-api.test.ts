import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeGitHub } from '../core/testing/fakes.testutil.js';
import { openStore, type Store } from '../core/store/index.js';
import type { RunInput, RunStore } from '../core/store/runs.js';
import type { ContinueEntry } from '../core/run/pipeline.js';
import { createApp } from './app.js';
import { PlanValidationError, type RunManager, type StartRunRequest } from './run-manager.js';
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
    rounds: { checkFix: 0, reviewFix: 0, feedback: 0, checkRuns: 0 },
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

function makeApp(runStore: RunStore = runs, runManager?: RunManager) {
  return createApp({
    token: TOKEN,
    port: () => PORT,
    github: fakeGitHub(),
    store: { ...store, runs: runStore },
    streamTiming: { pollMs: 5, heartbeatMs: 1000 },
    ...(runManager ? { runManager } : {}),
  });
}

/** A manager that records calls; `start` resolves with RUN_A unless `fail` is set. */
function fakeManager(opts: { fail?: Error } = {}) {
  const starts: StartRunRequest[] = [];
  const cancels: string[] = [];
  const continues: { runId: string; entry: ContinueEntry }[] = [];
  const manager: RunManager = {
    async start(req) {
      starts.push(req);
      if (opts.fail) throw opts.fail;
      return RUN_A;
    },
    continue(runId, entry) {
      continues.push({ runId, entry });
      return true;
    },
    cancel(id) {
      cancels.push(id);
      return id === RUN_A;
    },
    async shutdown() {},
  };
  return { manager, starts, cancels, continues };
}

const PLAN = `# Add widgets

## Goal
Widgets.

## Approach
Build them.

## Acceptance criteria
- [ ] Widgets exist
- [ ] Widgets are blue

## Out of scope
Gadgets.
`;

const post = (path: string, body: unknown, a = app) =>
  req(
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
    a,
  );

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
  ['GET', `/api/runs/${RUN_A}/plan`],
  ['GET', `/api/runs/${RUN_A}/findings`],
  ['GET', `/api/runs/${RUN_A}/stream`],
  ['GET', '/api/stream'],
  ['GET', '/api/inbox'],
  ['POST', '/api/inbox/1/dismiss'],
  ['POST', '/api/inbox/1/answer'],
  ['GET', '/api/projects'],
  ['POST', '/api/projects'],
  ['POST', '/api/plans/validate'],
  ['POST', '/api/runs'],
  ['POST', `/api/runs/${RUN_A}/cancel`],
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

  describe('answering decisions', () => {
    const options = [
      { id: 'yes', label: 'Yes' },
      { id: 'no', label: 'No' },
    ];
    const answer = (id: number | string, body: unknown) =>
      req(`/api/inbox/${id}/answer`, { method: 'POST', body: JSON.stringify(body) });
    const open = () => {
      runs.createRun(runInput(projectId));
      return runs.openDecision({
        runId: RUN_A,
        kind: 'plan_approval',
        title: 'Approve?',
        body: 'b',
        options,
      });
    };

    it('answers an open decision and shows options and answer in the inbox', async () => {
      const id = open();
      const listed = (await json('/api/inbox')).decisions as unknown[];
      expect(listed).toEqual([expect.objectContaining({ id, options, answer: null })]);

      const res = await answer(id, { choice: 'yes', note: '  ship it ' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        decision: expect.objectContaining({
          id,
          status: 'answered',
          answer: { choice: 'yes', note: 'ship it' },
          answeredAt: expect.any(String),
        }),
      });
      const all = (await json('/api/inbox?status=all')).decisions as unknown[];
      expect(all).toEqual([
        expect.objectContaining({ id, answer: { choice: 'yes', note: 'ship it' } }),
      ]);
      expect((await json(`/api/runs/${RUN_A}`)).decisions).toEqual([
        expect.objectContaining({ id, status: 'answered', options }),
      ]);
    });

    it('answers without a note', async () => {
      const id = open();
      const res = await answer(id, { choice: 'no' });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { decision: { answer: unknown } }).decision.answer).toEqual({
        choice: 'no',
        note: null,
      });
    });

    it('answers 404 for an unknown id, 409 when not open, 400 for bad input', async () => {
      const id = open();
      expect((await answer(999, { choice: 'yes' })).status).toBe(404);
      expect((await answer('abc', { choice: 'yes' })).status).toBe(400);
      expect((await answer(id, { choice: 'maybe' })).status).toBe(400);
      expect((await answer(id, { choice: 'yes', note: 'x'.repeat(4001) })).status).toBe(400);
      expect((await answer(id, { note: 'x' })).status).toBe(400);
      expect((await answer(id, 'nope')).status).toBe(400);
      expect(runs.getDecision(id)?.status).toBe('open');

      expect((await answer(id, { choice: 'yes', note: 'x'.repeat(4000) })).status).toBe(200);
      expect((await answer(id, { choice: 'no' })).status).toBe(409);
      expect(runs.getDecision(id)?.answer?.choice).toBe('yes');
    });

    describe('final review', () => {
      const openReview = () => {
        runs.createRun(runInput(projectId, { stage: 'awaiting_review' }));
        return runs.openDecision({
          runId: RUN_A,
          kind: 'final_review',
          title: 'Ready',
          body: 'b',
          options: [
            { id: 'approve', label: 'Approve' },
            { id: 'send_back', label: 'Send back' },
          ],
        });
      };
      const withManager = () => {
        const fake = fakeManager();
        return { fake, app: makeApp(runs, fake.manager) };
      };
      const answerWith = (a: typeof app, id: number, body: unknown) =>
        req(`/api/inbox/${id}/answer`, { method: 'POST', body: JSON.stringify(body) }, a);

      it('starts an approve continuation once, however many times it is answered', async () => {
        const id = openReview();
        const { fake, app: a } = withManager();
        expect((await answerWith(a, id, { choice: 'approve' })).status).toBe(200);
        expect((await answerWith(a, id, { choice: 'approve' })).status).toBe(409);
        expect(fake.continues).toEqual([{ runId: RUN_A, entry: { kind: 'approve' } }]);
      });

      it('starts a feedback continuation with the trimmed note', async () => {
        const id = openReview();
        const { fake, app: a } = withManager();
        const res = await answerWith(a, id, { choice: 'send_back', note: '  rename x  ' });
        expect(res.status).toBe(200);
        expect(fake.continues).toEqual([
          { runId: RUN_A, entry: { kind: 'feedback', text: 'rename x' } },
        ]);
      });

      it('refuses to send back without a note and leaves the decision open', async () => {
        const id = openReview();
        const { fake, app: a } = withManager();
        expect((await answerWith(a, id, { choice: 'send_back' })).status).toBe(400);
        expect((await answerWith(a, id, { choice: 'send_back', note: '   ' })).status).toBe(400);
        expect(runs.getDecision(id)?.status).toBe('open');
        expect(fake.continues).toEqual([]);
      });

      it('answers 503 without a manager, leaving the decision open', async () => {
        const id = openReview();
        expect((await answerWith(makeApp(), id, { choice: 'approve' })).status).toBe(503);
        expect(runs.getDecision(id)?.status).toBe('open');
      });

      it('reopens the review and answers 409 when the continuation cannot start', async () => {
        const id = openReview();
        const fake = fakeManager();
        fake.manager.continue = () => false;
        const res = await answerWith(makeApp(runs, fake.manager), id, { choice: 'approve' });
        expect(res.status).toBe(409);
        expect(runs.getDecision(id)?.status).toBe('answered');
        const open = runs
          .listDecisions({ runId: RUN_A, status: 'open' })
          .filter((d) => d.kind === 'final_review');
        expect(open).toHaveLength(1);
        expect(open[0]!.options).toHaveLength(2);
        expect(open[0]!.body).toContain('could not be carried out');
      });

      it('does not continue for other decision kinds', async () => {
        const id = open();
        const { fake, app: a } = withManager();
        expect((await answerWith(a, id, { choice: 'yes' })).status).toBe(200);
        expect(fake.continues).toEqual([]);
      });
    });

    it('lets an optioned decision be dismissed, but not answered, once its run ended', async () => {
      const id = open();
      runs.updateRun(RUN_A, { stage: 'failed' });
      expect((await answer(id, { choice: 'yes' })).status).toBe(409);
      expect(runs.getDecision(id)?.status).toBe('open');
      const res = await req(`/api/inbox/${id}/dismiss`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect(runs.getDecision(id)?.status).toBe('dismissed');
    });

    it('still refuses to dismiss while the run is resting', async () => {
      const id = open();
      runs.updateRun(RUN_A, { stage: 'awaiting_review' });
      expect((await req(`/api/inbox/${id}/dismiss`, { method: 'POST' })).status).toBe(409);
    });

    it('refuses to dismiss a decision that has options', async () => {
      const id = open();
      const res = await req(`/api/inbox/${id}/dismiss`, { method: 'POST' });
      expect(res.status).toBe(409);
      expect(runs.getDecision(id)?.status).toBe('open');
    });

    it('carries options and answer in the stream inbox frame', async () => {
      const id = open();
      runs.answerDecision(id, { choice: 'yes', note: null });
      const id2 = runs.openDecision({
        runId: RUN_A,
        kind: 'dispute',
        title: 'Q',
        body: 'b',
        options,
      });
      const res = await req('/api/stream');
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let text = '';
      while (!text.includes('event: inbox')) {
        const { value, done } = await reader.read();
        if (done) break;
        text += dec.decode(value);
      }
      await reader.cancel();
      const data = text.split('event: inbox\ndata: ')[1]!.split('\n')[0]!;
      expect(JSON.parse(data).decisions).toEqual([
        expect.objectContaining({ id: id2, options, answer: null }),
      ]);
    });
  });

  it('lists projects', async () => {
    expect(await json('/api/projects')).toEqual({
      projects: [expect.objectContaining({ id: projectId, owner: 'octocat', repo: 'hello-world' })],
    });
  });
});

describe('run plan and findings', () => {
  const finding = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    reviewedSha: 'abcdef1234',
    severity: 'P1',
    category: 'correctness',
    title: `Finding ${id}`,
    body: 'body',
    location: { path: 'src/a.ts', startLine: 3, endLine: 4 },
    confidence: 'high',
    suggestedFix: null,
    ...over,
  });
  let dir: string;
  let outside: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'bp-run-')));
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'bp-out-')));
    mkdirSync(join(dir, 'plans'));
    mkdirSync(join(dir, 'reviews', 'round-1'), { recursive: true });
    mkdirSync(join(dir, 'reports'));
    writeFileSync(join(dir, 'plans', 'v1.md'), PLAN);
  });

  const addRun = (over: Partial<RunInput> = {}) =>
    runs.createRun(
      runInput(projectId, { runDir: dir, planPath: join(dir, 'plans', 'v1.md'), ...over }),
    );

  it('returns the plan text, title and criteria', async () => {
    addRun();
    const body = await json(`/api/runs/${RUN_A}/plan`);
    expect(body).toEqual({
      text: PLAN,
      title: 'Add widgets',
      acceptanceCriteria: ['Widgets exist', 'Widgets are blue'],
    });
  });

  it('falls back to the run title when the plan does not parse', async () => {
    writeFileSync(join(dir, 'plans', 'v1.md'), 'just text');
    addRun();
    expect(await json(`/api/runs/${RUN_A}/plan`)).toEqual({
      text: 'just text',
      title: 'Add a thing',
      acceptanceCriteria: [],
    });
  });

  it('answers 404 when the plan file is missing', async () => {
    addRun({ planPath: join(dir, 'plans', 'nope.md') });
    expect((await req(`/api/runs/${RUN_A}/plan`)).status).toBe(404);
  });

  it('refuses a plan path outside the run directory, also through a symlink', async () => {
    writeFileSync(join(outside, 'secret.md'), 'secret');
    addRun({ planPath: join(outside, 'secret.md') });
    const res = await req(`/api/runs/${RUN_A}/plan`);
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain('secret"');

    symlinkSync(join(outside, 'secret.md'), join(dir, 'plans', 'link.md'));
    runs.updateRun(RUN_A, { planPath: join(dir, 'plans', 'link.md') });
    expect((await req(`/api/runs/${RUN_A}/plan`)).status).toBe(403);
    runs.updateRun(RUN_A, { planPath: relative(dir, join(outside, 'secret.md')) });
    expect((await req(`/api/runs/${RUN_A}/plan`)).status).toBe(403);
  });

  it('returns review rounds with the resolutions the fix reports record', async () => {
    addRun();
    writeFileSync(
      join(dir, 'reviews', 'round-1', 'findings.json'),
      JSON.stringify({
        reviewedSha: 'abcdef1234',
        summary: 'Two problems',
        findings: [finding('f1'), finding('f2', { severity: 'P3', location: null })],
      }),
    );
    writeFileSync(
      join(dir, 'reports', 'review-fix-1.json'),
      JSON.stringify({
        findingResolutions: [{ findingId: 'f1', resolution: 'fixed', note: 'done' }],
      }),
    );
    const review = runs.startStage({ runId: RUN_A, kind: 'review', round: 1 });
    runs.endStage(review, {
      state: 'succeeded',
      output: { findingsPath: join(dir, 'reviews', 'round-1', 'findings.json') },
    });
    const fix = runs.startStage({ runId: RUN_A, kind: 'review-fix', round: 1 });
    runs.endStage(fix, {
      state: 'succeeded',
      output: { report: join(dir, 'reports', 'review-fix-1.json') },
    });

    const body = (await json(`/api/runs/${RUN_A}/findings`)) as {
      rounds: { round: number; reviewedSha: string; summary: string; findings: unknown[] }[];
    };
    expect(body.rounds).toHaveLength(1);
    expect(body.rounds[0]).toMatchObject({
      round: 1,
      reviewedSha: 'abcdef1234',
      summary: 'Two problems',
    });
    expect(body.rounds[0]!.findings).toEqual([
      expect.objectContaining({
        id: 'f1',
        key: 'r1:f1',
        status: 'fixed',
        resolutionNote: 'done',
        triage: 'auto_fix',
        repeatOf: null,
      }),
      expect.objectContaining({ id: 'f2', status: 'open', triage: 'record' }),
    ]);
  });

  it('keeps resolutions per round when finding ids repeat, and none for a round without a fix', async () => {
    addRun();
    mkdirSync(join(dir, 'reviews', 'round-2'), { recursive: true });
    mkdirSync(join(dir, 'reviews', 'round-3'), { recursive: true });
    for (const n of [1, 2, 3]) {
      writeFileSync(
        join(dir, 'reviews', `round-${n}`, 'findings.json'),
        JSON.stringify({ reviewedSha: 'abcdef1234', summary: `r${n}`, findings: [finding('f_1')] }),
      );
    }
    const resolve = (n: number, resolution: string) => {
      writeFileSync(
        join(dir, 'reports', `review-fix-${n}.json`),
        JSON.stringify({ findingResolutions: [{ findingId: 'f_1', resolution, note: `n${n}` }] }),
      );
    };
    resolve(1, 'fixed');
    resolve(2, 'disputed');
    const review = (n: number) => {
      const id = runs.startStage({ runId: RUN_A, kind: 'review', round: n });
      runs.endStage(id, {
        state: 'succeeded',
        output: { findingsPath: join(dir, 'reviews', `round-${n}`, 'findings.json') },
      });
    };
    const fix = (n: number) => {
      const id = runs.startStage({ runId: RUN_A, kind: 'review-fix', round: n });
      runs.endStage(id, {
        state: 'succeeded',
        output: { report: join(dir, 'reports', `review-fix-${n}.json`) },
      });
    };
    review(1);
    fix(1);
    review(2);
    fix(2);
    review(3);

    const body = (await json(`/api/runs/${RUN_A}/findings`)) as {
      rounds: { findings: { status: string; resolutionNote: string | null }[] }[];
    };
    expect(body.rounds.map((r) => r.findings[0]!.status)).toEqual(['fixed', 'disputed', 'open']);
    expect(body.rounds[2]!.findings[0]!.resolutionNote).toBeNull();
  });

  it('merges per round: a file-only round 1 beside round 2 rows', async () => {
    addRun();
    writeFileSync(
      join(dir, 'reviews', 'round-1', 'findings.json'),
      JSON.stringify({ reviewedSha: 'abcdef1', summary: 'old', findings: [finding('f_1')] }),
    );
    const r1 = runs.startStage({ runId: RUN_A, kind: 'review', round: 1 });
    runs.endStage(r1, {
      state: 'succeeded',
      output: { findingsPath: join(dir, 'reviews', 'round-1', 'findings.json') },
    });
    const r2 = runs.startStage({
      runId: RUN_A,
      kind: 'review',
      round: 2,
      input: { reviewedSha: 'abcdef2' },
    });
    runs.endStage(r2, { state: 'succeeded', output: { summary: 'new' } });
    runs.insertFindings(RUN_A, 2, [finding('f_2_1') as never], () => 'auto_fix');
    const body = (await json(`/api/runs/${RUN_A}/findings`)) as {
      rounds: { round: number; summary: string; findings: { key: string }[] }[];
    };
    expect(body.rounds.map((r) => [r.round, r.summary, r.findings.map((f) => f.key)])).toEqual([
      [1, 'old', ['r1:f_1']],
      [2, 'new', ['r2:f_2_1']],
    ]);
  });

  it('returns stored rows, with rounds that found nothing, when the run has them', async () => {
    addRun();
    const stage = (round: number, sha: string, summary: string) => {
      const id = runs.startStage({
        runId: RUN_A,
        kind: 'review',
        round,
        input: { reviewedSha: sha },
      });
      runs.endStage(id, { state: 'succeeded', output: { summary } });
    };
    stage(1, 'abcdef1', 'first');
    stage(2, 'abcdef2', 'second');
    stage(3, 'abcdef3', 'clean');
    runs.insertFindings(RUN_A, 1, [finding('f_1_1') as never], () => 'auto_fix');
    runs.insertFindings(
      RUN_A,
      2,
      [{ ...finding('f_2_1'), repeatOf: 'r1:f_1_1' } as never],
      () => 'record',
    );
    runs.setFindingStatus(RUN_A, 'r1:f_1_1', 'fixed', 'done');
    const body = (await json(`/api/runs/${RUN_A}/findings`)) as {
      rounds: { round: number; reviewedSha: string; summary: string; findings: unknown[] }[];
    };
    expect(body.rounds.map((r) => [r.round, r.reviewedSha, r.summary, r.findings.length])).toEqual([
      [1, 'abcdef1', 'first', 1],
      [2, 'abcdef2', 'second', 1],
      [3, 'abcdef3', 'clean', 0],
    ]);
    expect(body.rounds[0]!.findings[0]).toMatchObject({
      key: 'r1:f_1_1',
      status: 'fixed',
      resolutionNote: 'done',
      triage: 'auto_fix',
    });
    expect(body.rounds[1]!.findings[0]).toMatchObject({ repeatOf: 'r1:f_1_1', triage: 'record' });
  });

  it('returns no rounds before any review, and skips unreadable findings files', async () => {
    addRun();
    expect(await json(`/api/runs/${RUN_A}/findings`)).toEqual({ rounds: [] });
    const review = runs.startStage({ runId: RUN_A, kind: 'review', round: 1 });
    runs.endStage(review, { state: 'succeeded', output: { findingsPath: join(dir, 'gone.json') } });
    expect(await json(`/api/runs/${RUN_A}/findings`)).toEqual({ rounds: [] });
  });

  it('refuses findings and reports outside the run directory, also through a symlink', async () => {
    addRun();
    writeFileSync(
      join(outside, 'findings.json'),
      JSON.stringify({ reviewedSha: 'abcdef1234', summary: 'leak', findings: [] }),
    );
    const review = runs.startStage({ runId: RUN_A, kind: 'review', round: 1 });
    runs.endStage(review, {
      state: 'succeeded',
      output: { findingsPath: join(outside, 'findings.json') },
    });
    const res = await req(`/api/runs/${RUN_A}/findings`);
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain('leak');
  });

  it('refuses findings reached through a symlinked directory inside the run directory', async () => {
    addRun();
    writeFileSync(
      join(outside, 'findings.json'),
      JSON.stringify({ reviewedSha: 'abcdef1234', summary: 'leak', findings: [] }),
    );
    symlinkSync(outside, join(dir, 'reviews', 'linked'));
    const review = runs.startStage({ runId: RUN_A, kind: 'review', round: 1 });
    runs.endStage(review, {
      state: 'succeeded',
      output: { findingsPath: join(dir, 'reviews', 'linked', 'findings.json') },
    });
    const res = await req(`/api/runs/${RUN_A}/findings`);
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain('leak');
  });

  it('allows a file whose name starts with two dots inside the run directory', async () => {
    writeFileSync(join(dir, 'plans', '..notes.md'), PLAN);
    addRun({ planPath: join(dir, 'plans', '..notes.md') });
    expect((await req(`/api/runs/${RUN_A}/plan`)).status).toBe(200);
  });

  it('refuses a fix report outside the run directory', async () => {
    addRun();
    writeFileSync(join(outside, 'r.json'), '{"findingResolutions":[]}');
    const fix = runs.startStage({ runId: RUN_A, kind: 'review-fix', round: 1 });
    runs.endStage(fix, { state: 'succeeded', output: { report: join(outside, 'r.json') } });
    expect((await req(`/api/runs/${RUN_A}/findings`)).status).toBe(403);
  });
});

describe('POST /api/projects', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, stdio: 'ignore' });

  it('registers a git repo with a GitHub origin, from any directory inside it', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bp-project-')));
    git(dir, 'init', '-q');
    git(dir, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
    mkdirSync(join(dir, 'sub'));

    const res = await post('/api/projects', { path: join(dir, 'sub') });
    expect(res.status).toBe(200);
    const { project } = (await res.json()) as { project: Record<string, unknown> };
    expect(project).toMatchObject({
      owner: 'acme',
      repo: 'widgets',
      localPath: dir,
      defaultBase: 'main',
    });
    expect(runs.listProjects().map((p) => p.localPath)).toContain(dir);

    // Registering again updates the same project.
    const again = (await (await post('/api/projects', { path: dir })).json()) as {
      project: { id: string };
    };
    expect(again.project.id).toBe(project.id);
  });

  it('rejects a directory that is not a git repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bp-not-git-'));
    const res = await post('/api/projects', { path: dir });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/not a git repository/);
    expect(runs.listProjects()).toHaveLength(1);
  });

  it('rejects a repository without a GitHub origin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bp-no-origin-'));
    git(dir, 'init', '-q');
    expect((await post('/api/projects', { path: dir })).status).toBe(400);
  });

  it('rejects malformed bodies and unknown fields', async () => {
    expect((await post('/api/projects', '{nope')).status).toBe(400);
    expect((await post('/api/projects', {})).status).toBe(400);
    expect((await post('/api/projects', { path: '/x', extra: 1 })).status).toBe(400);
  });
});

describe('POST /api/plans/validate', () => {
  it('returns the title and criteria of a valid plan', async () => {
    const res = await post('/api/plans/validate', { text: PLAN });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      title: 'Add widgets',
      acceptanceCriteria: ['Widgets exist', 'Widgets are blue'],
    });
  });

  it('returns the errors of an invalid plan', async () => {
    const res = await post('/api/plans/validate', { text: '# Title only\n' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; errors: string[] };
    expect(body.ok).toBe(false);
    expect(body.errors).toContain('Missing section: Goal');
  });

  it('rejects unknown fields', async () => {
    expect((await post('/api/plans/validate', { text: PLAN, x: 1 })).status).toBe(400);
  });
});

describe('POST /api/runs', () => {
  it('starts a run for a registered project and returns 201 with its id', async () => {
    const fake = fakeManager();
    const a = makeApp(runs, fake.manager);
    const res = await post(
      '/api/runs',
      { projectId, baseRef: 'main', planText: PLAN, title: 'T', mode: 'headless', publish: false },
      a,
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ runId: RUN_A });
    expect(fake.starts).toEqual([
      {
        projectId,
        baseRef: 'main',
        planText: PLAN,
        title: 'T',
        flags: { mode: 'headless', publish: false },
      },
    ]);
  });

  it('returns 400 with the plan errors for an invalid plan, starting nothing', async () => {
    const fake = fakeManager();
    const a = makeApp(runs, fake.manager);
    const res = await post('/api/runs', { projectId, baseRef: 'main', planText: '# T\n' }, a);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; errors: string[] };
    expect(body.error).toBe('invalid plan');
    expect(body.errors).toContain('Missing section: Approach');
    expect(fake.starts).toHaveLength(0);
  });

  it('passes on plan errors the manager reports', async () => {
    const fake = fakeManager({ fail: new PlanValidationError(['bad']) });
    const res = await post(
      '/api/runs',
      { projectId, baseRef: 'main', planText: PLAN },
      makeApp(runs, fake.manager),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid plan', errors: ['bad'] });
  });

  it('returns 404 for an unknown project', async () => {
    const fake = fakeManager();
    const res = await post(
      '/api/runs',
      { projectId: 'nope', baseRef: 'main', planText: PLAN },
      makeApp(runs, fake.manager),
    );
    expect(res.status).toBe(404);
    expect(fake.starts).toHaveLength(0);
  });

  it('returns 500 with the reason when the run cannot start', async () => {
    const fake = fakeManager({ fail: new Error('fetch failed') });
    const res = await post(
      '/api/runs',
      { projectId, baseRef: 'main', planText: PLAN },
      makeApp(runs, fake.manager),
    );
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain('fetch failed');
  });

  it('rejects unknown fields and missing ones', async () => {
    const a = makeApp(runs, fakeManager().manager);
    const base = { projectId, baseRef: 'main', planText: PLAN };
    expect((await post('/api/runs', { ...base, extra: true }, a)).status).toBe(400);
    expect((await post('/api/runs', { projectId, planText: PLAN }, a)).status).toBe(400);
    expect((await post('/api/runs', { ...base, mode: 'tmux' }, a)).status).toBe(400);
  });

  it('answers 503 when the server has no run manager', async () => {
    const res = await post('/api/runs', { projectId, baseRef: 'main', planText: PLAN });
    expect(res.status).toBe(503);
  });
});

describe('POST /api/runs/:id/cancel', () => {
  it('cancels runs the manager owns', async () => {
    const fake = fakeManager();
    const a = makeApp(runs, fake.manager);
    expect(await (await post(`/api/runs/${RUN_A}/cancel`, {}, a)).json()).toEqual({
      cancelled: true,
    });
    expect(await (await post(`/api/runs/${RUN_B}/cancel`, {}, a)).json()).toEqual({
      cancelled: false,
    });
    expect(fake.cancels).toEqual([RUN_A, RUN_B]);
    expect((await post('/api/runs/nope/cancel', {}, a)).status).toBe(400);
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
