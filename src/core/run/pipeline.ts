import { z } from 'zod';
import { scrubbedEnv } from '../process/env.js';
import { mkdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { buildAgents, buildSettings, shellRules } from '../agents/claude-config.js';
import { renderBrief } from '../agents/brief.js';
import type { ImplementerAdapter, ImplementerSession, TurnOutcome } from '../agents/types.js';
import type { loadProjectChecks as LoadProjectChecks } from '../checks/load.js';
import type { ChecksRunResult, RunChecksOptions } from '../checks/run.js';
import type { Git } from '../git/index.js';
import type { GitHubClient } from '../github/types.js';
import type { RunShellOptions, RunShellResult } from '../process/run-shell.js';
import type { ReviewResult, ReviewWithCodexOptions } from '../reviewer/codex-reviewer.js';
import { writeArtifact } from './artifacts.js';
import type { RunConfig } from './config.js';
import type { RunLog } from './events.js';
import { branchName, newRunId } from './id.js';
import { runDir as defaultRunDir, worktreePath as defaultWorktreePath } from './paths.js';
import { assertTransition, isResting, isTerminal } from './machine.js';
import { parsePlan } from './plan.js';
import {
  abortable,
  failedChecks,
  interruptedBody,
  InterruptedError,
  isShutdown,
  mergedPriorFindings,
  renderCheckFailures,
  type ShutdownError,
  throwIfAborted,
} from './pipeline-helpers.js';
import {
  PublishError,
  renderPrBody,
  type CiWaitState,
  type PublishOptions,
  type PublishResult,
  type ResolutionKind,
  type ReviewRoundInput,
  unresolvedBlocking,
  type WaitForCiOptions,
} from './publish.js';
import { FINAL_REVIEW_OPTIONS, FINAL_REVIEW_TITLE } from './final-review.js';
import { attachCommand, buildCtx, loadContext, type Ctx } from './context.js';
import { RunRecorder } from './recorder.js';
import {
  askTriage,
  buildFixSet,
  escalateUpheld,
  haltOnRepeatOfFixed,
  inheritRulings,
  markSpent,
  pendingUpheld,
  reportNotAsked,
  settleFix,
  writeRulings,
  type FixItem,
  type LoopEnv,
} from './triage-loop.js';
import { triageOf } from './triage.js';
import { ReportObjectSchema, readReport, type Report } from './report.js';
import { loadRunState, saveRunState, type RunState } from './run-state.js';
import type { CiCheck } from '../github/types.js';
import type { RunStore, StageKind, StageState } from '../store/runs.js';

export interface RunInput {
  repo: string;
  planFile: string;
  baseRef: string;
  title?: string;
  config: RunConfig;
  /** Aborting cancels the run; aborting with a ShutdownError reason interrupts it. */
  signal?: AbortSignal;
  /** Called once the run exists (its run.json is saved and its row recorded). */
  onStarted?: (runId: string) => void;
}

export interface RunOutcome {
  runId: string;
  runDir: string;
  stage: 'complete' | 'awaiting_review' | 'blocked' | 'failed' | 'cancelled' | 'interrupted';
  note: string | null;
  prNumber: number | null;
}

export interface PipelineDeps {
  git: Pick<
    Git,
    | 'repoRoot'
    | 'originRepo'
    | 'fetchBase'
    | 'createWorktree'
    | 'headSha'
    | 'isClean'
    | 'commitsBetween'
    | 'diffFiles'
    | 'pushBranch'
    | 'remoteBranchSha'
  >;
  runShell: (opts: RunShellOptions) => Promise<RunShellResult>;
  runChecks: (opts: RunChecksOptions) => Promise<ChecksRunResult>;
  loadProjectChecks: typeof LoadProjectChecks;
  adapter: ImplementerAdapter;
  reviewWithCodex: (opts: Omit<ReviewWithCodexOptions, 'codexHome'>) => Promise<ReviewResult>;
  publishRun: (opts: PublishOptions) => Promise<PublishResult>;
  waitForCi: (opts: WaitForCiOptions) => Promise<{ state: CiWaitState; checks: CiCheck[] }>;
  github: () => Promise<GitHubClient>;
  createLog: (runDir: string) => RunLog;
  /** argv that runs `block-party hook` (see claude-config#hookArgv). */
  hookArgv: string[];
  /** Run tables to mirror the run into; without one only the run directory files are written. */
  store?: RunStore;
  now?: () => Date;
  paths?: {
    runDir: (runId: string) => string;
    worktreePath: (owner: string, repo: string, runId: string) => string;
  };
}

/** Stops the pipeline with a terminal stage. */
class Halt extends Error {
  constructor(
    readonly stage: 'blocked' | 'failed',
    note: string,
    /** The halt is because a fix-round cap was reached. */
    readonly capReached = false,
  ) {
    super(note);
    this.name = 'Halt';
  }
}

const PROMPT_IMPLEMENT = (p: string) => `Read the task brief at ${p} and follow it.`;
const PROMPT_FIX = (p: string) => `Read the fix brief at ${p} and follow it.`;

/** Moves the run to `stage`; throws IllegalTransitionError (before writing) for an illegal move. */
/** The parts of a run that moving between stages needs. */
type StageCtx = Pick<Ctx, 'st' | 'runDir' | 'rec' | 'deps'>;

async function setStage(ctx: StageCtx, stage: RunState['stage'], note: string | null = null) {
  assertTransition(ctx.st.stage, stage);
  const next: RunState = {
    ...ctx.st,
    stage,
    stageNote: note,
    updatedAt: (ctx.deps.now ?? (() => new Date()))().toISOString(),
  };
  // Adopt the new stage only once it is saved: if the save fails, the run is still in its
  // previous (active) stage, so the failure handler can still move it to `failed`.
  await saveRunState(ctx.runDir, next);
  ctx.st = next;
  ctx.rec.state(next);
  ctx.rec.event('stage', { stage, note: note ?? undefined });
  // Nothing drives a resting run: it has no owner until a continuation claims it.
  if (isResting(stage)) ctx.rec.release();
  // A run that ended can't act on an unanswered question.
  if (isTerminal(stage)) ctx.rec.closeOpenQuestions();
}

/** What the triage steps need from this file. */
const env: LoopEnv = {
  setStage: (ctx, stage, note) => setStage(ctx, stage, note),
  halt: (note) => new Halt('blocked', note),
};

async function patchState(ctx: Ctx, patch: Partial<RunState>) {
  ctx.st = { ...ctx.st, ...patch };
  await saveRunState(ctx.runDir, ctx.st);
  ctx.rec.state(ctx.st);
}

function describeSession(ctx: Ctx): string {
  return ctx.session ? ` Attach: ${ctx.deps.adapter.describe(ctx.session)}` : '';
}

/** How a stage execution ends when `e` interrupts it. */
function interruptedState(ctx: Ctx, e: unknown): Exclude<StageState, 'running' | 'succeeded'> {
  if (ctx.input.signal?.aborted || e instanceof InterruptedError) return 'cancelled';
  if (e instanceof Halt) return e.stage;
  return 'failed';
}

/**
 * Runs `fn` as one recorded stage execution. `result` maps its value to the end state
 * (default succeeded) and output; a throw ends it blocked, failed or cancelled.
 */
async function inStage<T>(
  ctx: Ctx,
  kind: StageKind,
  round: number,
  input: unknown,
  fn: () => Promise<T>,
  result: (value: T) => { state?: Exclude<StageState, 'running'>; output?: unknown },
): Promise<T> {
  ctx.rec.startStage(kind, round, input);
  let value: T;
  try {
    value = await fn();
  } catch (e) {
    ctx.rec.endStage(interruptedState(ctx, e), { error: (e as Error).message });
    throw e;
  }
  const r = result(value);
  ctx.rec.endStage(r.state ?? 'succeeded', r.output);
  return value;
}

/** Awaits an implementer turn; its permission decisions are resolved once it ends. */
async function turnEnded<T>(ctx: Ctx, turn: Promise<T>): Promise<T> {
  try {
    return await turn;
  } finally {
    ctx.rec.resolvePermissions();
  }
}

/** Inbox item for a run that ended blocked or failed. */
function openEndDecision(ctx: Ctx, e: unknown): void {
  const note = (e as Error).message;
  if (e instanceof Halt && e.stage === 'blocked') {
    if (e.capReached) {
      ctx.rec.openDecision('cap_reached', 'Fix-round cap reached', note, attachCommand(ctx));
    } else {
      ctx.rec.openDecision('blocked', 'Run blocked', note, attachCommand(ctx));
    }
  } else {
    ctx.rec.openDecision('failed', 'Run failed', note, null);
  }
}

/**
 * The review-fix cap publishes rather than blocks (Phase 1 rule), so blocking findings it
 * left unresolved would otherwise live only in the PR body: put them in the inbox too.
 */
const UNRESOLVED_TITLE = 'Unresolved blocking findings';

function openUnresolvedDecision(ctx: Ctx): void {
  const unresolved = unresolvedBlocking(ctx.rounds);
  if (unresolved.length === 0) return;
  try {
    // One open item per run: a continuation that still has them must not add another.
    const open = ctx.deps.store?.listDecisions({ runId: ctx.st.id, status: 'open' }) ?? [];
    if (open.some((d) => d.kind === 'cap_reached' && d.title === UNRESOLVED_TITLE)) return;
  } catch {
    // The store failing here only risks a duplicate item.
  }
  const where = ctx.st.prNumber !== null ? `PR #${ctx.st.prNumber}` : 'The run';
  const list = unresolved.map((f) => `- ${f.severity} ${f.title}`).join('\n');
  ctx.rec.openDecision(
    'cap_reached',
    UNRESOLVED_TITLE,
    `${where} still has blocking findings after the review-fix cap:\n${list}`,
    null,
  );
}

export async function runPipeline(input: RunInput, deps: PipelineDeps): Promise<RunOutcome> {
  const ctx = await preflight(input, deps);
  try {
    await provision(ctx);
    await implement(ctx);
    await verifyLoop(ctx);
    if (!input.config.publish) {
      await restForReview(ctx, 'Publishing disabled (--no-publish); stopped after review');
    } else {
      await publish(ctx);
    }
  } catch (e) {
    await endRun(ctx, e);
  }
  return outcomeOf(ctx);
}

function outcomeOf(ctx: Ctx): RunOutcome {
  return {
    runId: ctx.st.id,
    runDir: ctx.runDir,
    stage: ctx.st.stage as RunOutcome['stage'],
    note: ctx.st.stageNote,
    prNumber: ctx.st.prNumber,
  };
}

/** Moves a run that stopped on `e` to its end stage, with the inbox item that explains it. */
async function endRun(ctx: Ctx, e: unknown): Promise<void> {
  const { input } = ctx;
  await ctx.pending.catch(() => undefined);
  if (isResting(ctx.st.stage)) {
    // A continuation that failed before leaving rest: the run has not moved, so it cannot end
    // (a resting run only leaves by its own moves).
    if (ctx.st.stage === 'awaiting_review') {
      // Offer the review again.
      ctx.rec.reopenFinalReview(ctx.st.title, (e as Error).message);
    } else {
      ctx.rec.event('continuation.failed', { reason: (e as Error).message });
    }
    return;
  }
  if (isShutdown(input.signal)) {
    // The process driving the run is stopping: the run did not choose to end here.
    const reason = (input.signal!.reason as ShutdownError).message;
    const last = ctx.st.stage;
    const lastNote = ctx.st.stageNote;
    await setStage(ctx, 'interrupted', reason);
    ctx.rec.event('run.interrupted', { stage: last, note: reason });
    ctx.rec.openDecision(
      'interrupted',
      'Run interrupted',
      interruptedBody(last, lastNote, reason),
      attachCommand(ctx),
    );
  } else if (input.signal?.aborted || e instanceof InterruptedError) {
    // Cancellation wins over whatever failure the killed work produced.
    await setStage(ctx, 'cancelled', 'cancelled');
  } else if (e instanceof Halt) {
    await setStage(ctx, e.stage, e.message);
    openEndDecision(ctx, e);
  } else {
    // Includes IllegalTransitionError: failed is reachable from every active stage.
    await setStage(ctx, 'failed', (e as Error).message);
    openEndDecision(ctx, e);
  }
}

/** Step 1. Errors before the run directory exists are thrown to the caller. */
async function preflight(input: RunInput, deps: PipelineDeps): Promise<Ctx> {
  const now = deps.now ?? (() => new Date());
  const { git } = deps;
  const planText = await readFile(input.planFile, 'utf8');
  const parsed = parsePlan(planText);
  if (!parsed.ok) throw new Error(`Invalid plan:\n- ${parsed.errors.join('\n- ')}`);
  const plan = parsed.plan;

  const repoPath = await git.repoRoot(input.repo);
  const origin = await git.originRepo(repoPath);
  const loaded = deps.loadProjectChecks(repoPath);
  const configErrors = loaded.errors;
  if (!loaded.config) {
    throw new Error(
      'No checks: section in .block-party.yaml. Run `block-party checks init --write` first.',
    );
  }
  const checks = loaded.config;
  const base = await git.fetchBase(repoPath, input.baseRef);
  // Stopped while preparing: no run is created (the error goes to the caller).
  throwIfAborted(input.signal);

  const runId = newRunId(now());
  const paths = deps.paths ?? {
    runDir: (id: string) => defaultRunDir(id),
    worktreePath: (o: string, r: string, id: string) => defaultWorktreePath(o, r, id),
  };
  const runDir = paths.runDir(runId);
  const wt = paths.worktreePath(origin.owner, origin.repo, runId);
  const log = deps.createLog(runDir);
  const title = input.title ?? plan.title;
  const branch = branchName(title, runId);
  const planPath = (await writeArtifact(runDir, 'plans/v1.md', planText)).path;
  // What a continuation needs to rebuild this run's context later.
  await writeArtifact(runDir, 'inputs/config.json', input.config);
  const ts = now().toISOString();
  const st: RunState = {
    id: runId,
    title,
    repoPath,
    owner: origin.owner,
    repo: origin.repo,
    baseRef: input.baseRef,
    baseSha: base.sha,
    branch,
    worktreePath: wt,
    headSha: null,
    planPath,
    planHash: plan.contentHash,
    planVersion: 1,
    stage: 'setup',
    stageNote: null,
    implementer: null,
    sessionEnded: false,
    rounds: { checkFix: 0, reviewFix: 0, feedback: 0, checkRuns: 0 },
    prNumber: null,
    createdAt: ts,
    updatedAt: ts,
  };
  await saveRunState(runDir, st);
  const rec = new RunRecorder(log, deps.store);
  rec.state(st);

  const ctx = buildCtx({ input, deps, rec, st, runDir, plan, checks });

  for (const e of configErrors) rec.event('checks.warning', { warning: e });
  rec.event('run.started', { runId, runDir, worktree: wt, branch });
  for (const w of [...(loaded.drift?.warnings ?? [])]) rec.event('drift.warning', { warning: w });
  if (loaded.drift) {
    for (const m of loaded.drift.missing) rec.event('drift.missing', { ref: m.ref });
    for (const s of loaded.drift.stale) rec.event('drift.stale', { check: s.check, ref: s.ref });
  }

  input.onStarted?.(runId);
  return ctx;
}

/** JSON Schema of report.json, generated from the zod schema the pipeline validates with. */
export function reportJsonSchema(): object {
  return {
    ...z.toJSONSchema(ReportObjectSchema),
    description:
      'Final report written to report.json. Rule: when status is "blocked", questions must be non-empty; for any other status, questions must be empty.',
  };
}

/** Step 2: worktree, setup command, and the agent/settings files. */
async function provision(ctx: Ctx): Promise<void> {
  const { deps, st, runDir, checks, input } = ctx;
  // Aborted as the run was created: end it before any side effect (no worktree).
  throwIfAborted(input.signal);
  await deps.git.createWorktree({
    repo: st.repoPath,
    path: st.worktreePath,
    branch: st.branch,
    baseSha: st.baseSha,
  });
  if (checks.setup) {
    const logPath = join(runDir, 'logs', 'setup.log');
    const r = await deps.runShell({
      command: checks.setup,
      cwd: st.worktreePath,
      logPath,
      timeoutMs: input.config.policy.checkTimeoutMs,
      signal: input.signal,
      env: scrubbedEnv(),
    });
    if (r.code !== 0 || r.timedOut) throw new Halt('failed', `Setup failed (see ${logPath})`);
  }
  await writeArtifact(runDir, 'report.schema.json', reportJsonSchema());
  const models = input.config.subagents;
  await writeArtifact(
    runDir,
    'agents.json',
    buildAgents(
      (Object.keys(models) as (keyof typeof models)[]).map((name) => ({
        name,
        model: models[name],
        ...(name === 'explorer' ? { readOnly: true } : {}),
      })),
      shellRules(ctx.start.allowedTools),
    ),
  );
  await writeArtifact(
    runDir,
    'settings.json',
    buildSettings({
      hookArgv: deps.hookArgv,
      eventsPath: ctx.start.eventsPath,
      permissionMode: ctx.start.permissionMode,
    }),
  );
}

/** Step 3: write the implement brief and run the first turn. */
async function implement(ctx: Ctx): Promise<void> {
  const { deps, st, input } = ctx;
  await setStage(ctx, 'implementing');
  const brief = await writeArtifact(
    ctx.runDir,
    'briefs/implement-1.md',
    renderBrief({ ...ctx.briefBase, stage: 'implement' }),
  );
  const prevHead = await deps.git.headSha(st.worktreePath);
  const onSession = (session: ImplementerSession) => {
    ctx.session = session;
    ctx.rec.event('implementer.session', {
      mode: session.mode,
      attach: deps.adapter.describe(session),
    });
    ctx.pending = ctx.pending.then(() =>
      patchState(ctx, {
        implementer: {
          mode: session.mode,
          sessionId: session.sessionId,
          paneLabel: session.paneLabel ?? null,
        },
      }),
    );
  };
  await inStage(
    ctx,
    'implement',
    1,
    turnInput(ctx, brief.path),
    async () => {
      const { session, outcome } = await turnEnded(
        ctx,
        abortable(
          deps.adapter.start({ ...ctx.start, prompt: PROMPT_IMPLEMENT(brief.path), onSession }),
          input.signal,
        ),
      );
      if (!ctx.session) onSession(session);
      ctx.session = session;
      await ctx.pending;
      return judgeTurn(ctx, outcome, 'implement', 1, prevHead);
    },
    () => turnOutput(ctx, 'implement', 1),
  );
}

function turnInput(ctx: Ctx, briefPath: string) {
  return { brief: briefPath, model: ctx.start.model };
}

function turnOutput(ctx: Ctx, kind: string, n: number) {
  return { output: { report: join(ctx.runDir, 'reports', `${kind}-${n}.json`) } };
}

interface TurnChecks {
  /** Returns an error message when the report does not account for the findings. */
  validate?: (report: Report) => string | null;
  /** Whether this turn must have produced a new commit (default true). */
  requireCommit?: (report: Report) => boolean;
}

/**
 * Step 4: interpret a finished turn. Returns the accepted `done` report, or halts as blocked.
 * The consumed report file is moved to reports/<kind>-<n>.json so the next turn starts fresh.
 */
async function judgeTurn(
  ctx: Ctx,
  outcome: TurnOutcome,
  kind: string,
  n: number,
  prevHead: string,
  extra: TurnChecks = {},
): Promise<Report> {
  const { deps, st } = ctx;
  const attach = describeSession(ctx);
  if (outcome.kind !== 'report') {
    const why =
      outcome.kind === 'permission'
        ? `waiting for a permission decision: ${outcome.message}`
        : outcome.kind === 'exited'
          ? `exited: ${outcome.reason}`
          : outcome.kind === 'no_report'
            ? `finished without a report${outcome.detail ? ` (${outcome.detail})` : ''}`
            : 'timed out';
    throw new Halt('blocked', `Implementer ${why} during ${kind}-${n}.${attach}`);
  }
  const read = await readReport(ctx.reportPath);
  if ('missing' in read) {
    throw new Halt(
      'blocked',
      `Implementer reported but report.json is missing (${kind}-${n}).${attach}`,
    );
  }
  await mkdir(join(ctx.runDir, 'reports'), { recursive: true });
  await rename(ctx.reportPath, join(ctx.runDir, 'reports', `${kind}-${n}.json`)).catch(
    () => undefined,
  );
  if (!read.ok) {
    throw new Halt('blocked', `Invalid report.json (${kind}-${n}): ${read.error}.${attach}`);
  }
  const report = read.report;
  if (report.status === 'blocked') {
    for (const q of report.questions) ctx.rec.event('question', { question: q });
    throw new Halt(
      'blocked',
      `Implementer is blocked and has questions: ${report.questions.join(' | ')}.${attach}`,
    );
  }
  if (report.status === 'partial') {
    throw new Halt('blocked', `Implementer reported partial work: ${report.summary}.${attach}`);
  }
  const problem = extra.validate?.(report);
  if (problem) throw new Halt('blocked', `${problem}.${attach}`);

  const wt = st.worktreePath;
  if (!(await deps.git.isClean(wt))) {
    throw new Halt('blocked', `Worktree has uncommitted changes after ${kind}-${n}.${attach}`);
  }
  const head = await deps.git.headSha(wt);
  const needCommit = extra.requireCommit ? extra.requireCommit(report) : true;
  if (needCommit) {
    const commits = head === prevHead ? [] : await deps.git.commitsBetween(wt, prevHead, head);
    if (commits.length === 0) {
      throw new Halt('blocked', `No new commits after ${kind}-${n}.${attach}`);
    }
  }
  await patchState(ctx, { headSha: head });
  ctx.lastReport = report;
  ctx.reports.push({ kind, round: n, report });
  return report;
}

async function fixTurn(
  ctx: Ctx,
  kind: 'check-fix' | 'review-fix' | 'feedback',
  n: number,
  findingsPath: string,
  extra: TurnChecks,
): Promise<Report> {
  const { deps, st, input } = ctx;
  const rulingsPath = await writeRulings(ctx);
  const brief = await writeArtifact(
    ctx.runDir,
    `briefs/${kind}-${n}.md`,
    renderBrief({ ...ctx.briefBase, stage: 'fix', round: n, findingsPath, rulingsPath }),
  );
  await setStage(ctx, 'fixing', `${kind} ${n}`);
  const prevHead = await deps.git.headSha(st.worktreePath);
  const report = await inStage(
    ctx,
    kind,
    n,
    turnInput(ctx, brief.path),
    async () => {
      const outcome = await turnEnded(
        ctx,
        abortable(
          deps.adapter.send(
            ctx.session!,
            { ...ctx.start, prompt: PROMPT_FIX(brief.path) },
            PROMPT_FIX(brief.path),
          ),
          input.signal,
        ),
      );
      return judgeTurn(ctx, outcome, kind, n, prevHead, extra);
    },
    () => turnOutput(ctx, kind, n),
  );
  ctx.lastFix = { from: prevHead, to: ctx.st.headSha ?? prevHead };
  return report;
}

/** Step 5: local CI on HEAD; failing checks go back to the implementer up to the cap. */
async function checksGreen(ctx: Ctx): Promise<void> {
  const { deps, input } = ctx;
  const policy = input.config.policy;
  for (;;) {
    const head = await deps.git.headSha(ctx.st.worktreePath);
    await setStage(ctx, 'checking', head.slice(0, 7));
    const checkRun = ctx.st.rounds.checkRuns + 1;
    await patchState(ctx, { rounds: { ...ctx.st.rounds, checkRuns: checkRun } });
    const res = await inStage(
      ctx,
      'checks',
      checkRun,
      { headSha: head },
      async () => {
        const r = await abortable(
          deps.runChecks({
            cwd: ctx.st.worktreePath,
            checks: ctx.checks.required,
            logDir: join(ctx.runDir, 'checks', head.slice(0, 7)),
            headSha: head,
            timeoutMs: policy.checkTimeoutMs,
            signal: input.signal,
          }),
          input.signal,
        );
        ctx.lastChecks = r;
        ctx.rec.event('checks.result', { head: head.slice(0, 7), passed: r.passed });
        return r;
      },
      (r) => {
        const failed = new Set(failedChecks(r.results));
        return {
          state: r.passed ? 'succeeded' : 'failed',
          output: {
            passed: r.passed,
            checks: r.results.map((c) => ({
              name: c.name,
              passed: !failed.has(c),
              logPath: c.logPath,
            })),
          },
        };
      },
    );
    if (res.passed) return;
    const names = failedChecks(res.results)
      .map((r) => r.name)
      .join(', ');
    const usedCheckFix = ctx.st.rounds.checkFix - ctx.fixBase.checkFix;
    if (usedCheckFix >= policy.maxCheckFixRounds) {
      throw new Halt(
        'blocked',
        `Local CI still failing (${names}) after ${usedCheckFix} fix round(s).${describeSession(ctx)}`,
        true,
      );
    }
    const n = ctx.st.rounds.checkFix + 1;
    await patchState(ctx, { rounds: { ...ctx.st.rounds, checkFix: n } });
    const failures = await writeArtifact(
      ctx.runDir,
      `inputs/check-failures-${n}.md`,
      renderCheckFailures(res.results, head),
    );
    await fixTurn(ctx, 'check-fix', n, failures.path, {});
  }
}

/** Steps 6-7: Codex review, triage, and one (configurable) fix round for the fix set. */
async function verifyLoop(ctx: Ctx): Promise<void> {
  const { deps, input } = ctx;
  const policy = input.config.policy;
  // A continuation numbers its reviews after the ones already done.
  for (let round = Math.max(0, ...ctx.rounds.map((r) => r.round)) + 1; ; round++) {
    await checksGreen(ctx);
    const head = await deps.git.headSha(ctx.st.worktreePath);
    await setStage(ctx, 'reviewing', `round ${round}`);
    const outDir = join(ctx.runDir, 'reviews', `round-${round}`);
    // Stored rows are the record of what a round found and how it ended; rounds from before
    // they existed have only the findings files, which ctx.rounds was built from.
    const prior = mergedPriorFindings(ctx.rounds, ctx.rec.listFindings(), ctx.rulings);
    const { rec } = await inStage(
      ctx,
      'review',
      round,
      { reviewedSha: head },
      async () => {
        const rr = await abortable(
          deps.reviewWithCodex({
            worktree: ctx.st.worktreePath,
            baseSha: ctx.st.baseSha,
            headSha: head,
            planPath: ctx.planPath,
            priorFindings: prior,
            outDir,
            round,
            ...(input.config.reviewer.model ? { model: input.config.reviewer.model } : {}),
            signal: input.signal,
          }),
          input.signal,
        );
        if (!rr.ok) throw new Halt('blocked', `Codex review failed: ${rr.error}`);
        const rec: ReviewRoundInput = {
          round,
          reviewedSha: head,
          summary: rr.output.summary,
          findings: rr.output.findings,
          resolutions: {},
        };
        ctx.rounds.push(rec);
        const blocking = rec.findings.filter((f) => triageOf(policy, f.severity) === 'auto_fix');
        ctx.rec.recordFindings(round, rec.findings, (f) => triageOf(policy, f.severity));
        ctx.rec.event('review.result', {
          round,
          findings: rec.findings.length,
          blocking: blocking.length,
        });
        return { rec, blocking };
      },
      (r) => {
        const bySeverity: Record<string, number> = {};
        for (const f of r.rec.findings) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
        return {
          output: {
            findings: r.rec.findings.length,
            blocking: r.blocking.length,
            summary: r.rec.summary,
            bySeverity,
            findingsPath: join(outDir, 'findings.json'),
          },
        };
      },
    );
    haltOnRepeatOfFixed(env, ctx, rec);
    const inherited = await inheritRulings(ctx, rec);
    if (ctx.st.rounds.reviewFix - ctx.fixBase.reviewFix >= policy.maxReviewFixRounds) {
      // Past the cap nothing new is fixed or asked. An upheld finding still gets its one
      // extra fix turn, so "fix it anyway" is never a no-op.
      reportNotAsked(ctx, rec, inherited);
      const upheld = pendingUpheld(ctx);
      if (upheld.length === 0) {
        escalateUpheld(ctx);
        return;
      }
      await reviewFix(ctx, rec, upheld);
      continue;
    }
    const answeredFix = await askTriage(env, ctx, rec, inherited);
    const fixSet = buildFixSet(ctx, rec, inherited, answeredFix, false);
    if (fixSet.length === 0) {
      escalateUpheld(ctx);
      return;
    }
    await reviewFix(ctx, rec, fixSet);
  }
}

/** Runs one fix turn for `items`, then rules on what it disputed and how broad it was. */
async function reviewFix(ctx: Ctx, rec: ReviewRoundInput, items: FixItem[]): Promise<void> {
  const n = ctx.st.rounds.reviewFix + 1;
  await patchState(ctx, { rounds: { ...ctx.st.rounds, reviewFix: n } });
  await markSpent(ctx, items);
  // Ids restart every round, so a finding from an earlier round goes by its key.
  const fileId = (i: FixItem) => (i.round === rec.round ? i.id : i.key);
  const findings = await writeArtifact(
    ctx.runDir,
    `inputs/findings-round-${rec.round}.json`,
    items.map((i) => ({ ...i.finding, id: fileId(i) })),
  );
  const resolved = new Map<string, { resolution: ResolutionKind; note: string }>();
  const report = await fixTurn(ctx, 'review-fix', n, findings.path, {
    validate: (r) => {
      for (const x of r.findingResolutions) resolved.set(x.findingId, x);
      const missing = items.filter((i) => !resolved.has(fileId(i))).map(fileId);
      return missing.length > 0
        ? `Fix report is missing resolutions for: ${missing.join(', ')}`
        : null;
    },
    requireCommit: () => items.some((i) => resolved.get(fileId(i))?.resolution === 'fixed'),
  });
  const said = new Map(report.findingResolutions.map((x) => [x.findingId, x]));
  await settleFix(env, ctx, items, said, fileId);
}

/** Stops the implementer process; the conversation can still be resumed later. */
async function stopSession(ctx: Ctx): Promise<void> {
  if (!ctx.session) return;
  try {
    await ctx.deps.adapter.stop(ctx.session);
  } catch (e) {
    ctx.rec.event('implementer.stop_failed', { error: (e as Error).message });
  }
}

/**
 * The end of every successful pass: the run rests in `awaiting_review` with a `final_review`
 * inbox item. The implementer is stopped first, while the run is still active, so a failure
 * there still ends the run normally.
 */
async function restForReview(ctx: Ctx, note: string | null): Promise<void> {
  openUnresolvedDecision(ctx);
  await stopSession(ctx);
  await patchState(ctx, { sessionEnded: true });
  await setStage(ctx, 'awaiting_review', note);
  const pr =
    ctx.st.prNumber !== null
      ? `https://github.com/${ctx.st.owner}/${ctx.st.repo}/pull/${ctx.st.prNumber}`
      : null;
  ctx.rec.openDecision(
    'final_review',
    FINAL_REVIEW_TITLE,
    pr ? `${ctx.st.title} is ready for review: ${pr}` : `${ctx.st.title} is ready for review.`,
    null,
    FINAL_REVIEW_OPTIONS,
  );
}

/** Step 8: push, draft PR, then wait for GitHub CI. */
async function publish(ctx: Ctx): Promise<void> {
  const { deps, st, input } = ctx;
  const wt = st.worktreePath;
  const head = await deps.git.headSha(wt);
  const last = ctx.rounds[ctx.rounds.length - 1];
  if (!(await deps.git.isClean(wt))) {
    throw new Halt('blocked', `Worktree is dirty before publishing.${describeSession(ctx)}`);
  }
  if (!ctx.lastChecks?.passed || ctx.lastChecks.headSha !== head || last?.reviewedSha !== head) {
    throw new Halt(
      'blocked',
      `HEAD ${head.slice(0, 7)} is not the commit that passed local CI and was reviewed ` +
        `(CI: ${ctx.lastChecks?.headSha.slice(0, 7) ?? 'none'}, review: ${last?.reviewedSha.slice(0, 7) ?? 'none'}).${describeSession(ctx)}`,
    );
  }
  await setStage(ctx, 'publishing');
  const body = renderPrBody({
    plan: ctx.plan,
    report: ctx.lastReport!,
    reports: ctx.reports,
    checks: ctx.lastChecks,
    reviewRounds: ctx.rounds,
    runId: st.id,
  });
  const repo = { owner: st.owner, repo: st.repo };
  const github = await deps.github();
  const pr = await inStage(
    ctx,
    'publish',
    ctx.st.rounds.feedback + 1,
    { headSha: head },
    async (): Promise<PublishResult> => {
      let pr: PublishResult;
      try {
        pr = await deps.publishRun({
          git: deps.git,
          github,
          repo,
          worktree: wt,
          branch: st.branch,
          base: st.baseRef,
          title: st.title,
          body,
          prNumber: st.prNumber,
          signal: input.signal,
        });
      } catch (e) {
        if (e instanceof PublishError) {
          // Record external effects that already happened (they survive an interrupt).
          if (e.done.prNumber !== undefined) await patchState(ctx, { prNumber: e.done.prNumber });
          ctx.rec.event('publish.stopped', {
            code: e.code,
            pushed: e.done.pushed,
            prNumber: e.done.prNumber,
          });
          throw new Halt('blocked', `Publish failed (${e.code}): ${e.message}`);
        }
        throw e;
      }
      await patchState(ctx, { prNumber: pr.prNumber });
      ctx.rec.event('pr', { number: pr.prNumber, url: pr.url });
      return pr;
    },
    (p) => ({ output: { prNumber: p.prNumber, url: p.url } }),
  );
  if (!input.config.waitForCi) return restForReview(ctx, `PR #${pr.prNumber} ${pr.url}`);

  await setStage(ctx, 'waiting_ci', `PR #${pr.prNumber}`);
  const ci = await inStage(
    ctx,
    'wait-ci',
    ctx.st.rounds.feedback + 1,
    { prNumber: pr.prNumber, headSha: head },
    () =>
      abortable(deps.waitForCi({ github, repo, sha: head, signal: input.signal }), input.signal),
    (r) => ({
      state: r.state === 'failure' ? 'failed' : r.state === 'timeout' ? 'blocked' : 'succeeded',
      output: { state: r.state },
    }),
  );
  if (ci.state === 'failure') {
    throw new Halt(
      'blocked',
      `GitHub CI failed after local CI passed: parity gap (PR #${pr.prNumber}).${describeSession(ctx)}`,
    );
  }
  if (ci.state === 'timeout') {
    throw new Halt(
      'blocked',
      `Timed out waiting for GitHub CI on PR #${pr.prNumber}.${describeSession(ctx)}`,
    );
  }
  return restForReview(ctx, `PR #${pr.prNumber} ${pr.url} (CI: ${ci.state})`);
}

export type ContinueEntry = { kind: 'feedback'; text: string } | { kind: 'approve' };

/** Header of a feedback file: what the implementer is asked to do with the text below it. */
const FEEDBACK_HEADER = `# Feedback from your human reviewer

The pull request is ready, and your human sent it back with the feedback below. Address every
item: change the code (and tests) where the feedback is right, and explain where you
disagree.

In report.json set \`feedbackOutcome\` to \`"changed"\` when you committed changes, or to
\`"no_changes"\` when you answered every item without changing anything (no commit is needed
then; say why in \`summary\`). Findings do not apply here: leave \`findingResolutions\` empty.

---

`;

/**
 * Continues a run that is resting in `awaiting_review`: approval completes it; feedback goes
 * to the same implementer session, then local CI, review, a push to the same PR and CI again,
 * and the run rests for review once more. A failure after the run leaves rest ends it as in
 * `runPipeline`; a failure before that reopens the final review, so the answer can be retried.
 */
export async function continueRun(
  runId: string,
  entry: ContinueEntry,
  deps: PipelineDeps,
  signal?: AbortSignal,
): Promise<RunOutcome> {
  const runDir = (deps.paths?.runDir ?? ((id: string) => defaultRunDir(id)))(runId);
  let ctx: Ctx | undefined;
  try {
    if (entry.kind === 'approve') {
      // Approving needs only the run's state: no plan, config or checks.
      const st = await loadRunState(runDir);
      if (st.stage !== 'awaiting_review') {
        throw new Error(`Run ${runId} is not waiting for review (stage: ${st.stage})`);
      }
      const rec = new RunRecorder(deps.createLog(runDir), deps.store);
      rec.resume(st);
      const light = { st, runDir, rec, deps };
      // A failure here leaves the run resting: the catch below reopens the review.
      await setStage(light, 'complete', 'Approved');
      return outcomeFromState(light.st, runDir);
    }
    ctx = await loadContext(runId, deps, signal);
    if (ctx.st.stage !== 'awaiting_review') {
      throw new Error(`Run ${runId} is not waiting for review (stage: ${ctx.st.stage})`);
    }
    ctx.rec.resume(ctx.st);
    const n = ctx.st.rounds.feedback + 1;
    await setStage(ctx, 'fixing', `feedback ${n}`);
    await patchState(ctx, { rounds: { ...ctx.st.rounds, feedback: n }, sessionEnded: false });
    const file = await writeArtifact(
      ctx.runDir,
      `inputs/feedback-${n}.md`,
      FEEDBACK_HEADER + entry.text,
    );
    await fixTurn(ctx, 'feedback', n, file.path, {
      // Answering without changing anything is allowed when the report says so.
      requireCommit: (r) => r.feedbackOutcome !== 'no_changes',
    });
    await verifyLoop(ctx);
    if (!ctx.input.config.publish) {
      await restForReview(ctx, 'Publishing disabled; stopped after review');
    } else {
      await publish(ctx);
    }
  } catch (e) {
    if (ctx) {
      await endRun(ctx, e);
      return outcomeOf(ctx);
    }
    // No context yet (nothing was loaded or moved): if the run is still resting, offer the
    // review again, then tell the caller.
    await reopenIfResting(runId, runDir, deps, e);
    throw e;
  }
  return outcomeOf(ctx);
}

function outcomeFromState(st: RunState, runDir: string): RunOutcome {
  return {
    runId: st.id,
    runDir,
    stage: st.stage as RunOutcome['stage'],
    note: st.stageNote,
    prNumber: st.prNumber,
  };
}

/** A continuation failed before it had a context: reopen the final review if the run rests. */
async function reopenIfResting(
  runId: string,
  runDir: string,
  deps: PipelineDeps,
  e: unknown,
): Promise<void> {
  try {
    const st = await loadRunState(runDir);
    if (st.stage !== 'awaiting_review') return;
    const rec = new RunRecorder(deps.createLog(runDir), deps.store);
    rec.attach(runId);
    rec.reopenFinalReview(st.title, (e as Error).message);
  } catch {
    // run.json is unreadable too: nothing here can say what the run needs.
  }
}
