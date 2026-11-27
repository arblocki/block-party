/**
 * Resuming a run that stopped as `interrupted` or `blocked`: where the run's own evidence says
 * it got to (`resumePoint`, a pure function), and the continuation that picks up from there
 * (`resumeRun`). Work that has evidence on the current head is never redone, round counters
 * keep their values, and a worktree that was touched since the run stopped is not guessed at:
 * the owner is asked first.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TurnOutcome } from '../agents/types.js';
import type { ChecksRunResult } from '../checks/run.js';
import type { RunStage } from './machine.js';
import type { StageKind, StageRow } from '../store/runs.js';
import type { Ctx } from './context.js';
import { abortable, throwIfAborted } from './pipeline-helpers.js';
import { RESUME_CONFLICT_OPTIONS, RESUME_CONFLICT_TITLE, RESUME_OPTIONS } from './rest-decision.js';
import type { Report } from './report.js';
import {
  feedbackDuties,
  findingOfKey,
  fixItem,
  reviewFixDuties,
  type FixDuties,
  type LoopEnv,
  writeRulings,
} from './triage-loop.js';
import { writeArtifact } from './artifacts.js';
import { writeImplementerFiles } from './agent-files.js';

/** The kinds of stage that are an implementer turn. */
export type TurnKind =
  'implement' | 'check-fix' | 'review-fix' | 'ci-fix' | 'feedback' | 'resume-commit';

const TURN_KINDS: readonly StageKind[] = [
  'implement',
  'check-fix',
  'review-fix',
  'ci-fix',
  'feedback',
  'resume-commit',
];

export type ResumePoint =
  /** The worktree was touched since the run stopped: ask before guessing. */
  | { kind: 'ask'; reason: string; canKeep: boolean }
  /** The run never got an approved plan: plan again, with the last feedback. */
  | { kind: 'plan'; feedback: string | null }
  /** The last agent turn has no accepted report. `reportPending`: it wrote one, not judged. */
  | {
      kind: 'turn';
      turnKind: TurnKind;
      n: number;
      reportPending: boolean;
      /** Uncommitted paths the worktree holds from before the interruption. */
      dirtyFiles: string[];
    }
  | { kind: 'checks' }
  | { kind: 'review' }
  | { kind: 'publish' }
  | { kind: 'wait_ci' }
  | { kind: 'rest_review' };

/** One recorded stage execution, as far as the resume point cares. */
export type StageEvidence = Pick<StageRow, 'kind' | 'round' | 'state' | 'input' | 'output'>;

/** Everything `resumePoint` decides from. */
export interface ResumeEvidence {
  /** The stage the run stopped in (`interrupted` or `blocked`). */
  stage: RunStage;
  /** Where the run's working folder lives (named in a question). */
  worktreePath: string;
  /** The run has an approved plan. */
  planApproved: boolean;
  /** The note the planner was last asked to revise with; null for a first plan. */
  planFeedback: string | null;
  /** The head the run recorded after its last accepted turn; null before the first. */
  recordedHead: string | null;
  /** The worktree's HEAD now; null when the worktree cannot be read (it is missing). */
  head: string | null;
  /** Uncommitted paths (porcelain status lines). */
  dirtyFiles: string[];
  /** Heads whose review the loop accepted (`review.accepted` events). */
  acceptedHeads?: string[];
  /** Commits from `recordedHead` to `head` (empty when they are the same). */
  newCommits: { sha: string; subject: string }[];
  /** Every stage execution, in start order. */
  stages: StageEvidence[];
  /** An unconsumed report.json is on disk. */
  reportPending: boolean;
  prNumber: number | null;
  /** The pull request's head commit now; undefined when it could not be read. */
  prHead?: string | null;
  /** The run publishes a pull request, and waits for its CI. */
  publish: boolean;
  waitForCi: boolean;
}

export interface ResumeOptions {
  /** The owner chose to keep the worktree as it is: no question about it. */
  keep?: boolean;
}

const inputOf = (s: StageEvidence): Record<string, unknown> =>
  s.input && typeof s.input === 'object' ? (s.input as Record<string, unknown>) : {};
const outputOf = (s: StageEvidence): Record<string, unknown> =>
  s.output && typeof s.output === 'object' ? (s.output as Record<string, unknown>) : {};

const short = (sha: string) => sha.slice(0, 7);

function listFiles(lines: string[]): string {
  const names = lines.map((l) => l.slice(3).trim() || l.trim());
  const shown = names.slice(0, 8).join(', ');
  return names.length > 8 ? `${shown} and ${names.length - 8} more` : shown;
}

/** The last stage execution that was an implementer turn. */
function lastTurn(stages: StageEvidence[]): StageEvidence | undefined {
  return [...stages].reverse().find((s) => TURN_KINDS.includes(s.kind));
}

/**
 * Where a stopped run picks up again, from its stage history and the worktree. Pure. The rules,
 * in order:
 *
 * 1. Uncommitted changes, or a HEAD that moved, when no unfinished turn explains them, ask
 *    (unless the owner chose to `keep`). A missing worktree always asks.
 * 2. No approved plan: plan.
 * 3. The last agent turn has no accepted report: that turn again.
 * 4. Otherwise by the evidence on the current head: local CI, then review, then the push, then
 *    GitHub CI, and when all of it is there, rest for review.
 */
export function resumePoint(ev: ResumeEvidence, opts: ResumeOptions = {}): ResumePoint {
  const head = ev.head;
  if (head === null) {
    return {
      kind: 'ask',
      canKeep: false,
      reason: `The run's working folder is missing (${ev.worktreePath}), so there is nothing to continue from. Block-party does not recreate it.`,
    };
  }
  const last = lastTurn(ev.stages);
  const turnOpen = ev.planApproved && (last === undefined || last.state !== 'succeeded');

  if (!opts.keep) {
    const problems: string[] = [];
    // An unfinished turn explains uncommitted changes and new commits: they are its own work.
    if (ev.dirtyFiles.length > 0 && !turnOpen) {
      problems.push(`The working folder has uncommitted changes: ${listFiles(ev.dirtyFiles)}.`);
    }
    // Commits made while a turn was running belong to that turn; any others are unexplained.
    if (ev.recordedHead !== null && head !== ev.recordedHead && !turnOpen) {
      const list = ev.newCommits
        .slice(0, 5)
        .map((c) => `${short(c.sha)} ${c.subject}`)
        .join('; ');
      const n = ev.newCommits.length;
      problems.push(
        `The branch moved since the run stopped (${short(ev.recordedHead)} to ${short(head)}${
          n > 0 ? `, ${n} new commit${n === 1 ? '' : 's'}: ${list}` : ''
        }).`,
      );
    }
    if (problems.length > 0) {
      return {
        kind: 'ask',
        canKeep: true,
        reason: `${problems.join(' ')} Keep them and continue from here, or cancel?`,
      };
    }
  }

  if (!ev.planApproved) return { kind: 'plan', feedback: ev.planFeedback };

  // Kept uncommitted changes past the agent turn: the agent settles them (commit or revert)
  // before anything is checked, so no check or review is recorded against a HEAD without them.
  if (!turnOpen && opts.keep && ev.dirtyFiles.length > 0) {
    const done = ev.stages.filter((s) => s.kind === 'resume-commit').length;
    return {
      kind: 'turn',
      turnKind: 'resume-commit',
      n: done + 1,
      reportPending: ev.reportPending,
      dirtyFiles: ev.dirtyFiles,
    };
  }

  if (turnOpen) {
    return {
      kind: 'turn',
      turnKind: (last?.kind ?? 'implement') as TurnKind,
      n: last?.round ?? 1,
      reportPending: ev.reportPending,
      dirtyFiles: ev.dirtyFiles,
    };
  }

  const onHead = (kind: StageKind, key: string) =>
    ev.stages.filter((s) => s.kind === kind && inputOf(s)[key] === head);

  if (!onHead('checks', 'headSha').some((s) => s.state === 'succeeded')) return { kind: 'checks' };

  const reviews = onHead('review', 'reviewedSha').filter((s) => s.state === 'succeeded');
  // Reviewed means a clean review, or one the loop accepted as it is (the fix cap, or findings
  // the owner ruled on), which the loop records. A head that was pushed was accepted too, which
  // is how older runs show it. Anything else is reviewed again (rulings carry over).
  const pushedBefore = onHead('publish', 'headSha').some((s) => s.state === 'succeeded');
  const reviewed =
    reviews.some((s) => outputOf(s).blocking === 0) ||
    (reviews.length > 0 && ((ev.acceptedHeads ?? []).includes(head) || pushedBefore));
  if (!reviewed) return { kind: 'review' };

  if (!ev.publish) return { kind: 'rest_review' };
  const pushed =
    onHead('publish', 'headSha').some((s) => s.state === 'succeeded') &&
    (ev.prHead === undefined || ev.prHead === head);
  if (!pushed) return { kind: 'publish' };
  if (!ev.waitForCi) return { kind: 'rest_review' };
  if (!onHead('wait-ci', 'headSha').some((s) => s.state === 'succeeded')) {
    return { kind: 'wait_ci' };
  }
  return { kind: 'rest_review' };
}

/**
 * The fix rounds already used when the current pass began: the highest round of each kind
 * before the last feedback row (a resumed turn adds a second row for its round, not a round).
 */
export function fixBaseOf(stages: StageEvidence[]): Ctx['fixBase'] {
  const at = stages.map((s) => s.kind).lastIndexOf('feedback');
  const before = at < 0 ? [] : stages.slice(0, at);
  const top = (kind: StageKind) =>
    Math.max(0, ...before.filter((s) => s.kind === kind).map((s) => s.round));
  return { checkFix: top('check-fix'), reviewFix: top('review-fix'), ciFix: top('ci-fix') };
}

/** What `resumeRun` needs from the pipeline (passed in, so this file does not import it). */
export interface ResumeSteps {
  setStage(ctx: Ctx, stage: RunStage, note: string | null, resume?: boolean): Promise<void>;
  patchState(ctx: Ctx, patch: Partial<Ctx['st']>): Promise<void>;
  planStep(ctx: Ctx, feedback: string | null, reattach?: boolean): Promise<void>;
  implement(ctx: Ctx): Promise<void>;
  judgeTurn(
    ctx: Ctx,
    outcome: TurnOutcome,
    kind: string,
    n: number,
    prevHead: string,
    extra: TurnExtras,
  ): Promise<Report>;
  inStage<T>(
    ctx: Ctx,
    kind: StageKind,
    round: number,
    input: unknown,
    fn: () => Promise<T>,
    result: (value: T) => {
      state?: 'succeeded' | 'failed' | 'blocked' | 'cancelled';
      output?: unknown;
    },
  ): Promise<T>;
  turnEnded<T>(ctx: Ctx, turn: Promise<T>): Promise<T>;
  verifyLoop(ctx: Ctx, opts?: { skipChecks?: boolean }): Promise<void>;
  finishRun(ctx: Ctx): Promise<void>;
  publishAndWait(ctx: Ctx, opts?: { startAtCi?: boolean }): Promise<void>;
  restForReview(ctx: Ctx, note: string | null): Promise<void>;
  requireOpenPr(ctx: Ctx): Promise<void>;
  loopEnv: LoopEnv;
  halt(note: string): Error;
  describeSession(ctx: Ctx): string;
}

/** What a fix turn's report must account for. */
export interface TurnExtras {
  validate?: (report: Report) => string | null;
  requireCommit?: (report: Report) => boolean;
  planner?: boolean;
}

/** Resolves the open questions that offered this resume (the run is moving on). */
function closeStoppedQuestions(ctx: Ctx): void {
  const store = ctx.deps.store;
  if (!store) return;
  try {
    for (const status of ['open', 'answered'] as const) {
      for (const d of store.listDecisions({ runId: ctx.st.id, status })) {
        // Items from before they carried options are closed too; the informational
        // cap_reached item (no options) stays.
        const mine =
          d.kind === 'interrupted' ||
          d.kind === 'blocked' ||
          ((d.kind === 'cap_reached' || d.kind === 'resume_conflict') && d.options !== null);
        if (mine) store.resolveDecision(d.id);
      }
    }
  } catch {
    // The store failing here only leaves a stale question.
  }
}

/** Ends stage executions a dead process left `running`: nothing is running them any more. */
export function closeStaleStages(ctx: Pick<Ctx, 'st' | 'deps'>): void {
  const store = ctx.deps.store;
  if (!store) return;
  try {
    for (const s of store.listStages(ctx.st.id)) {
      if (s.state === 'running') {
        store.endStage(s.id, { state: 'cancelled', output: { error: 'interrupted' } });
      }
    }
  } catch {
    // Stale rows only make the history untidy.
  }
}

/**
 * A resume that failed before the run left its stopped stage: the run stays as it was, and the
 * question comes back saying why.
 */
export function reopenStopped(ctx: Ctx, e: unknown): void {
  const reason = e instanceof Error ? e.message : String(e);
  // Never two open items for one stopped run, whatever failed.
  closeStoppedQuestions(ctx);
  ctx.rec.release();
  ctx.rec.event('resume.failed', { reason });
  const stage = ctx.st.stage;
  const interrupted = stage === 'interrupted';
  ctx.rec.openDecision(
    interrupted ? 'interrupted' : 'blocked',
    interrupted ? 'Run interrupted' : 'Run blocked',
    `${ctx.st.title} could not be resumed: ${reason}`,
    ctx.session ? ctx.deps.adapter.describe(ctx.session) : null,
    RESUME_OPTIONS,
  );
}

async function gather(ctx: Ctx): Promise<ResumeEvidence> {
  const { st, deps } = ctx;
  const stages = (deps.store?.listStages(st.id) ?? []).map((s) => ({
    kind: s.kind,
    round: s.round,
    state: s.state,
    input: s.input,
    output: s.output,
  }));
  let head: string | null = null;
  let dirtyFiles: string[] = [];
  let newCommits: { sha: string; subject: string }[] = [];
  try {
    head = await deps.git.headSha(st.worktreePath);
    dirtyFiles = await deps.git.statusLines(st.worktreePath);
    if (st.headSha !== null && st.headSha !== head) {
      newCommits = await deps.git.commitsBetween(st.worktreePath, st.headSha, head);
    }
  } catch {
    // An unreadable worktree is a missing one when HEAD itself cannot be read.
    if (head === null) dirtyFiles = [];
  }
  const plans = ctx.rec.listPlans();
  let planFeedback: string | null = null;
  if (st.planPath === '' && plans.length > 0 && deps.store) {
    // The planner was revising: the note is on the last answered plan_approval question.
    const asked = deps.store
      .listDecisions({ runId: st.id, status: 'answered' })
      .filter((d) => d.kind === 'plan_approval' && d.answer?.choice === 'revise');
    planFeedback = asked.at(-1)?.answer?.note ?? null;
  }
  let reportPending = false;
  try {
    await readFile(ctx.reportPath, 'utf8');
    reportPending = true;
  } catch {
    // No report waiting.
  }
  let prHead: string | null | undefined;
  const pushedOnce = stages.some((s) => s.kind === 'publish' && s.state === 'succeeded');
  if (st.prNumber !== null && pushedOnce) {
    try {
      const github = await deps.github();
      prHead = (await github.getPr({ owner: st.owner, repo: st.repo }, st.prNumber)).headSha;
    } catch {
      // Without GitHub the stage rows are the evidence.
    }
  }
  const acceptedHeads: string[] = [];
  try {
    let after = 0;
    for (;;) {
      const page = deps.store?.listEvents(st.id, { afterId: after, limit: 500 }) ?? [];
      for (const e of page) {
        const h = (e.payload as { head?: unknown } | null)?.head;
        if (e.type === 'review.accepted' && typeof h === 'string') acceptedHeads.push(h);
      }
      if (page.length < 500) break;
      after = page.at(-1)!.id;
    }
  } catch {
    // Without the events the stage rows decide.
  }
  return {
    stage: st.stage,
    worktreePath: st.worktreePath,
    planApproved: st.planPath !== '',
    planFeedback,
    recordedHead: st.headSha,
    head,
    dirtyFiles,
    newCommits,
    acceptedHeads,
    stages,
    reportPending,
    prNumber: st.prNumber,
    ...(prHead !== undefined ? { prHead } : {}),
    publish: ctx.input.config.publish,
    waitForCi: ctx.input.config.waitForCi,
  };
}

/** The stage a resume enters; the loop then moves on as it does in a fresh run. */
function targetStage(point: ResumePoint, st: Ctx['st']): RunStage {
  switch (point.kind) {
    case 'plan':
      return 'planning';
    case 'turn':
      return point.turnKind === 'implement' ? 'implementing' : 'fixing';
    case 'checks':
      return 'checking';
    case 'review':
      return 'reviewing';
    case 'publish':
      return 'publishing';
    case 'wait_ci':
      return 'waiting_ci';
    case 'rest_review':
      return st.prNumber !== null ? 'waiting_ci' : 'reviewing';
    case 'ask':
      return st.stage;
  }
}

/** Puts back what a resting run's context would have had but a stopped run's lacks. */
function restoreEvidence(ctx: Ctx, stages: StageEvidence[], head: string): void {
  // A round's findings file says which commit it reviewed; the stage row is the record.
  for (const s of stages) {
    if (s.kind !== 'review' || s.state !== 'succeeded') continue;
    const reviewedSha = inputOf(s).reviewedSha;
    const round = ctx.rounds.find((r) => r.round === s.round);
    if (round && typeof reviewedSha === 'string') round.reviewedSha = reviewedSha;
  }
  const passed = stages.find(
    (s) => s.kind === 'checks' && s.state === 'succeeded' && inputOf(s).headSha === head,
  );
  if (passed) {
    const rows = Array.isArray(outputOf(passed).checks)
      ? (outputOf(passed).checks as { name: string; logPath: string }[])
      : [];
    const result: ChecksRunResult = {
      headSha: head,
      passed: true,
      results: rows.map((c) => ({
        name: c.name,
        command: ctx.checks.required.find((r) => r.name === c.name)?.run ?? c.name,
        cwd: ctx.st.worktreePath,
        exitCode: 0,
        durationMs: 0,
        timedOut: false,
        logPath: c.logPath,
      })),
    };
    ctx.lastChecks = result;
  }
  ctx.fixBase = fixBaseOf(stages);
}

function noteFor(point: ResumePoint): string {
  switch (point.kind) {
    case 'ask':
      return 'Resuming';
    case 'plan':
      return 'Resumed: planning again';
    case 'turn':
      return `Resumed: ${point.turnKind} ${point.n}`;
    case 'checks':
      return 'Resumed: local CI';
    case 'review':
      return 'Resumed: review';
    case 'publish':
      return 'Resumed: publishing';
    case 'wait_ci':
      return 'Resumed: waiting for GitHub CI';
    case 'rest_review':
      return 'Resumed: everything was done';
  }
}

/**
 * The resume continuation. `ctx` is a stopped run's context (`loadContext(..., 'resumable')`).
 * Works out the resume point, then either asks (the run stays stopped), or moves the run into
 * the stage of that point and runs the loop from there to its next rest or stop.
 */
export async function resumeRun(
  ctx: Ctx,
  entry: { keep?: boolean },
  steps: ResumeSteps,
): Promise<void> {
  if (!ctx.deps.store) throw new Error('Resuming needs the run database');
  const from = ctx.st.stage;
  const stageNote = ctx.st.stageNote;
  const ev = await gather(ctx);
  const point = resumePoint(ev, { keep: entry.keep === true });

  if (point.kind === 'ask') {
    closeStoppedQuestions(ctx);
    ctx.rec.release();
    ctx.rec.event('run.resume_asked', { from, reason: point.reason });
    ctx.rec.openDecision(
      'resume_conflict',
      RESUME_CONFLICT_TITLE,
      `${ctx.st.title}: ${point.reason}`,
      ctx.session ? ctx.deps.adapter.describe(ctx.session) : null,
      point.canKeep ? RESUME_CONFLICT_OPTIONS : RESUME_CONFLICT_OPTIONS.slice(1),
    );
    return;
  }

  const head = ev.head!;
  closeStaleStages(ctx);
  closeStoppedQuestions(ctx);
  ctx.rec.event('run.resumed', {
    from,
    point: point.kind,
    ...(point.kind === 'turn' ? { turn: `${point.turnKind}-${point.n}` } : {}),
    ...(entry.keep ? { keep: true } : {}),
  });
  restoreEvidence(ctx, ev.stages, head);
  throwIfAborted(ctx.input.signal);
  await steps.setStage(ctx, targetStage(point, ctx.st), noteFor(point), true);
  // The owner accepted what is in the worktree: it is the run's head now. (A turn in progress
  // records its own head when it is judged, and compares against the one before it.)
  if (entry.keep && point.kind !== 'turn' && head !== ctx.st.headSha) {
    await steps.patchState(ctx, { headSha: head });
  }
  if (ctx.st.sessionEnded) await steps.patchState(ctx, { sessionEnded: false });

  switch (point.kind) {
    case 'plan':
      await steps.planStep(ctx, point.feedback, true);
      return;
    case 'turn':
      await resumeTurn(ctx, point, steps, from === 'blocked' ? stageNote : null);
      await steps.verifyLoop(ctx);
      await steps.finishRun(ctx);
      return;
    case 'checks':
      await steps.verifyLoop(ctx);
      await steps.finishRun(ctx);
      return;
    case 'review':
      await steps.verifyLoop(ctx, { skipChecks: true });
      await steps.finishRun(ctx);
      return;
    case 'publish':
      await steps.publishAndWait(ctx);
      return;
    case 'wait_ci':
      await steps.publishAndWait(ctx, { startAtCi: true });
      return;
    case 'rest_review': {
      const n = ctx.st.prNumber;
      await steps.restForReview(
        ctx,
        n !== null
          ? `PR #${n} https://github.com/${ctx.st.owner}/${ctx.st.repo}/pull/${n}`
          : 'Everything was done before the run stopped',
      );
      return;
    }
  }
}

async function numbered(dir: string, prefix: string, suffix: string): Promise<number[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const re = new RegExp(`^${prefix}(\\d+)${suffix.replace('.', '\\.')}$`);
  return names
    .flatMap((n) => {
      const m = re.exec(n);
      return m ? [Number(m[1])] : [];
    })
    .sort((a, b) => a - b);
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** What a fix turn must account for, and what follows its report, rebuilt from the run files. */
async function fixDuties(ctx: Ctx, kind: TurnKind, n: number, env: LoopEnv): Promise<FixDuties> {
  if (kind === 'feedback') {
    const keys = await readJson(join(ctx.runDir, 'inputs', `feedback-${n}.keys.json`));
    const items = (Array.isArray(keys) ? (keys as string[]) : []).flatMap((key) => {
      const found = findingOfKey(ctx, key);
      return found ? [fixItem(found.round, found.finding)] : [];
    });
    return feedbackDuties(env, ctx, items);
  }
  if (kind !== 'review-fix') return { extra: {}, after: async () => undefined };
  // review-fix: the n-th findings file belongs to the n-th review fix.
  const rounds = await numbered(join(ctx.runDir, 'inputs'), 'findings-round-', '.json');
  const round = rounds[n - 1];
  const file =
    round === undefined
      ? undefined
      : await readJson(join(ctx.runDir, 'inputs', `findings-round-${round}.json`));
  const items = (Array.isArray(file) ? (file as { id?: unknown }[]) : []).flatMap((f) => {
    const id = typeof f.id === 'string' ? f.id : '';
    const found = findingOfKey(ctx, /^r\d+:/.test(id) ? id : `r${round}:${id}`);
    return found ? [fixItem(found.round, found.finding)] : [];
  });
  return reviewFixDuties(env, ctx, items, (i) => (i.round === round ? i.id : i.key));
}

/** The instructions of a `resume-commit` turn: settle what the worktree holds. */
function resumeCommitBrief(files: string[]): string {
  const list = files.map((f) => f.slice(3).trim() || f.trim()).join(', ');
  return `# Settle uncommitted changes

The worktree has uncommitted changes from before an interruption (${list}).

Commit the ones that belong to this task and revert any that do not. When the worktree is
clean, write report.json (status "done") and stop.
`;
}

/**
 * The step that picks an interrupted agent turn back up: the implementer's session (its
 * conversation survives its process) is told it was interrupted, and the turn is judged as
 * usual. A report the agent already wrote is judged without sending anything. A run that never
 * recorded a session starts the first turn again. A pane whose agent is still working in its
 * live terminal is waited on (`reattach`), and a live idle one is sent to; a second session is
 * only launched when the pane is gone.
 */
export async function resumeTurn(
  ctx: Ctx,
  point: Extract<ResumePoint, { kind: 'turn' }>,
  steps: ResumeSteps,
  blockedBy: string | null,
): Promise<void> {
  const { turnKind: kind, n } = point;
  if (!ctx.session) {
    if (kind !== 'implement') {
      throw steps.halt(`The ${kind} turn has no agent session to resume.`);
    }
    await steps.implement(ctx);
    return;
  }
  const { deps, st, input } = ctx;
  const settling = kind === 'resume-commit';
  const brief = settling
    ? (
        await writeArtifact(
          ctx.runDir,
          `briefs/${kind}-${n}.md`,
          resumeCommitBrief(point.dirtyFiles),
        )
      ).path
    : join(ctx.runDir, 'briefs', `${kind}-${n}.md`);
  // A send-back's turn is only worth running while its pull request is open.
  if (kind === 'feedback') await steps.requireOpenPr(ctx);
  const duties: FixDuties = settling
    ? { extra: { requireCommit: () => false }, after: async () => undefined }
    : await fixDuties(ctx, kind, n, steps.loopEnv);
  // The head the turn started from: the last accepted one (the base before any turn); a turn
  // that settles kept changes starts from whatever HEAD is now.
  const prevHead = settling ? await deps.git.headSha(st.worktreePath) : (st.headSha ?? st.baseSha);
  const why = blockedBy ? ` The run had stopped because: ${blockedBy}` : '';
  const left =
    point.dirtyFiles.length > 0 && !settling
      ? ' The worktree still has your uncommitted changes from before the interruption: check `git status` and carry on from them.'
      : '';
  const message = settling
    ? `The worktree has uncommitted changes from before an interruption (${point.dirtyFiles
        .map((f) => f.slice(3).trim() || f.trim())
        .join(
          ', ',
        )}). Commit the ones that belong to this task and revert any that don't; write the report. Details: ${brief}`
    : `You were interrupted. Continue the task in ${brief}; write the report when done.${left}${why}`;
  const session = ctx.session;
  // An agent may have edited the rulings file while it ran: restore it from the database.
  await writeRulings(ctx);
  await writeImplementerFiles(ctx);
  const report = await steps.inStage(
    ctx,
    kind,
    n,
    { brief, model: ctx.start.model, resumed: true },
    async () => {
      const outcome: TurnOutcome = point.reportPending
        ? { kind: 'report' }
        : await steps.turnEnded(
            ctx,
            abortable(
              (async () => {
                // The agent may still be working in its own terminal (the server died, the
                // terminal did not): wait for that turn instead of sending on top of it.
                // `send` also prefers a live pane to starting a second session.
                const input2 = { ...ctx.start, prompt: message };
                const attached = await deps.adapter.reattach?.(session, input2);
                if (attached) {
                  ctx.rec.event('resume.reattached', { label: session.paneLabel });
                  return attached;
                }
                return deps.adapter.send(session, input2, message);
              })(),
              input.signal,
            ),
          );
      // A pane resume may have relaunched under a new label.
      if (session.paneLabel !== undefined && st.implementer?.paneLabel !== session.paneLabel) {
        await steps.patchState(ctx, {
          implementer: { ...st.implementer!, paneLabel: session.paneLabel },
        });
      }
      return steps.judgeTurn(ctx, outcome, kind, n, prevHead, duties.extra);
    },
    () => ({ output: { report: join(ctx.runDir, 'reports', `${kind}-${n}.json`) } }),
  );
  ctx.lastFix = { from: prevHead, to: ctx.st.headSha ?? prevHead };
  await duties.after(report);
}
