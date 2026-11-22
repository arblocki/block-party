import { z } from 'zod';
import { scrubbedEnv } from '../process/env.js';
import { mkdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { buildAgents, buildSettings, implementerPermissions } from '../agents/claude-config.js';
import { renderBrief } from '../agents/brief.js';
import type {
  ImplementerAdapter,
  ImplementerSession,
  ImplementerStartInput,
  TurnOutcome,
} from '../agents/types.js';
import type { ChecksConfig } from '../checks/config.js';
import type { loadProjectChecks as LoadProjectChecks } from '../checks/load.js';
import type { ChecksRunResult, RunChecksOptions } from '../checks/run.js';
import type { Git } from '../git/index.js';
import type { GitHubClient } from '../github/types.js';
import type { RunShellOptions, RunShellResult } from '../process/run-shell.js';
import type { Finding } from '../reviewer/findings.js';
import type { ReviewResult, ReviewWithCodexOptions } from '../reviewer/codex-reviewer.js';
import { writeArtifact } from './artifacts.js';
import type { RunConfig } from './config.js';
import type { RunLog } from './events.js';
import { branchName, newRunId } from './id.js';
import { runDir as defaultRunDir, worktreePath as defaultWorktreePath } from './paths.js';
import { assertTransition } from './machine.js';
import { parsePlan, type Plan } from './plan.js';
import {
  abortable,
  failedChecks,
  InterruptedError,
  priorFindings,
  renderCheckFailures,
} from './pipeline-helpers.js';
import {
  PublishError,
  renderPrBody,
  type CiWaitState,
  type PublishOptions,
  type PublishResult,
  type ResolutionKind,
  type ReviewRoundInput,
  type TurnReport,
  type WaitForCiOptions,
} from './publish.js';
import { ReportObjectSchema, readReport, type Report } from './report.js';
import { saveRunState, type RunState } from './run-state.js';
import type { CiCheck } from '../github/types.js';

export interface RunInput {
  repo: string;
  planFile: string;
  baseRef: string;
  title?: string;
  config: RunConfig;
  signal?: AbortSignal;
}

export interface RunOutcome {
  runId: string;
  runDir: string;
  stage: 'complete' | 'blocked' | 'failed' | 'cancelled';
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
  ) {
    super(note);
    this.name = 'Halt';
  }
}

interface Ctx {
  input: RunInput;
  deps: PipelineDeps;
  log: RunLog;
  st: RunState;
  runDir: string;
  plan: Plan;
  planPath: string;
  checks: ChecksConfig;
  reportPath: string;
  start: Omit<ImplementerStartInput, 'prompt'>;
  briefBase: Omit<
    Parameters<typeof renderBrief>[0],
    'stage' | 'round' | 'findingsPath' | 'rulingsPath'
  >;
  session?: ImplementerSession;
  rounds: ReviewRoundInput[];
  lastReport?: Report;
  /** Every accepted implementer report, in turn order. */
  reports: TurnReport[];
  lastChecks?: ChecksRunResult;
  rulingsWritten: boolean;
  /** In-flight run.json save started from a synchronous callback. */
  pending: Promise<void>;
}

/** Brief line telling the implementer which shell commands need no approval. */
function toolsLine(allowedTools: string[], runDir: string): string {
  const prefixes = allowedTools
    .filter((t) => t.startsWith('Bash(') && t.endsWith(')'))
    .map((t) => `\`${t.slice(5, -1).replace(/:\*$/, '')}\``);
  return (
    '- Edit files with the Edit/Write tools, not shell scripts (python/sed/heredocs). ' +
    `Shell commands you may run without approval: ${prefixes.join(', ')}. ` +
    'Anything else stops the run until a human approves it. ' +
    `The run directory ${runDir} is readable and writable for you.`
  );
}

const PROMPT_IMPLEMENT = (p: string) => `Read the task brief at ${p} and follow it.`;
const PROMPT_FIX = (p: string) => `Read the fix brief at ${p} and follow it.`;

/** Moves the run to `stage`; throws IllegalTransitionError (before writing) for an illegal move. */
async function setStage(ctx: Ctx, stage: RunState['stage'], note: string | null = null) {
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
  ctx.log.log('stage', { stage, note: note ?? undefined });
}

async function patchState(ctx: Ctx, patch: Partial<RunState>) {
  ctx.st = { ...ctx.st, ...patch };
  await saveRunState(ctx.runDir, ctx.st);
}

function describeSession(ctx: Ctx): string {
  return ctx.session ? ` Attach: ${ctx.deps.adapter.describe(ctx.session)}` : '';
}

export async function runPipeline(input: RunInput, deps: PipelineDeps): Promise<RunOutcome> {
  const ctx = await preflight(input, deps);
  try {
    await provision(ctx);
    await implement(ctx);
    await verifyLoop(ctx);
    if (!input.config.publish) {
      await finish(ctx, 'Publishing disabled (--no-publish); stopped after review');
    } else {
      await publish(ctx);
    }
  } catch (e) {
    await ctx.pending.catch(() => undefined);
    if (input.signal?.aborted || e instanceof InterruptedError) {
      // Cancellation wins over whatever failure the killed work produced.
      await setStage(ctx, 'cancelled', 'cancelled');
    } else if (e instanceof Halt) {
      await setStage(ctx, e.stage, e.message);
    } else {
      // Includes IllegalTransitionError: failed is reachable from every active stage.
      await setStage(ctx, 'failed', (e as Error).message);
    }
  }
  return {
    runId: ctx.st.id,
    runDir: ctx.runDir,
    stage: ctx.st.stage as RunOutcome['stage'],
    note: ctx.st.stageNote,
    prNumber: ctx.st.prNumber,
  };
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
  const ts = now().toISOString();
  const { config } = input;
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
    stage: 'setup',
    stageNote: null,
    implementer: null,
    rounds: { checkFix: 0, reviewFix: 0 },
    prNumber: null,
    createdAt: ts,
    updatedAt: ts,
  };
  await saveRunState(runDir, st);

  const perms = implementerPermissions(checks.required.map((c) => c.run));
  const eventsPath = join(runDir, 'events.jsonl');
  const subagentModels = config.subagents;
  const ctx: Ctx = {
    input,
    deps,
    log,
    st,
    runDir,
    plan,
    planPath,
    checks,
    reportPath: join(runDir, 'report.json'),
    start: {
      runId,
      cwd: wt,
      runDir,
      model: config.implementer.model,
      agentsPath: join(runDir, 'agents.json'),
      settingsPath: join(runDir, 'settings.json'),
      eventsPath,
      reportPath: join(runDir, 'report.json'),
      permissionMode: 'acceptEdits',
      allowedTools: perms.allowedTools,
      disallowedTools: perms.disallowedTools,
      timeoutMs: config.policy.stageTimeoutMs,
      signal: input.signal,
      onPermission: (message) => {
        ctx.log.log('implementer.waiting_for_human', {
          notice: `⏸ Implementer needs your approval — attach: ${ctx.session ? deps.adapter.describe(ctx.session) : '(session starting)'}`,
          message,
        });
      },
    },
    briefBase: {
      runTitle: title,
      worktreePath: wt,
      branch,
      baseRef: input.baseRef,
      baseSha: base.sha,
      runDir,
      planPath,
      planVersion: 1,
      extraBoundaries: `${toolsLine(perms.allowedTools, runDir)}\n- The report schema is at \`${join(runDir, 'report.schema.json')}\`; read it before writing report.json.`,
      subagentList: Object.keys(subagentModels).join(', '),
      checkCommands: checks.required.map((c) => `- \`${c.run}\``).join('\n'),
    },
    rounds: [],
    reports: [],
    rulingsWritten: false,
    pending: Promise.resolve(),
  };

  for (const e of configErrors) log.log('checks.warning', { warning: e });
  log.log('run.started', { runId, runDir, worktree: wt, branch });
  for (const w of [...(loaded.drift?.warnings ?? [])]) log.log('drift.warning', { warning: w });
  if (loaded.drift) {
    for (const m of loaded.drift.missing) log.log('drift.missing', { ref: m.ref });
    for (const s of loaded.drift.stale) log.log('drift.stale', { check: s.check, ref: s.ref });
  }

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
    ctx.log.log('implementer.session', {
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
  const { session, outcome } = await abortable(
    deps.adapter.start({ ...ctx.start, prompt: PROMPT_IMPLEMENT(brief.path), onSession }),
    input.signal,
  );
  if (!ctx.session) onSession(session);
  ctx.session = session;
  await ctx.pending;
  await judgeTurn(ctx, outcome, 'implement', 1, prevHead);
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
    for (const q of report.questions) ctx.log.log('question', { question: q });
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

async function writeRulingsOnce(ctx: Ctx): Promise<string> {
  const art = await writeArtifact(ctx.runDir, 'inputs/rulings.json', []);
  if (!ctx.rulingsWritten) ctx.rulingsWritten = true;
  return art.path;
}

async function fixTurn(
  ctx: Ctx,
  kind: 'check-fix' | 'review-fix',
  n: number,
  findingsPath: string,
  extra: TurnChecks,
): Promise<Report> {
  const { deps, st, input } = ctx;
  const rulingsPath = ctx.rulingsWritten
    ? join(ctx.runDir, 'inputs', 'rulings.json')
    : await writeRulingsOnce(ctx);
  const brief = await writeArtifact(
    ctx.runDir,
    `briefs/${kind}-${n}.md`,
    renderBrief({ ...ctx.briefBase, stage: 'fix', round: n, findingsPath, rulingsPath }),
  );
  await setStage(ctx, 'fixing', `${kind} ${n}`);
  const prevHead = await deps.git.headSha(st.worktreePath);
  const outcome = await abortable(
    deps.adapter.send(
      ctx.session!,
      { ...ctx.start, prompt: PROMPT_FIX(brief.path) },
      PROMPT_FIX(brief.path),
    ),
    input.signal,
  );
  return judgeTurn(ctx, outcome, kind, n, prevHead, extra);
}

/** Step 5: local CI on HEAD; failing checks go back to the implementer up to the cap. */
async function checksGreen(ctx: Ctx): Promise<void> {
  const { deps, input } = ctx;
  const policy = input.config.policy;
  for (;;) {
    const head = await deps.git.headSha(ctx.st.worktreePath);
    await setStage(ctx, 'checking', head.slice(0, 7));
    const res = await abortable(
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
    ctx.lastChecks = res;
    ctx.log.log('checks.result', { head: head.slice(0, 7), passed: res.passed });
    if (res.passed) return;
    const names = failedChecks(res.results)
      .map((r) => r.name)
      .join(', ');
    if (ctx.st.rounds.checkFix >= policy.maxCheckFixRounds) {
      throw new Halt(
        'blocked',
        `Local CI still failing (${names}) after ${ctx.st.rounds.checkFix} fix round(s).${describeSession(ctx)}`,
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

/** Steps 6-7: Codex review, and one (configurable) fix round for blocking findings. */
async function verifyLoop(ctx: Ctx): Promise<void> {
  const { deps, input } = ctx;
  const policy = input.config.policy;
  for (let round = 1; ; round++) {
    await checksGreen(ctx);
    const head = await deps.git.headSha(ctx.st.worktreePath);
    await setStage(ctx, 'reviewing', `round ${round}`);
    const outDir = join(ctx.runDir, 'reviews', `round-${round}`);
    const rr = await abortable(
      deps.reviewWithCodex({
        worktree: ctx.st.worktreePath,
        baseSha: ctx.st.baseSha,
        headSha: head,
        planPath: ctx.planPath,
        priorFindings: priorFindings(ctx.rounds),
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
    const blocking = rec.findings.filter((f) => policy.autoFix.includes(f.severity));
    ctx.log.log('review.result', {
      round,
      findings: rec.findings.length,
      blocking: blocking.length,
    });
    if (blocking.length === 0 || ctx.st.rounds.reviewFix >= policy.maxReviewFixRounds) return;
    await reviewFix(ctx, rec, blocking);
  }
}

async function reviewFix(ctx: Ctx, rec: ReviewRoundInput, blocking: Finding[]): Promise<void> {
  const n = ctx.st.rounds.reviewFix + 1;
  await patchState(ctx, { rounds: { ...ctx.st.rounds, reviewFix: n } });
  const findings = await writeArtifact(
    ctx.runDir,
    `inputs/findings-round-${rec.round}.json`,
    blocking,
  );
  const resolved = new Map<string, { resolution: ResolutionKind; note: string }>();
  const report = await fixTurn(ctx, 'review-fix', n, findings.path, {
    validate: (r) => {
      for (const x of r.findingResolutions) resolved.set(x.findingId, x);
      const missing = blocking.filter((f) => !resolved.has(f.id)).map((f) => f.id);
      return missing.length > 0
        ? `Fix report is missing resolutions for: ${missing.join(', ')}`
        : null;
    },
    requireCommit: () => blocking.some((f) => resolved.get(f.id)?.resolution === 'fixed'),
  });
  for (const x of report.findingResolutions) {
    if (rec.findings.some((f) => f.id === x.findingId)) {
      rec.resolutions[x.findingId] = { resolution: x.resolution, note: x.note };
    }
  }
}

async function finish(ctx: Ctx, note: string | null): Promise<void> {
  await setStage(ctx, 'complete', note);
  if (ctx.session) {
    try {
      await ctx.deps.adapter.stop(ctx.session);
    } catch (e) {
      ctx.log.log('implementer.stop_failed', { error: (e as Error).message });
    }
  }
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
      signal: input.signal,
    });
  } catch (e) {
    if (e instanceof PublishError) {
      // Record external effects that already happened (they survive an interrupt).
      if (e.done.prNumber !== undefined) await patchState(ctx, { prNumber: e.done.prNumber });
      ctx.log.log('publish.stopped', {
        code: e.code,
        pushed: e.done.pushed,
        prNumber: e.done.prNumber,
      });
      throw new Halt('blocked', `Publish failed (${e.code}): ${e.message}`);
    }
    throw e;
  }
  await patchState(ctx, { prNumber: pr.prNumber });
  ctx.log.log('pr', { number: pr.prNumber, url: pr.url });
  if (!input.config.waitForCi) return finish(ctx, `PR #${pr.prNumber} ${pr.url}`);

  await setStage(ctx, 'waiting_ci', `PR #${pr.prNumber}`);
  const ci = await abortable(
    deps.waitForCi({ github, repo, sha: head, signal: input.signal }),
    input.signal,
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
  return finish(ctx, `PR #${pr.prNumber} ${pr.url} (CI: ${ci.state})`);
}
