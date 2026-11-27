import { isTerminal, RUN_STAGES, type RunStage } from '../../core/run/machine';
import { stageLabel } from './stageLabel';
import type { RunEvent, RunSummary, StageKind, StageRow } from '../types';

export type StripState =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'done'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'stopped'
  | 'skipped';

export interface StripItem {
  key: 'plan' | 'implement' | 'checks' | 'review' | 'fix' | 'publish' | 'ci';
  label: string;
  state: StripState;
  /** What to show instead of the state word, e.g. "ready for you". */
  text?: string;
  /** How many times this stage ran (fix rounds, repeated CI runs, ...). */
  count: number;
  /** Acceptance criteria met, on the cells that produce implementer reports (Implement, Fix). */
  met?: { met: number; total: number };
  /** CI fix rounds, on the CI cell. */
  ciFixes?: number;
}

const STRIP: { key: StripItem['key']; label: string; kinds: StageKind[] }[] = [
  { key: 'implement', label: 'Build', kinds: ['implement'] },
  { key: 'checks', label: 'Local checks', kinds: ['checks'] },
  { key: 'review', label: 'Codex review', kinds: ['review'] },
  { key: 'fix', label: 'Fix', kinds: ['check-fix', 'review-fix', 'ci-fix', 'feedback'] },
  { key: 'publish', label: 'Open PR', kinds: ['publish'] },
  { key: 'ci', label: 'GitHub CI', kinds: ['wait-ci'] },
];

/**
 * The pipeline as six steps with a state each, derived from the stage rows: running if an
 * execution is open, else the state of the latest one. A step that never ran is pending, or
 * skipped once the run completed. A row still `running` in a finished run was cut off.
 */
export function stageStrip(
  stages: readonly StageRow[],
  run: Pick<RunSummary, 'stage'>,
  met: { met: number; total: number } | null = null,
  approved: boolean | null = null,
): StripItem[] {
  const finished = isTerminal(run.stage);
  // The count sits on the latest cell that produced reports: Fix if one ran, else Implement.
  const ran = (key: StripItem['key']) =>
    stages.some((s) => STRIP.find((x) => x.key === key)!.kinds.includes(s.kind));
  const metKey =
    met && met.total > 0 ? (ran('fix') ? 'fix' : ran('implement') ? 'implement' : null) : null;
  const items = STRIP.map(({ key, label, kinds }) => {
    const execs = stages.filter((s) => kinds.includes(s.kind));
    const last = execs.at(-1);
    let state: StripState;
    if (!last) state = run.stage === 'complete' ? 'skipped' : 'pending';
    else if (execs.some((s) => s.state === 'running')) state = finished ? 'stopped' : 'running';
    else state = last.state === 'succeeded' ? 'done' : (last.state as StripState);
    const ciFixes = key === 'ci' ? stages.filter((s) => s.kind === 'ci-fix').length : 0;
    return {
      key,
      label,
      state,
      count: execs.length,
      ...(key === metKey && met ? { met } : {}),
      ...(ciFixes > 0 ? { ciFixes } : {}),
    };
  });
  return [planItem(stages, run, approved), ...items];
}

/**
 * The Plan step: writing, ready for you, or approved; stopped when the run ended before a plan
 * was approved. `approved` says whether the run has an approved plan version (a pasted plan is
 * approved v1 from the start). It is null when unknown, e.g. a run from before plan versions
 * or versions not loaded yet; then any work past planning counts as approval.
 */
function planItem(
  stages: readonly StageRow[],
  run: Pick<RunSummary, 'stage'>,
  approved: boolean | null,
): StripItem {
  const base = { key: 'plan' as const, label: 'Plan', count: 0 };
  const done = approved ?? stages.some((s) => s.kind !== 'plan');
  if (approved === true) return { ...base, state: 'done', text: 'approved' };
  if (run.stage === 'setup' || run.stage === 'planning') {
    return { ...base, state: 'running', text: 'writing' };
  }
  if (run.stage === 'awaiting_plan_approval') {
    return { ...base, state: 'waiting', text: 'ready for you' };
  }
  if (isTerminal(run.stage) && run.stage !== 'complete' && !done) {
    return { ...base, state: 'stopped', text: 'stopped' };
  }
  return { ...base, state: 'done', text: 'approved' };
}

/**
 * Whether a run that has no plan versions may still have a plan file (a run from before plan
 * versions). One that ended without any work past planning never wrote a plan.
 */
export const mayHaveLegacyPlan = (stage: RunStage, stages: readonly StageRow[]): boolean =>
  !(isTerminal(stage) && stages.every((s) => s.kind === 'plan'));

export interface CheckResult {
  name: string;
  passed: boolean;
  logPath: string | null;
}

export interface CheckRun {
  round: number;
  state: StageRow['state'];
  /** Null while the checks run or when no result was recorded. */
  passed: boolean | null;
  checks: CheckResult[];
}

export interface ShaChecks {
  sha: string;
  runs: CheckRun[];
}

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Local CI executions grouped by the head SHA they ran on, in order of first appearance. */
export function checksBySha(stages: readonly StageRow[]): ShaChecks[] {
  const groups = new Map<string, ShaChecks>();
  for (const s of stages) {
    if (s.kind !== 'checks') continue;
    const sha = str(record(s.input).headSha) ?? 'unknown';
    const out = record(s.output);
    const rawChecks = Array.isArray(out.checks) ? out.checks : [];
    const run: CheckRun = {
      round: s.round,
      state: s.state,
      passed: typeof out.passed === 'boolean' ? out.passed : null,
      checks: rawChecks.map((c) => ({
        name: str(record(c).name) ?? '(unnamed)',
        passed: record(c).passed === true,
        logPath: str(record(c).logPath),
      })),
    };
    const group = groups.get(sha) ?? { sha, runs: [] };
    group.runs.push(run);
    groups.set(sha, group);
  }
  return [...groups.values()];
}

/** Whether the run's agent works in Claude Code's sandbox (`run.started` says so). */
export const isSandboxed = (events: readonly Pick<RunEvent, 'type' | 'payload'>[]): boolean =>
  events.some((e) => e.type === 'run.started' && record(e.payload).sandboxed === true);

/** `agent.*` events: one per tool call or turn, collapsed in the feed by default. */
export const isNoisyEvent = (type: string): boolean => type.startsWith('agent.');

const isRunStage = (v: string): v is RunStage => (RUN_STAGES as readonly string[]).includes(v);

const sameWords = (a: string, b: string): boolean =>
  a.replaceAll('_', ' ').toLowerCase() === b.replaceAll('_', ' ').toLowerCase();

const plural = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`;

/** One line for the activity feed. Unknown types, and known ones missing data, show the type. */
export function summarizeEvent(event: Pick<RunEvent, 'type' | 'payload'>): string {
  const { type } = event;
  const p = record(event.payload);
  const s = (k: string): string | null => str(p[k]);
  const num = (k: string): number | null => (typeof p[k] === 'number' ? (p[k] as number) : null);
  switch (type) {
    case 'run.started':
      return s('branch') ? `Run started on ${s('branch')}` : 'Run started';
    case 'stage': {
      const stage = s('stage');
      if (!stage) return type;
      const label = isRunStage(stage) ? stageLabel(stage) : stage;
      const note = s('note');
      return note && !sameWords(note, label) && !sameWords(note, stage)
        ? `${label}: ${note}`
        : label;
    }
    case 'implementer.session':
      return 'Implementer started';
    case 'implementer.waiting_for_human':
      return s('notice') ?? s('message') ?? 'Implementer is waiting for you';
    case 'implementer.stop_failed':
      return `Could not stop the implementer${s('error') ? `: ${s('error')}` : ''}`;
    case 'implementer.nudged':
      return s('reason') === 'requested'
        ? 'Sent the agent a nudge, as you asked'
        : `Agent went quiet${num('minutes') !== null ? ` for ${plural(num('minutes')!, 'minute')}` : ''}: sent it a nudge asking for a status`;
    case 'implementer.nudge_failed':
      return `Could not nudge the agent${s('error') ? `: ${s('error')}` : ''}`;
    case 'implementer.stalled':
      return `Agent may be stuck: ${
        s('reason') === 'idle' ? 'idle' : 'no activity'
      }${num('minutes') !== null ? ` for ${plural(num('minutes')!, 'minute')}` : ''}. Asked you what to do`;
    case 'implementer.resumed':
      return 'The agent resumed';
    case 'implementer.stall_waiting':
      return 'You chose to keep waiting for the agent';
    case 'implementer.stall_stopped':
      return 'You chose to stop the run because the agent went quiet';
    case 'planner.session':
      return 'Planner started';
    case 'planner.waiting_for_human':
      return s('notice') ?? s('message') ?? 'Planner is waiting for you';
    case 'planner.stop_failed':
      return `Could not stop the planner${s('error') ? `: ${s('error')}` : ''}`;
    case 'plan.approved':
      return num('version') !== null ? `Plan v${num('version')} approved` : 'Plan approved';
    case 'plan.invalid': {
      const n = Array.isArray(p.errors) ? p.errors.length : null;
      const v = num('version') !== null ? `Plan v${num('version')}` : 'Plan';
      return `${v} is invalid${n ? ` (${plural(n, 'error')})` : ''}`;
    }
    case 'plan.approval_unrecorded':
      return `Plan${num('version') !== null ? ` v${num('version')}` : ''} approval could not be recorded`;
    case 'continuation.failed':
      return `Continuation failed${s('reason') ? `: ${s('reason')}` : ''}`;
    case 'triage.not_asked': {
      const n = Array.isArray(p.findings) ? p.findings.length : null;
      return n !== null ? `Did not ask about ${plural(n, 'finding')}` : type;
    }
    case 'repeat.recorded':
      return s('key') ? `Finding ${s('key')} recorded as a repeat` : type;
    case 'rulings.invalid': {
      const n = num('skipped');
      return n !== null ? `Skipped ${plural(n, 'invalid ruling')}` : type;
    }
    case 'decision.answered':
      return s('choice') ? `You answered: ${s('choice')}` : type;
    case 'agent.init':
      return `Agent started${s('model') ? ` (${s('model')})` : ''}`;
    case 'agent.tool_use':
      return s('name') ? `Tool: ${s('name')}` : type;
    case 'agent.permission_denied':
      return `Permission denied${s('tool') ? ` for ${s('tool')}` : ''}`;
    case 'agent.permission_wait':
      return s('message') ? `Waiting for approval: ${s('message')}` : type;
    case 'agent.pane_opened':
      return `Terminal opened${s('label') ? `: ${s('label')}` : ''}`;
    case 'agent.result': {
      const turns = num('numTurns');
      const cost = num('totalCostUsd');
      const detail = [
        ...(turns !== null ? [plural(turns, 'turn')] : []),
        ...(cost !== null ? [`$${cost.toFixed(2)}`] : []),
      ];
      return `${p.isError === true ? 'Agent turn failed' : 'Agent turn finished'}${detail.length ? ` (${detail.join(', ')})` : ''}`;
    }
    case 'checks.result':
      return `Local checks ${p.passed === true ? 'passed' : 'failed'}${s('head') ? ` on ${s('head')}` : ''}`;
    case 'ci.failed': {
      const names = Array.isArray(p.checks) ? p.checks.filter((c) => typeof c === 'string') : [];
      return `GitHub CI failed${s('head') ? ` on ${s('head')}` : ''}${names.length ? `: ${names.join(', ')}` : ''}`;
    }
    case 'checks.warning':
    case 'permissions.warning':
    case 'drift.warning':
      return s('warning') ?? type;
    case 'drift.missing':
      return s('ref') ? `Plan reference missing: ${s('ref')}` : type;
    case 'drift.stale':
      return s('check') ? `Check ${s('check')} is stale${s('ref') ? ` (${s('ref')})` : ''}` : type;
    case 'review.result': {
      const found = num('findings');
      const blocking = num('blocking');
      if (found === null) return type;
      const round = num('round') !== null ? ` round ${num('round')}` : '';
      return `Review${round}: ${plural(found, 'finding')}${blocking !== null ? `, ${blocking} blocking` : ''}`;
    }
    case 'triage.asked': {
      const n = Array.isArray(p.findings) ? p.findings.length : null;
      return n !== null ? `Asked you to triage ${plural(n, 'finding')}` : type;
    }
    case 'triage.answered':
      return s('key') && s('choice') ? `Triage ${s('key')}: ${s('choice')}` : type;
    case 'dispute.opened': {
      const n = Array.isArray(p.findings) ? p.findings.length : null;
      return n !== null ? `${plural(n, 'finding')} disputed by the implementer` : type;
    }
    case 'dispute.answered':
      return s('key') && s('choice') ? `Dispute ${s('key')}: ${s('choice')}` : type;
    case 'fix.broad': {
      const files = num('files');
      const lines = num('lines');
      return files !== null && lines !== null
        ? `Fix looks broad: ${plural(files, 'file')}, ${plural(lines, 'line')}`
        : type;
    }
    case 'question':
      return s('question') ? `Question: ${s('question')}` : type;
    case 'pr':
      return num('number') !== null ? `Opened PR #${num('number')}` : type;
    case 'publish.stopped':
      return `Publish stopped${s('code') ? ` (${s('code')})` : ''}`;
    case 'db.error':
      return s('error') ?? s('message') ?? type;
    case 'run.queued':
      return num('position') !== null && num('position')! > 0
        ? `Waiting for a free slot (number ${num('position')} in line)`
        : 'Waiting for a free slot';
    case 'run.failed':
      return `Could not start${s('error') ? `: ${s('error')}` : ''}`;
    case 'run.interrupted':
      return `Run interrupted${s('note') ? `: ${s('note')}` : ''}`;
    case 'run.cancelled':
      return 'Run cancelled; its files and branch were kept';
    case 'run.resumed':
      return 'Run resumed';
    case 'reconcile.pane_alive':
      return p.state === 'working'
        ? 'After a restart: the agent is still running in its terminal'
        : "After a restart: the agent's terminal is still open";
    case 'resume.reattached':
    case 'agent.reattached':
      return 'Re-attached to the agent that was still running';
    case 'reconcile.agent_stopped':
      return 'The agent finished its turn while block-party was down';
    case 'reconcile.activity': {
      const n = num('toolCalls');
      return n !== null ? `${plural(n, 'tool call')} while block-party was down` : type;
    }
    default:
      return type;
  }
}

/** "Last activity 4 min ago" from the newest event; null when there are none. */
export function lastActivityLabel(
  events: readonly Pick<RunEvent, 'ts'>[],
  now = Date.now(),
): string | null {
  let latest = Number.NEGATIVE_INFINITY;
  for (const e of events) {
    const t = Date.parse(e.ts);
    if (!Number.isNaN(t) && t > latest) latest = t;
  }
  if (latest === Number.NEGATIVE_INFINITY) return null;
  const minutes = Math.max(0, Math.floor((now - latest) / 60_000));
  if (minutes < 1) return 'Last activity just now';
  if (minutes < 60) return `Last activity ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `Last activity ${hours} h ago`;
}
