import { isTerminal } from '../../core/run/machine';
import type { RunEvent, RunSummary, StageKind, StageRow } from '../types';

export type StripState =
  'pending' | 'running' | 'done' | 'failed' | 'blocked' | 'cancelled' | 'stopped' | 'skipped';

export interface StripItem {
  key: 'implement' | 'checks' | 'review' | 'fix' | 'publish' | 'ci';
  label: string;
  state: StripState;
  /** How many times this stage ran (fix rounds, repeated CI runs, ...). */
  count: number;
}

const STRIP: { key: StripItem['key']; label: string; kinds: StageKind[] }[] = [
  { key: 'implement', label: 'Implement', kinds: ['implement'] },
  { key: 'checks', label: 'Local CI', kinds: ['checks'] },
  { key: 'review', label: 'Codex', kinds: ['review'] },
  { key: 'fix', label: 'Fix', kinds: ['check-fix', 'review-fix', 'feedback'] },
  { key: 'publish', label: 'Publish', kinds: ['publish'] },
  { key: 'ci', label: 'CI', kinds: ['wait-ci'] },
];

/**
 * The pipeline as six steps with a state each, derived from the stage rows: running if an
 * execution is open, else the state of the latest one. A step that never ran is pending, or
 * skipped once the run completed. A row still `running` in a finished run was cut off.
 */
export function stageStrip(
  stages: readonly StageRow[],
  run: Pick<RunSummary, 'stage'>,
): StripItem[] {
  const finished = isTerminal(run.stage);
  return STRIP.map(({ key, label, kinds }) => {
    const execs = stages.filter((s) => kinds.includes(s.kind));
    const last = execs.at(-1);
    let state: StripState;
    if (!last) state = run.stage === 'complete' ? 'skipped' : 'pending';
    else if (execs.some((s) => s.state === 'running')) state = finished ? 'stopped' : 'running';
    else state = last.state === 'succeeded' ? 'done' : (last.state as StripState);
    return { key, label, state, count: execs.length };
  });
}

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

/** `agent.*` events: one per tool call or turn, collapsed in the feed by default. */
export const isNoisyEvent = (type: string): boolean => type.startsWith('agent.');

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
      return `Stage ${stage.replace('_', ' ')}${s('note') ? `: ${s('note')}` : ''}`;
    }
    case 'implementer.session':
      return `Implementer session started${s('mode') ? ` (${s('mode')})` : ''}`;
    case 'implementer.waiting_for_human':
      return s('notice') ?? s('message') ?? 'Implementer is waiting for you';
    case 'implementer.stop_failed':
      return `Could not stop the implementer${s('error') ? `: ${s('error')}` : ''}`;
    case 'agent.init':
      return `Agent started${s('model') ? ` (${s('model')})` : ''}`;
    case 'agent.tool_use':
      return s('name') ? `Tool: ${s('name')}` : type;
    case 'agent.permission_denied':
      return `Permission denied${s('tool') ? ` for ${s('tool')}` : ''}`;
    case 'agent.permission_wait':
      return s('message') ? `Waiting for approval: ${s('message')}` : type;
    case 'agent.pane_opened':
      return `Pane opened${s('label') ? `: ${s('label')}` : ''}`;
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
      return `Local CI ${p.passed === true ? 'passed' : 'failed'}${s('head') ? ` on ${s('head')}` : ''}`;
    case 'checks.warning':
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
    case 'question':
      return s('question') ? `Question: ${s('question')}` : type;
    case 'pr':
      return num('number') !== null ? `Opened PR #${num('number')}` : type;
    case 'publish.stopped':
      return `Publish stopped${s('code') ? ` (${s('code')})` : ''}`;
    case 'db.error':
      return s('error') ?? s('message') ?? type;
    case 'run.interrupted':
      return `Run interrupted${s('note') ? `: ${s('note')}` : ''}`;
    default:
      return type;
  }
}
