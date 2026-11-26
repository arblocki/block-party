import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { implementerPermissions, shellRules } from '../agents/claude-config.js';
import type { renderBrief } from '../agents/brief.js';
import type { ImplementerSession, ImplementerStartInput } from '../agents/types.js';
import type { ChecksConfig } from '../checks/config.js';
import type { ChecksRunResult } from '../checks/run.js';
import { ReviewerOutputSchema } from '../reviewer/findings.js';
import { RunConfigSchema, type RunConfig } from './config.js';
import { runDir as defaultRunDir } from './paths.js';
import { isResting } from './machine.js';
import type { PipelineDeps, RunInput } from './pipeline.js';
import { parsePlan, type Plan } from './plan.js';
import type { ResolutionKind, ReviewRoundInput, TurnReport } from './publish.js';
import { RunRecorder } from './recorder.js';
import { ReportSchema, type Report } from './report.js';
import { loadRunState, type RunState } from './run-state.js';

/** Everything one pass of the pipeline works with; rebuilt from the run directory on resume. */
export interface Ctx {
  input: RunInput;
  deps: PipelineDeps;
  /** Every event and state change goes through here (files, plus the store when given). */
  rec: RunRecorder;
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
  /** Local CI runs so far (the `checks` stage round). */
  checkRuns: number;
  /** Fix rounds already used when this pass began: the caps count from here. */
  fixBase: { checkFix: number; reviewFix: number };
  rulingsWritten: boolean;
  /** In-flight run.json save started from a synchronous callback. */
  pending: Promise<void>;
}

/** Brief line telling the implementer which shell commands need no approval. */
function toolsLine(allowedTools: string[], runDir: string): string {
  return (
    `- ${shellRules(allowedTools)} ` +
    `The run directory ${runDir} is readable and writable for you. ` +
    'Subagents you start get the same rules.'
  );
}

/** The command that attaches to the implementer's session, if there is one. */
export function attachCommand(ctx: Ctx): string | null {
  return ctx.session ? ctx.deps.adapter.describe(ctx.session) : null;
}

export interface BuildCtxInput {
  input: RunInput;
  deps: PipelineDeps;
  rec: RunRecorder;
  st: RunState;
  runDir: string;
  plan: Plan;
  checks: ChecksConfig;
}

/** Assembles the context for a run whose state, plan and checks are already known. */
export function buildCtx(b: BuildCtxInput): Ctx {
  const { input, deps, rec, st, runDir, plan, checks } = b;
  const { config } = input;
  const perms = implementerPermissions(
    checks.required.map((c) => c.run),
    checks.fix ?? [],
  );
  const ctx: Ctx = {
    input,
    deps,
    rec,
    st,
    runDir,
    plan,
    planPath: st.planPath,
    checks,
    reportPath: join(runDir, 'report.json'),
    start: {
      runId: st.id,
      cwd: st.worktreePath,
      runDir,
      model: config.implementer.model,
      agentsPath: join(runDir, 'agents.json'),
      settingsPath: join(runDir, 'settings.json'),
      eventsPath: join(runDir, 'events.jsonl'),
      reportPath: join(runDir, 'report.json'),
      permissionMode: 'acceptEdits',
      allowedTools: perms.allowedTools,
      disallowedTools: perms.disallowedTools,
      timeoutMs: config.policy.stageTimeoutMs,
      signal: input.signal,
      onPermission: (message) => {
        const attach = attachCommand(ctx);
        ctx.rec.event('implementer.waiting_for_human', {
          notice: `⏸ Implementer needs your approval — attach: ${attach ?? '(session starting)'}`,
          message,
        });
        ctx.rec.permissionWait(message, attach);
      },
      onEvent: (e) => ctx.rec.event(e.type, e.data),
    },
    briefBase: {
      runTitle: st.title,
      worktreePath: st.worktreePath,
      branch: st.branch,
      baseRef: st.baseRef,
      baseSha: st.baseSha,
      runDir,
      planPath: st.planPath,
      planVersion: st.planVersion,
      extraBoundaries: `${toolsLine(perms.allowedTools, runDir)}\n- The report schema is at \`${join(runDir, 'report.schema.json')}\`; read it before writing report.json.`,
      subagentList: Object.keys(config.subagents).join(', '),
      checkCommands: checks.required.map((c) => `- \`${c.run}\``).join('\n'),
    },
    rounds: [],
    reports: [],
    checkRuns: 0,
    fixBase: { checkFix: st.rounds.checkFix, reviewFix: st.rounds.reviewFix },
    rulingsWritten: false,
    pending: Promise.resolve(),
  };
  return ctx;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

async function listDir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

/**
 * Review rounds from `reviews/round-<n>/findings.json`, with what the implementer said about
 * each finding from `reports/review-fix-<n>.json`. Finding ids carry their round, so a
 * resolution belongs to the one finding it names.
 */
async function loadRounds(runDir: string): Promise<ReviewRoundInput[]> {
  const resolutions: ReviewRoundInput['resolutions'] = {};
  for (const name of await listDir(join(runDir, 'reports'))) {
    if (!/^review-fix-\d+\.json$/.test(name)) continue;
    const parsed = ReportSchema.safeParse(await readJson(join(runDir, 'reports', name)));
    if (!parsed.success) continue;
    for (const r of parsed.data.findingResolutions) {
      resolutions[r.findingId] = { resolution: r.resolution as ResolutionKind, note: r.note };
    }
  }
  const rounds: ReviewRoundInput[] = [];
  for (const name of await listDir(join(runDir, 'reviews'))) {
    const m = /^round-(\d+)$/.exec(name);
    if (!m) continue;
    const out = ReviewerOutputSchema.safeParse(
      await readJson(join(runDir, 'reviews', name, 'findings.json')),
    );
    if (!out.success) continue;
    const mine: ReviewRoundInput['resolutions'] = {};
    for (const f of out.data.findings) {
      if (resolutions[f.id]) mine[f.id] = resolutions[f.id]!;
    }
    rounds.push({
      round: Number(m[1]),
      reviewedSha: out.data.reviewedSha,
      summary: out.data.summary,
      findings: out.data.findings,
      resolutions: mine,
    });
  }
  return rounds.sort((a, b) => a.round - b.round);
}

/** Accepted implementer reports in turn order: the first turn, then the rest by write time. */
async function loadReports(runDir: string): Promise<TurnReport[]> {
  const found: { turn: TurnReport; at: number }[] = [];
  for (const name of await listDir(join(runDir, 'reports'))) {
    const m = /^(.+)-(\d+)\.json$/.exec(name);
    if (!m) continue;
    const path = join(runDir, 'reports', name);
    const parsed = ReportSchema.safeParse(await readJson(path));
    if (!parsed.success) continue;
    const at = await stat(path).then(
      (s) => s.mtimeMs,
      () => 0,
    );
    found.push({ turn: { kind: m[1]!, round: Number(m[2]), report: parsed.data }, at });
  }
  const rank = (t: TurnReport) => (t.kind === 'implement' ? 0 : 1);
  found.sort((a, b) => rank(a.turn) - rank(b.turn) || a.at - b.at);
  return found.map((f) => f.turn);
}

/**
 * Rebuilds the context of a resting run from its run directory: run.json, the resolved
 * config, the plan, the project's checks, the review rounds and the latest report.
 * Refuses a run that is not resting.
 */
export async function loadContext(
  runId: string,
  deps: PipelineDeps,
  signal?: AbortSignal,
): Promise<Ctx> {
  const runDir = (deps.paths?.runDir ?? ((id: string) => defaultRunDir(id)))(runId);
  const st = await loadRunState(runDir);
  if (!isResting(st.stage)) {
    throw new Error(`Run ${runId} is not resting (stage: ${st.stage})`);
  }
  const rawConfig = await readJson(join(runDir, 'inputs', 'config.json'));
  const parsedConfig = RunConfigSchema.safeParse(rawConfig);
  if (!parsedConfig.success) {
    throw new Error(`Run ${runId} has no saved config (inputs/config.json is missing or invalid)`);
  }
  const config: RunConfig = parsedConfig.data;
  const planText = await readFile(st.planPath, 'utf8');
  const plan = parsePlan(planText);
  if (!plan.ok) throw new Error(`Invalid plan:\n- ${plan.errors.join('\n- ')}`);
  const loaded = deps.loadProjectChecks(st.repoPath);
  if (!loaded.config) {
    throw new Error(
      'No checks: section in .block-party.yaml. Run `block-party checks init --write` first.',
    );
  }
  const rec = new RunRecorder(deps.createLog(runDir), deps.store);
  const input: RunInput = {
    repo: st.repoPath,
    planFile: st.planPath,
    baseRef: st.baseRef,
    title: st.title,
    config,
    signal,
  };
  const ctx = buildCtx({ input, deps, rec, st, runDir, plan: plan.plan, checks: loaded.config });
  ctx.rounds = await loadRounds(runDir);
  ctx.reports = await loadReports(runDir);
  ctx.lastReport = ctx.reports.at(-1)?.report;
  ctx.rulingsWritten = (await listDir(join(runDir, 'inputs'))).includes('rulings.json');
  ctx.checkRuns = (await listDir(join(runDir, 'checks'))).length;
  if (st.implementer) {
    ctx.session = {
      mode: st.implementer.mode,
      sessionId: st.implementer.sessionId,
      cwd: st.worktreePath,
      ...(st.implementer.paneLabel ? { paneLabel: st.implementer.paneLabel } : {}),
    };
  }
  return ctx;
}
