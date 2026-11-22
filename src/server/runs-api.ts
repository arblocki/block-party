import type { Context, Hono } from 'hono';
import { isRunId } from '../core/run/id.js';
import type { Decision, Project, RunRow, RunStore } from '../core/store/runs.js';

export interface RunsApiDeps {
  runs: RunStore;
  /** How often streams re-read the database (default 500 ms). */
  pollMs?: number;
  /** How often streams send a `: hb` comment (default 15 s). */
  heartbeatMs?: number;
}

/** A run as the run list shows it. */
export interface RunSummary {
  id: string;
  title: string;
  stage: RunRow['stage'];
  stageNote: string | null;
  owner: string | null;
  repo: string | null;
  branch: string;
  prNumber: number | null;
  createdAt: string;
  updatedAt: string;
  openDecisions: number;
}

/** An inbox item with the run it belongs to. */
export interface InboxDecision extends Decision {
  runTitle: string | null;
  runStage: RunRow['stage'] | null;
}

const DEFAULT_RUN_LIMIT = 100;
const MAX_RUN_LIMIT = 500;
const DEFAULT_EVENT_LIMIT = 500;
const MAX_EVENT_LIMIT = 2000;
/** Decisions the global stream's `inbox` frame carries. */
const INBOX_FRAME_DECISIONS = 20;

/** A non-negative integer query value; `undefined` when absent, `null` when malformed. */
function intParam(raw: string | undefined): number | undefined | null {
  if (raw === undefined || raw === '') return undefined;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

const badRequest = (c: Context, error: string) => c.json({ error }, 400);

export function registerRunsApi(app: Hono, deps: RunsApiDeps): void {
  const { runs } = deps;
  const pollMs = deps.pollMs ?? 500;
  const heartbeatMs = deps.heartbeatMs ?? 15_000;

  const projectsById = (): Map<string, Project> =>
    new Map(runs.listProjects().map((p) => [p.id, p]));

  const summarize = (
    run: RunRow,
    projects: Map<string, Project>,
    openByRun: Map<string, number>,
  ): RunSummary => {
    const project = projects.get(run.projectId);
    return {
      id: run.id,
      title: run.title,
      stage: run.stage,
      stageNote: run.stageNote,
      owner: project?.owner ?? null,
      repo: project?.repo ?? null,
      branch: run.branch,
      prNumber: run.prNumber,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      openDecisions: openByRun.get(run.id) ?? 0,
    };
  };

  const openCounts = (): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const d of runs.listDecisions({ status: 'open' })) {
      counts.set(d.runId, (counts.get(d.runId) ?? 0) + 1);
    }
    return counts;
  };

  const runSummaries = (opts: { active?: boolean; limit?: number }): RunSummary[] => {
    const projects = projectsById();
    const open = openCounts();
    return runs.listRuns(opts).map((r) => summarize(r, projects, open));
  };

  const runSummary = (run: RunRow): RunSummary => {
    const project = runs.getProject(run.projectId);
    const open = runs.listDecisions({ status: 'open', runId: run.id }).length;
    return summarize(
      run,
      new Map(project ? [[project.id, project]] : []),
      new Map([[run.id, open]]),
    );
  };

  const inboxItems = (decisions: Decision[]): InboxDecision[] => {
    const byId = new Map<string, RunRow | undefined>();
    return decisions.map((d) => {
      if (!byId.has(d.runId)) byId.set(d.runId, runs.getRun(d.runId));
      const run = byId.get(d.runId);
      return { ...d, runTitle: run?.title ?? null, runStage: run?.stage ?? null };
    });
  };

  /** The run named by `:id`, or the error response to send. */
  const runOf = (c: Context): RunRow | Response => {
    const id = c.req.param('id') ?? '';
    if (!isRunId(id)) return badRequest(c, 'invalid run id');
    return runs.getRun(id) ?? c.json({ error: 'run not found' }, 404);
  };

  app.get('/api/runs', (c) => {
    const limit = intParam(c.req.query('limit'));
    if (limit === null || limit === 0) return badRequest(c, 'invalid limit');
    const active = c.req.query('active');
    return c.json({
      runs: runSummaries({
        active: active === '1' || active === 'true',
        limit: Math.min(limit ?? DEFAULT_RUN_LIMIT, MAX_RUN_LIMIT),
      }),
    });
  });

  app.get('/api/runs/:id', (c) => {
    const run = runOf(c);
    if (run instanceof Response) return run;
    return c.json({
      run: { ...run, ...runSummary(run) },
      stages: runs.listStages(run.id),
      decisions: runs.listDecisions({ runId: run.id }),
    });
  });

  app.get('/api/runs/:id/events', (c) => {
    const run = runOf(c);
    if (run instanceof Response) return run;
    const after = intParam(c.req.query('after'));
    const limit = intParam(c.req.query('limit'));
    if (after === null) return badRequest(c, 'invalid after');
    if (limit === null || limit === 0) return badRequest(c, 'invalid limit');
    const events = runs.listEvents(run.id, {
      afterId: after ?? 0,
      limit: Math.min(limit ?? DEFAULT_EVENT_LIMIT, MAX_EVENT_LIMIT),
    });
    return c.json({ events, lastId: events.at(-1)?.id ?? after ?? 0 });
  });

  app.get('/api/runs/:id/stream', (c) => {
    const run = runOf(c);
    if (run instanceof Response) return run;
    // A reconnecting client repeats the original URL, so its Last-Event-ID is the newer point.
    const resume = c.req.header('last-event-id') ?? c.req.query('after');
    const after = intParam(resume);
    if (after === null) return badRequest(c, 'invalid after');
    // Without a resume point, only events appended from now on are sent.
    let lastId = after ?? runs.latestEventId();
    let updatedAt: string | undefined;
    return sseResponse(c.req.raw.signal, { pollMs, heartbeatMs }, (send) => {
      for (const event of runs.listEvents(run.id, {
        afterId: lastId,
        limit: DEFAULT_EVENT_LIMIT,
      })) {
        send({ event: 'run-event', id: String(event.id), data: event });
        lastId = event.id;
      }
      const current = runs.getRun(run.id);
      if (current && current.updatedAt !== updatedAt) {
        updatedAt = current.updatedAt;
        send({ event: 'run', data: runSummary(current) });
      }
    });
  });

  app.get('/api/stream', (c) => {
    let lastRuns: string | undefined;
    let lastInbox: string | undefined;
    return sseResponse(c.req.raw.signal, { pollMs, heartbeatMs }, (send) => {
      const runsJson = JSON.stringify({ runs: runSummaries({ limit: DEFAULT_RUN_LIMIT }) });
      if (runsJson !== lastRuns) {
        lastRuns = runsJson;
        send({ event: 'runs', data: runsJson });
      }
      const open = runs.listDecisions({ status: 'open' });
      const inboxJson = JSON.stringify({
        openCount: open.length,
        decisions: inboxItems(open.slice(0, INBOX_FRAME_DECISIONS)),
      });
      if (inboxJson !== lastInbox) {
        lastInbox = inboxJson;
        send({ event: 'inbox', data: inboxJson });
      }
    });
  });

  app.get('/api/inbox', (c) => {
    const status = c.req.query('status') ?? 'open';
    if (status !== 'open' && status !== 'all') return badRequest(c, 'invalid status');
    const decisions = runs.listDecisions(status === 'open' ? { status: 'open' } : {});
    return c.json({ decisions: inboxItems(decisions) });
  });

  app.post('/api/inbox/:id/dismiss', (c) => {
    const id = intParam(c.req.param('id'));
    if (id === null || id === undefined || id === 0) return badRequest(c, 'invalid decision id');
    return c.json({ changed: runs.dismissDecision(id) });
  });

  app.get('/api/projects', (c) => c.json({ projects: runs.listProjects() }));
}

interface SseFrame {
  event: string;
  id?: string;
  /** Serialized as JSON unless already a string. */
  data: unknown;
}

function frameText({ event, id, data }: SseFrame): string {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  let out = `event: ${event}\n`;
  if (id !== undefined) out += `id: ${id}\n`;
  for (const line of text.split(/\r\n|\r|\n/)) out += `data: ${line}\n`;
  return `${out}\n`;
}

/**
 * A `text/event-stream` response that calls `poll` right away and then every `pollMs`, and
 * sends a heartbeat comment every `heartbeatMs`. Everything stops when the client goes away
 * (request aborted or body cancelled) or `poll` throws; no timer outlives the stream.
 */
function sseResponse(
  signal: AbortSignal,
  timing: { pollMs: number; heartbeatMs: number },
  poll: (send: (frame: SseFrame) => void) => void,
): Response {
  const encoder = new TextEncoder();
  let stop: () => void = () => {};

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let pollTimer: ReturnType<typeof setTimeout> | undefined;
      const write = (text: string): void => {
        if (!closed) controller.enqueue(encoder.encode(text));
      };
      const heartbeat = setInterval(() => write(': hb\n\n'), timing.heartbeatMs);

      stop = () => {
        if (closed) return;
        closed = true;
        clearTimeout(pollTimer);
        clearInterval(heartbeat);
        signal.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        stop();
        try {
          controller.close();
        } catch {
          // already closed or cancelled
        }
      };

      const tick = (): void => {
        if (closed) return;
        try {
          poll((frame) => write(frameText(frame)));
        } catch (err) {
          stop();
          controller.error(err);
          return;
        }
        pollTimer = setTimeout(tick, timing.pollMs);
      };

      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort);
      tick();
    },
    cancel() {
      stop();
    },
  });

  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
    },
  });
}
