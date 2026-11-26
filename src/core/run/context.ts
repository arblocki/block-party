import { readdir, readFile } from 'node:fs/promises';
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
import type { FindingRow } from '../store/runs.js';
import type { ResolutionKind, ReviewRoundInput, TurnReport } from './publish.js';
import { RunRecorder } from './recorder.js';
import { ReportSchema, type Report } from './report.js';
import { loadRunState, type RunState } from './run-state.js';
import { parseRulings, type Ruling } from './triage.js';

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
  /** Fix rounds already used when this pass began: the caps count from here. */
  fixBase: { checkFix: number; reviewFix: number };
  rulingsWritten: boolean;
  /** The commit range of the latest fix turn, for judging how broad it was. */
  lastFix?: { from: string; to: string };
  /** The owner's rulings so far; written to `inputs/rulings.json` after every answer. */
  rulings: Ruling[];
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
    fixBase: { checkFix: st.rounds.checkFix, reviewFix: st.rounds.reviewFix },
    rulingsWritten: false,
    rulings: [],
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

const numeric = (a: number, b: number) => a - b;

/** The numbers n in the names `<prefix>n<suffix>` found in `names`, ascending. */
function numbered(names: string[], prefix: string, suffix: string): number[] {
  const re = new RegExp(`^${prefix}(\\d+)${suffix.replace('.', '\\.')}$`);
  return names
    .flatMap((n) => {
      const m = re.exec(n);
      return m ? [Number(m[1])] : [];
    })
    .sort(numeric);
}

/**
 * Review rounds from `reviews/round-<n>/findings.json`, with what the implementer said about
 * each finding. Same rule as `GET /api/runs/:id/findings`: a `review-fix-<n>` report belongs
 * to the closest earlier review, which is the review that started that fix. Each fix wrote
 * `inputs/findings-round-<r>.json` for its review round r, in order, so the n-th such file
 * names the round the n-th review-fix answered.
 */
async function loadRounds(runDir: string): Promise<ReviewRoundInput[]> {
  const fixedRounds = numbered(await listDir(join(runDir, 'inputs')), 'findings-round-', '.json');
  const fixReports = numbered(await listDir(join(runDir, 'reports')), 'review-fix-', '.json');
  const byRound = new Map<number, ReviewRoundInput['resolutions']>();
  for (const n of fixReports) {
    const round = fixedRounds[n - 1];
    if (round === undefined) continue;
    const parsed = ReportSchema.safeParse(
      await readJson(join(runDir, 'reports', `review-fix-${n}.json`)),
    );
    if (!parsed.success) continue;
    const mine = byRound.get(round) ?? {};
    byRound.set(round, mine);
    for (const r of parsed.data.findingResolutions) {
      mine[r.findingId] = { resolution: r.resolution as ResolutionKind, note: r.note };
    }
  }
  const rounds: ReviewRoundInput[] = [];
  for (const round of numbered(await listDir(join(runDir, 'reviews')), 'round-', '')) {
    const out = ReviewerOutputSchema.safeParse(
      await readJson(join(runDir, 'reviews', `round-${round}`, 'findings.json')),
    );
    if (!out.success) continue;
    const said = byRound.get(round) ?? {};
    const resolutions: ReviewRoundInput['resolutions'] = {};
    for (const f of out.data.findings) if (said[f.id]) resolutions[f.id] = said[f.id]!;
    rounds.push({
      round,
      reviewedSha: out.data.reviewedSha,
      summary: out.data.summary,
      findings: out.data.findings,
      resolutions,
    });
  }
  return rounds;
}

/**
 * Where the run has stored its findings, their statuses replace what the report files say:
 * the rows are the record. A round without rows (a run from before they existed) keeps the
 * file-based resolutions.
 */
function applyStoredStatuses(rounds: ReviewRoundInput[], rows: FindingRow[]): void {
  for (const round of rounds) {
    const mine = rows.filter((r) => r.round === round.round);
    if (mine.length === 0) continue;
    round.resolutions = {};
    for (const row of mine) {
      if (row.status === 'open') continue;
      round.resolutions[row.id] = {
        resolution: row.status,
        note: row.resolutionNote ?? '',
      };
    }
  }
}

const TURN_KINDS = ['implement', 'check-fix', 'review-fix', 'feedback'];

/**
 * Accepted implementer reports in turn order. With a store, that is the order of the run's
 * stage rows; reports it does not list (or without a store) follow by kind, then round.
 */
async function loadReports(
  runDir: string,
  runId: string,
  store?: PipelineDeps['store'],
): Promise<TurnReport[]> {
  const found = new Map<string, TurnReport>();
  for (const name of await listDir(join(runDir, 'reports'))) {
    const m = /^(.+)-(\d+)\.json$/.exec(name);
    if (!m || !TURN_KINDS.includes(m[1]!)) continue;
    const parsed = ReportSchema.safeParse(await readJson(join(runDir, 'reports', name)));
    if (!parsed.success) continue;
    found.set(`${m[1]}-${m[2]}`, { kind: m[1]!, round: Number(m[2]), report: parsed.data });
  }
  const ordered: TurnReport[] = [];
  try {
    for (const st of store?.listStages(runId) ?? []) {
      const key = `${st.kind}-${st.round}`;
      const turn = found.get(key);
      if (turn) {
        ordered.push(turn);
        found.delete(key);
      }
    }
  } catch {
    // Without stage rows the fallback order below applies.
  }
  const rest = [...found.values()].sort(
    (a, b) => TURN_KINDS.indexOf(a.kind) - TURN_KINDS.indexOf(b.kind) || a.round - b.round,
  );
  return [...ordered, ...rest];
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
  rec.attach(runId);
  applyStoredStatuses(ctx.rounds, rec.listFindings());
  ctx.reports = await loadReports(runDir, runId, deps.store);
  ctx.lastReport = ctx.reports.at(-1)?.report;
  ctx.rulingsWritten = (await listDir(join(runDir, 'inputs'))).includes('rulings.json');
  const rulings = parseRulings(await readJson(join(runDir, 'inputs', 'rulings.json')));
  ctx.rulings = rulings.rulings;
  if (rulings.invalid > 0) rec.event('rulings.invalid', { skipped: rulings.invalid });
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
