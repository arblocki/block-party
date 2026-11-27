import type { PlanVersion, RunDecision, RunDetail, RunEvent } from '../types';

export interface DiffLine {
  kind: 'same' | 'add' | 'del';
  text: string;
}

/** A line diff of `a` into `b` (longest common subsequence; plans are small). */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a === '' ? [] : a.split('\n');
  const y = b === '' ? [] : b.split('\n');
  // lcs[i][j]: length of the common subsequence of x[i..] and y[j..].
  const lcs: number[][] = Array.from({ length: x.length + 1 }, () =>
    new Array<number>(y.length + 1).fill(0),
  );
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      out.push({ kind: 'same', text: x[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: 'del', text: x[i++]! });
    } else {
      out.push({ kind: 'add', text: y[j++]! });
    }
  }
  while (i < x.length) out.push({ kind: 'del', text: x[i++]! });
  while (j < y.length) out.push({ kind: 'add', text: y[j++]! });
  return out;
}

/** The version to show first: the approved one, else the latest; null with no versions. */
export function defaultVersion(plans: readonly PlanVersion[]): number | null {
  const approved = plans.find((p) => p.status === 'approved');
  if (approved) return approved.version;
  return plans.reduce<number | null>((m, p) => (m === null || p.version > m ? p.version : m), null);
}

/** The open `plan_approval` decision while the run waits for one; otherwise null. */
export function planActions(
  run: Pick<RunDetail, 'stage'>,
  decisions: readonly RunDecision[],
): RunDecision | null {
  if (run.stage !== 'awaiting_plan_approval') return null;
  return (
    decisions.findLast(
      (d) => d.kind === 'plan_approval' && d.status === 'open' && d.options !== null,
    ) ?? null
  );
}

/** "Plan version 2 ready" as "Plan v2 ready"; other notes pass through. */
export function stageNoteLabel(stage: string, note: string | null): string | null {
  if (stage === 'awaiting_plan_approval' && note) {
    const m = /^Plan version (\d+) ready$/.exec(note);
    if (m) return `Plan v${m[1]} ready`;
  }
  return note;
}

/** The attach command of the planner's latest session, else null. */
export function plannerAttach(events: readonly RunEvent[]): string | null {
  let attach: string | null = null;
  for (const e of events) {
    if (e.type !== 'planner.session') continue;
    const a = (e.payload as { attach?: unknown } | null)?.attach;
    if (typeof a === 'string') attach = a;
  }
  return attach;
}
