import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { createGit, type Git } from '../core/git/index.js';
import type { RunFlagOverrides } from '../core/run/config.js';
import { isTerminal } from '../core/run/machine.js';
import { isRunId } from '../core/run/id.js';
import { parsePlan } from '../core/run/plan.js';
import { orderTurns, ReportSchema, TURN_KINDS, type Report } from '../core/run/report.js';
import { buildSendBackFeedback } from '../core/run/send-back.js';
import { ReviewerOutputSchema } from '../core/reviewer/findings.js';
import type {
  Decision,
  PlanRow,
  FindingRow,
  FindingStatus,
  Project,
  RunRow,
  RunStore,
  StageRow,
} from '../core/store/runs.js';
import { reopenRestDecision } from '../core/run/rest-decision.js';
import {
  InvalidStartError,
  PlanValidationError,
  UnknownProjectError,
  type RunManager,
} from './run-manager.js';
import { matchCriteria, normalizeCriterion } from './acceptance-match.js';
import { parseBody } from './state.js';

export interface RunsApiDeps {
  runs: RunStore;
  /** Starts and cancels runs; without one, `POST /api/runs` answers 503. */
  manager?: RunManager;
  /** Resolves a project's repository (default: the real git service). */
  git?: Pick<Git, 'repoRoot' | 'originRepo' | 'defaultBranch'>;
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
  /** The latest stored plan version, or null when the run has none. */
  planVersion: number | null;
  /** Where a run waiting for a free slot stands; null for any other run. */
  queue: {
    position: number;
    inUse: number | null;
    max: number | null;
    /** Set when the run waits because its repository is full, not the whole machine. */
    perProjectMax: number | null;
  } | null;
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

/** A file the run's rows point at lies outside that run's directory. */
class OutsideRunDirError extends Error {}

/**
 * Reads `path` as UTF-8 text, but only if its real path (symlinks resolved) is inside the real
 * `runDir`. Throws OutsideRunDirError otherwise; other failures (missing file) pass through.
 */
function readInsideRunDir(runDir: string, path: string): string {
  const root = realpathSync(runDir);
  const real = realpathSync(resolve(runDir, path));
  const rel = relative(root, real);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new OutsideRunDirError(`${path} is outside the run directory`);
  }
  return readFileSync(real, 'utf8');
}

const readJsonInside = (runDir: string, path: string): unknown =>
  JSON.parse(readInsideRunDir(runDir, path));

const stringField = (value: unknown, key: string): string | null => {
  const v = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : null;
  return typeof v === 'string' ? v : null;
};

const badRequest = (c: Context, error: string) => c.json({ error }, 400);

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** One review round of GET /api/runs/:id/findings. */
interface FindingsRound {
  round: number;
  reviewedSha: string;
  summary: string;
  findings: FindingRow[];
}

const RESOLVED_STATUS: Record<string, FindingStatus> = {
  fixed: 'fixed',
  disputed: 'disputed',
  deferred: 'deferred',
};

/** A finding from a findings file, in the shape of a stored row (for runs without rows). */
function fileRow(
  runId: string,
  round: number,
  f: z.infer<typeof ReviewerOutputSchema>['findings'][number],
  said: { resolution: string; note: string } | undefined,
): FindingRow {
  return {
    runId,
    round,
    id: f.id,
    key: `r${round}:${f.id}`,
    reviewedSha: f.reviewedSha,
    severity: f.severity,
    category: f.category,
    title: f.title,
    body: f.body,
    location: f.location,
    confidence: f.confidence,
    suggestedFix: f.suggestedFix,
    repeatOf: f.repeatOf,
    triage: f.severity === 'P0' || f.severity === 'P1' ? 'auto_fix' : 'record',
    status: (said && RESOLVED_STATUS[said.resolution]) || 'open',
    resolutionNote: said?.note ?? null,
    updatedAt: '',
  };
}

/** Rounds from stored rows; a round that found nothing has no rows, so its stage lists it. */
function storedRounds(stages: StageRow[], rows: FindingRow[]): FindingsRound[] {
  const rounds = new Map<number, FindingsRound>();
  for (const st of stages) {
    if (st.kind !== 'review' || st.state !== 'succeeded') continue;
    rounds.set(st.round, {
      round: st.round,
      reviewedSha: stringField(st.input, 'reviewedSha') ?? '',
      summary: stringField(st.output, 'summary') ?? '',
      findings: [],
    });
  }
  for (const row of rows) {
    const r = rounds.get(row.round) ?? {
      round: row.round,
      reviewedSha: row.reviewedSha,
      summary: '',
      findings: [],
    };
    rounds.set(row.round, r);
    r.findings.push(row);
  }
  return [...rounds.values()].sort((a, b) => a.round - b.round);
}

/** Stored rounds, with the file-based round standing in for one that has no rows. */
function mergeRounds(stored: FindingsRound[], fromFiles: FindingsRound[]): FindingsRound[] {
  const out = new Map(fromFiles.map((r) => [r.round, r]));
  for (const r of stored) {
    const file = out.get(r.round);
    if (r.findings.length > 0 || !file) out.set(r.round, r);
  }
  return [...out.values()].sort((a, b) => a.round - b.round);
}

const projectSchema = z.strictObject({ path: z.string().trim().min(1) });

const MAX_NOTE_CHARS = 4000;
const MAX_DESCRIPTION_CHARS = 20_000;

const answerSchema = z.strictObject({
  choice: z.string().min(1),
  note: z.string().max(MAX_NOTE_CHARS).nullish(),
});

/**
 * Send-back feedback is built from findings and comments, so it may be longer than an answer's
 * note (MAX_NOTE_CHARS): its own cap applies to this path only.
 */
const MAX_FEEDBACK_CHARS = 100_000;

const sendBackSchema = z.strictObject({
  findingKeys: z.array(z.string().min(1).max(100)).max(200),
  comments: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(1000),
        line: z.number().int().positive().nullable(),
        body: z.string().trim().min(1).max(MAX_NOTE_CHARS),
      }),
    )
    .max(200),
  note: z.string().max(MAX_NOTE_CHARS).nullish(),
});

const validatePlanSchema = z.strictObject({ text: z.string() });

const startRunSchema = z.strictObject({
  projectId: z.string().min(1),
  baseRef: z.string().trim().min(1),
  planText: z.string().optional(),
  description: z.string().trim().min(1).max(MAX_DESCRIPTION_CHARS).optional(),
  title: z.string().trim().min(1).optional(),
  mode: z.enum(['pane', 'headless']).optional(),
  model: z.string().trim().min(1).optional(),
  publish: z.boolean().optional(),
});

export function registerRunsApi(app: Hono, deps: RunsApiDeps): void {
  const { runs } = deps;
  const pollMs = deps.pollMs ?? 500;
  const heartbeatMs = deps.heartbeatMs ?? 15_000;

  const projectsById = (): Map<string, Project> =>
    new Map(runs.listProjects().map((p) => [p.id, p]));

  /** Queue positions (1 is next) and slot use, read once per list. */
  const queueInfo = (): ((run: RunRow) => RunSummary['queue']) => {
    const position = new Map<string, number>();
    try {
      runs.listQueued().forEach((q, i) => position.set(q.runId, i + 1));
    } catch {
      // The position is informational.
    }
    const status = deps.manager?.status();
    return (run) => {
      const at = run.stage === 'queued' ? position.get(run.id) : undefined;
      if (at === undefined) return null;
      // Held back by its own repository while the machine has room: the total would mislead.
      const byProject =
        status !== undefined &&
        status.inUse < status.maxRuns &&
        (status.perProject[run.projectId] ?? 0) >= status.maxRunsPerProject;
      return {
        position: at,
        inUse: status?.inUse ?? null,
        max: status?.maxRuns ?? null,
        perProjectMax: byProject ? status.maxRunsPerProject : null,
      };
    };
  };

  const summarize = (
    run: RunRow,
    projects: Map<string, Project>,
    openByRun: Map<string, number>,
    queueOf: (run: RunRow) => RunSummary['queue'],
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
      planVersion: runs.listPlans(run.id).at(-1)?.version ?? null,
      queue: queueOf(run),
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
    const queueOf = queueInfo();
    return runs.listRuns(opts).map((r) => summarize(r, projects, open, queueOf));
  };

  const runSummary = (run: RunRow): RunSummary => {
    const project = runs.getProject(run.projectId);
    const open = runs.listDecisions({ status: 'open', runId: run.id }).length;
    return summarize(
      run,
      new Map(project ? [[project.id, project]] : []),
      new Map([[run.id, open]]),
      queueInfo(),
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

  /** One plan version as the API shows it; `text` is null when its file cannot be read. */
  const planView = (run: RunRow, p: PlanRow) => {
    let text: string | null = null;
    try {
      text = readInsideRunDir(run.runDir, p.path);
    } catch (e) {
      if (e instanceof OutsideRunDirError) throw e;
    }
    return {
      version: p.version,
      title: p.title,
      status: p.status,
      createdBy: p.createdBy,
      feedback: p.feedback,
      createdAt: p.createdAt,
      text,
      acceptanceCriteria: (() => {
        const parsed = text === null ? null : parsePlan(text);
        return parsed?.ok ? parsed.plan.acceptanceCriteria : [];
      })(),
    };
  };

  app.get('/api/runs/:id/plans', (c) => {
    const run = runOf(c);
    if (run instanceof Response) return run;
    try {
      return c.json({ plans: runs.listPlans(run.id).map((p) => planView(run, p)) });
    } catch (e) {
      if (e instanceof OutsideRunDirError) return c.json({ error: errorMessage(e) }, 403);
      throw e;
    }
  });

  app.get('/api/runs/:id/plan', (c) => {
    const run = runOf(c);
    if (run instanceof Response) return run;
    // The approved version, else the latest; a run from before plan rows has only its file.
    const plans = runs.listPlans(run.id);
    const chosen = plans.find((p) => p.status === 'approved') ?? plans.at(-1);
    const path = chosen?.path ?? run.planPath;
    if (path === '') return c.json({ error: 'plan not found' }, 404);
    let text: string;
    try {
      text = readInsideRunDir(run.runDir, path);
    } catch (e) {
      if (e instanceof OutsideRunDirError) return c.json({ error: errorMessage(e) }, 403);
      return c.json({ error: 'plan not found' }, 404);
    }
    const parsed = parsePlan(text);
    return c.json({
      text,
      title: parsed.ok ? parsed.plan.title : run.title,
      acceptanceCriteria: parsed.ok ? parsed.plan.acceptanceCriteria : [],
      ...(chosen ? { version: chosen.version, status: chosen.status } : {}),
    });
  });

  /**
   * Each approved-plan criterion with the newest implementer report entry that mentions it.
   * Report entries matching no criterion follow, marked `extra`. A report that lies outside
   * the run directory is never read and is named in `skipped`. Throws for the plan only.
   */
  const acceptanceOf = (run: RunRow) => {
    const plans = runs.listPlans(run.id);
    // Only an approved plan has criteria; a run from before plan rows has just its file.
    const path = plans.length > 0 ? plans.find((p) => p.status === 'approved')?.path : run.planPath;
    if (!path) return { criteria: [], skipped: [] };
    let planText: string;
    try {
      planText = readInsideRunDir(run.runDir, path);
    } catch (e) {
      if (e instanceof OutsideRunDirError) throw e;
      return { criteria: [], skipped: [] };
    }
    const parsed = parsePlan(planText);
    const criteria = parsed.ok ? parsed.plan.acceptanceCriteria : [];
    let names: string[] = [];
    try {
      names = readdirSync(resolve(run.runDir, 'reports'));
    } catch {
      // No reports yet.
    }
    const skipped: string[] = [];
    const turns: { kind: string; round: number; entries: Report['acceptance'] }[] = [];
    for (const name of names) {
      const m = /^(.+)-(\d+)\.json$/.exec(name);
      if (!m || !TURN_KINDS.includes(m[1]!)) continue;
      let raw: unknown;
      try {
        raw = readJsonInside(run.runDir, `reports/${name}`);
      } catch (e) {
        if (e instanceof OutsideRunDirError) skipped.push(name);
        continue;
      }
      const report = ReportSchema.safeParse(raw);
      if (report.success) {
        turns.push({ kind: m[1]!, round: Number(m[2]), entries: report.data.acceptance });
      }
    }
    type Entry = { criterion: string; status: string; evidence: string; fromReport: string };
    const latest = new Map<string, Entry>();
    for (const t of orderTurns(turns, runs.listStages(run.id))) {
      for (const e of t.entries) {
        const key = normalizeCriterion(e.criterion);
        latest.set(key, { ...e, fromReport: `${t.kind}-${t.round}` });
      }
    }
    const reported = [...latest.values()];
    const matched = matchCriteria(
      criteria,
      reported.map((e) => e.criterion),
    );
    const used = new Set(matched.values());
    const list = [
      ...criteria.map((criterion, i) => {
        const j = matched.get(i);
        return j !== undefined
          ? { ...reported[j]!, criterion }
          : { criterion, status: 'unverified', evidence: '', fromReport: null };
      }),
      ...reported.filter((_, j) => !used.has(j)).map((e) => ({ ...e, extra: true })),
    ];
    return { criteria: list, skipped };
  };

  app.get('/api/runs/:id/acceptance', (c) => {
    const run = runOf(c);
    if (run instanceof Response) return run;
    try {
      return c.json(acceptanceOf(run));
    } catch (e) {
      if (e instanceof OutsideRunDirError) return c.json({ error: errorMessage(e) }, 403);
      throw e;
    }
  });

  /** The run's review rounds with their findings; throws OutsideRunDirError. */
  const findingsOf = (run: RunRow): FindingsRound[] => {
    const stages = runs.listStages(run.id);
    const stored = runs.listFindings(run.id);
    // What the implementer said about each finding, from its review-fix reports. Finding ids
    // repeat across rounds (f_1 ...), so each report belongs to the review it followed: the
    // closest earlier review stage (stages come in execution order).
    type Resolutions = Record<string, { resolution: string; note: string }>;
    const resolutionsByReview = new Map<number, Resolutions>();
    const rounds: FindingsRound[] = [];
    let lastReviewId: number | null = null;
    for (const st of stages) {
      if (st.kind === 'review') lastReviewId = st.id;
      const reportPath = st.kind === 'review-fix' ? stringField(st.output, 'report') : null;
      if (!reportPath) continue;
      let report: unknown;
      try {
        report = readJsonInside(run.runDir, reportPath);
      } catch (e) {
        if (e instanceof OutsideRunDirError) throw e;
        continue;
      }
      // A fix with no review before it has no round to show on, but is still read above.
      if (lastReviewId === null) continue;
      const resolutions: Resolutions = resolutionsByReview.get(lastReviewId) ?? {};
      resolutionsByReview.set(lastReviewId, resolutions);
      const list = (report as { findingResolutions?: unknown } | null)?.findingResolutions;
      for (const r of Array.isArray(list) ? list : []) {
        const id = stringField(r, 'findingId');
        const resolution = stringField(r, 'resolution');
        if (id && resolution) resolutions[id] = { resolution, note: stringField(r, 'note') ?? '' };
      }
    }
    for (const st of stages) {
      const path = st.kind === 'review' ? stringField(st.output, 'findingsPath') : null;
      if (!path) continue;
      let raw: unknown;
      try {
        raw = readJsonInside(run.runDir, path);
      } catch (e) {
        if (e instanceof OutsideRunDirError) throw e;
        continue;
      }
      const out = ReviewerOutputSchema.safeParse(raw);
      if (!out.success) continue;
      const resolutions = resolutionsByReview.get(st.id) ?? {};
      rounds.push({
        round: st.round,
        reviewedSha: out.data.reviewedSha,
        summary: out.data.summary,
        findings: out.data.findings.map((f) => fileRow(run.id, st.round, f, resolutions[f.id])),
      });
    }
    // Rounds with stored rows use them; rounds from before rows existed keep the file answer.
    return stored.length > 0 ? mergeRounds(storedRounds(stages, stored), rounds) : rounds;
  };

  app.get('/api/runs/:id/findings', (c) => {
    const run = runOf(c);
    if (run instanceof Response) return run;
    try {
      return c.json({ rounds: findingsOf(run) });
    } catch (e) {
      if (e instanceof OutsideRunDirError) return c.json({ error: errorMessage(e) }, 403);
      throw e;
    }
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
        // Carries the cursor as its id, so a client that drops before any run event still
        // resumes from here instead of from a new "latest" (which would skip events).
        send({ event: 'run', id: String(lastId), data: runSummary(current) });
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
    // An unanswered question would strand the run that waits on it, unless the run ended.
    const existing = runs.getDecision(id);
    if (existing?.options?.length) {
      const run = runs.getRun(existing.runId);
      if (!run || !isTerminal(run.stage)) {
        return c.json({ error: 'this decision has options: answer it instead' }, 409);
      }
    }
    return c.json({ changed: runs.dismissDecision(id) });
  });

  const resumeRefused = (c: Context, why: 'busy' | 'not_resumable'): Response =>
    c.json(
      {
        error:
          why === 'busy'
            ? 'This run is already being resumed.'
            : 'This run is not stopped, so it cannot be resumed.',
      },
      409,
    );

  /**
   * Answers a decision and, for the kinds that continue a run, starts that continuation. The
   * one place both `POST /api/inbox/:id/answer` and `POST /api/runs/:id/send-back` go through,
   * so a double submit starts at most one continuation.
   */
  const answerAndContinue = async (
    c: Context,
    id: number,
    choice: string,
    note: string | null,
    findingKeys: string[] = [],
  ): Promise<Response> => {
    const existing = runs.getDecision(id);
    if (!existing) return c.json({ error: 'decision not found' }, 404);
    const isFinalReview = existing.kind === 'final_review';
    const isPlanApproval = existing.kind === 'plan_approval';
    // A stopped run's question: answering `resume` (or `keep`, after the worktree question)
    // resumes the run.
    const isResume =
      (choice === 'resume' && ['interrupted', 'blocked', 'cap_reached'].includes(existing.kind)) ||
      (choice === 'keep' && existing.kind === 'resume_conflict');
    // Cancelling from the worktree question ends the stopped run (its files stay).
    const isCancelStopped = choice === 'cancel' && existing.kind === 'resume_conflict';
    if ((isResume || isCancelStopped) && !deps.manager)
      return c.json({ error: 'this server cannot continue runs' }, 503);
    if (isFinalReview || isPlanApproval) {
      // Checked before answering: an answer that cannot start its continuation would strand the run.
      if (!deps.manager) return c.json({ error: 'this server cannot continue runs' }, 503);
      if (isFinalReview && choice === 'send_back' && !note) {
        return badRequest(c, 'a note is required to send the run back');
      }
      if (isPlanApproval && choice === 'revise' && !note) {
        return badRequest(c, 'a note is required to request changes');
      }
    }
    // Dismissing a stopped run's question ends it as dismissed, as the inbox's own button does.
    if (
      choice === 'dismiss' &&
      ['interrupted', 'blocked', 'cap_reached'].includes(existing.kind) &&
      existing.options?.some((o) => o.id === 'dismiss')
    ) {
      if (!runs.dismissDecision(id)) return c.json({ error: 'decision is not open' }, 409);
      return c.json({ decision: runs.getDecision(id) });
    }
    const result = runs.answerDecision(id, { choice, note });
    if (result === 'not_open') return c.json({ error: 'decision is not open' }, 409);
    if (result === 'run_ended') return c.json({ error: 'the run has ended' }, 409);
    if (result === 'bad_choice') return badRequest(c, 'choice is not one of the options');
    // Only the one request that answered the decision gets here, so it starts one continuation.
    let continued: boolean | undefined;
    if (isFinalReview) {
      continued = deps.manager!.continue(
        existing.runId,
        choice === 'approve'
          ? { kind: 'approve' }
          : { kind: 'feedback', text: note!, ...(findingKeys.length > 0 ? { findingKeys } : {}) },
      );
    } else if (isPlanApproval) {
      continued = deps.manager!.continue(
        existing.runId,
        choice === 'approve' ? { kind: 'plan_approve' } : { kind: 'plan_revise', note: note! },
      );
    }
    if (isCancelStopped) {
      const cancelled = await deps.manager!.cancel(existing.runId);
      if (cancelled === false) {
        // Nothing was cancelled: the question is asked again, as for any answer that fails.
        const reason = 'the run is no longer stopped, or is busy';
        const open = runs.listDecisions({ runId: existing.runId, status: 'open' });
        if (!open.some((d) => d.kind === 'resume_conflict')) {
          runs.openDecision({
            runId: existing.runId,
            kind: 'resume_conflict',
            title: existing.title,
            body: `${existing.body} Your answer could not be carried out: ${reason}.`,
            attach: existing.attach,
            options: existing.options,
          });
        }
        return c.json({ error: `The run could not be cancelled: ${reason}.` }, 409);
      }
      if (cancelled === 'pending') {
        return c.json(
          { decision: runs.getDecision(id), continued: true, state: 'cancelling' },
          202,
        );
      }
      continued = true;
    }
    if (isResume) {
      const started = deps.manager!.resume(
        existing.runId,
        choice === 'keep' ? { keep: true } : undefined,
      );
      if (started !== 'started') return resumeRefused(c, started);
      continued = true;
    }
    if (continued === false) {
      // The answer is recorded but nothing carries it out: ask the question again.
      const reason = 'the server could not start it (the run is busy or no longer waiting)';
      reopenRestDecision(runs, existing.runId, reason);
      return c.json({ error: `The answer could not be carried out: ${reason}` }, 409);
    }
    return c.json({
      decision: runs.getDecision(id),
      ...(continued === undefined ? {} : { continued }),
    });
  };

  app.post('/api/inbox/:id/answer', async (c) => {
    const id = intParam(c.req.param('id'));
    if (id === null || id === undefined || id === 0) return badRequest(c, 'invalid decision id');
    if (!runs.getDecision(id)) return c.json({ error: 'decision not found' }, 404);
    const body = await parseBody(c, answerSchema);
    if ('error' in body) return c.json({ error: body.error }, 400);
    return await answerAndContinue(c, id, body.data.choice, body.data.note?.trim() || null);
  });

  app.get('/api/pr-run', (c) => {
    const owner = c.req.query('owner');
    const repo = c.req.query('repo');
    const pr = intParam(c.req.query('pr'));
    if (!owner || !repo || pr === undefined || pr === null || pr === 0) {
      return badRequest(c, 'owner, repo and pr are required');
    }
    const run = runs.findRunByPr(owner, repo, pr);
    return c.json({ run: run ? runSummary(run) : null });
  });

  app.post('/api/runs/:id/send-back', async (c) => {
    const run = runOf(c);
    if (run instanceof Response) return run;
    const body = await parseBody(c, sendBackSchema);
    if ('error' in body) return c.json({ error: body.error }, 400);
    const { findingKeys, comments } = body.data;
    const note = body.data.note?.trim() || null;
    const decision =
      run.stage === 'awaiting_review'
        ? runs
            .listDecisions({ runId: run.id, status: 'open' })
            .find((d) => d.kind === 'final_review')
        : undefined;
    if (!decision) return c.json({ error: 'the run is not waiting for review' }, 409);
    if (findingKeys.length === 0 && comments.length === 0 && !note) {
      return badRequest(c, 'nothing to send: choose a finding, a comment or write a note');
    }
    let rounds: FindingsRound[];
    try {
      rounds = findingsOf(run);
    } catch (e) {
      if (e instanceof OutsideRunDirError) return c.json({ error: errorMessage(e) }, 403);
      throw e;
    }
    const byKey = new Map(rounds.flatMap((r) => r.findings).map((f) => [f.key, f]));
    const unique = [...new Set(findingKeys)];
    const unknown = unique.filter((k) => !byKey.has(k));
    if (unknown.length > 0) return badRequest(c, `unknown finding: ${unknown.join(', ')}`);
    const text = buildSendBackFeedback({
      findings: unique.map((k) => byKey.get(k)!),
      comments,
      note,
    });
    if (text.length > MAX_FEEDBACK_CHARS) {
      // Name the biggest item, so the reviewer knows what to trim.
      const sizes: { what: string; size: number }[] = [
        ...unique.map((k) => ({
          what: `finding ${k}`,
          size: buildSendBackFeedback({ findings: [byKey.get(k)!], comments: [], note: null })
            .length,
        })),
        ...comments.map((cm, i) => ({
          what: `comment ${i + 1} (${cm.path}${cm.line === null ? '' : `:${cm.line}`})`,
          size: cm.body.length,
        })),
        ...(note ? [{ what: 'the note', size: note.length }] : []),
      ];
      const longest = sizes.sort((a, b) => b.size - a.size)[0]!;
      return badRequest(
        c,
        `the feedback is too long (${text.length} of ${MAX_FEEDBACK_CHARS} characters); the longest item is ${longest.what} (${longest.size} characters)`,
      );
    }
    return answerAndContinue(c, decision.id, 'send_back', text, unique);
  });

  app.get('/api/projects', (c) => c.json({ projects: runs.listProjects() }));

  const git = deps.git ?? createGit();
  app.post('/api/projects', async (c) => {
    const body = await parseBody(c, projectSchema);
    if ('error' in body) return c.json({ error: body.error }, 400);
    let localPath: string;
    let origin: { owner: string; repo: string };
    let defaultBase: string;
    try {
      localPath = await git.repoRoot(resolve(body.data.path));
      origin = await git.originRepo(localPath);
      defaultBase = await git.defaultBranch(localPath);
    } catch (e) {
      return badRequest(c, `not a git repository with a GitHub origin: ${errorMessage(e)}`);
    }
    return c.json({ project: runs.upsertProject({ ...origin, localPath, defaultBase }) });
  });

  app.post('/api/plans/validate', async (c) => {
    const body = await parseBody(c, validatePlanSchema);
    if ('error' in body) return c.json({ error: body.error }, 400);
    const parsed = parsePlan(body.data.text);
    return c.json(
      parsed.ok
        ? {
            ok: true,
            title: parsed.plan.title,
            acceptanceCriteria: parsed.plan.acceptanceCriteria,
          }
        : { ok: false, errors: parsed.errors },
    );
  });

  app.post('/api/runs', async (c) => {
    const body = await parseBody(c, startRunSchema);
    if ('error' in body) return c.json({ error: body.error }, 400);
    const { projectId, baseRef, planText, description, title, mode, model, publish } = body.data;
    if ((planText === undefined) === (description === undefined)) {
      return badRequest(c, 'give either planText or description');
    }
    // Checked here as well as by the manager, so these answers do not depend on it.
    if (!runs.getProject(projectId)) return c.json({ error: 'project not found' }, 404);
    if (planText !== undefined) {
      const parsed = parsePlan(planText);
      if (!parsed.ok) return c.json({ error: 'invalid plan', errors: parsed.errors }, 400);
    }
    const { manager } = deps;
    if (!manager) return c.json({ error: 'this server cannot start runs' }, 503);
    const flags: RunFlagOverrides = {};
    if (mode) flags.mode = mode;
    if (model) flags.model = model;
    if (publish !== undefined) flags.publish = publish;
    try {
      const runId = await manager.start({
        projectId,
        baseRef,
        ...(planText !== undefined ? { planText } : { description: description! }),
        ...(title ? { title } : {}),
        flags,
      });
      return c.json({ runId }, 201);
    } catch (e) {
      if (e instanceof PlanValidationError) {
        return c.json({ error: 'invalid plan', errors: e.errors }, 400);
      }
      if (e instanceof UnknownProjectError) return c.json({ error: 'project not found' }, 404);
      if (e instanceof InvalidStartError) return badRequest(c, e.message);
      return c.json({ error: `could not start the run: ${errorMessage(e)}` }, 500);
    }
  });

  app.post('/api/runs/:id/resume', (c) => {
    const run = runOf(c);
    if (run instanceof Response) return run;
    if (!deps.manager) return c.json({ error: 'this server cannot continue runs' }, 503);
    const result = deps.manager.resume(run.id);
    if (result !== 'started') return resumeRefused(c, result);
    return c.json({ resumed: true }, 202);
  });

  app.post('/api/runs/:id/cancel', async (c) => {
    const id = c.req.param('id');
    if (!isRunId(id)) return badRequest(c, 'invalid run id');
    const result = (await deps.manager?.cancel(id)) ?? false;
    // Told to stop but not settled yet (a push in progress finishes first).
    if (result === 'pending') return c.json({ cancelled: false, state: 'cancelling' }, 202);
    return c.json({ cancelled: result });
  });
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
