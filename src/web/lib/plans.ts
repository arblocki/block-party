import type { PlanVersion, RunDecision, RunDetail, RunEvent, RunSummary } from '../types';
import { stageLabel } from './stageLabel';

export interface DiffLine {
  kind: 'same' | 'add' | 'del';
  text: string;
}

/** Above this many line pairs (about 2000 x 2000, after trimming) the diff is not computed. */
export const MAX_DIFF_CELLS = 2000 * 2000;

/** A line diff of `a` into `b`, or null when the changed middle is too large to compare. */
export function lineDiff(a: string, b: string): DiffLine[] | null {
  const x = a === '' ? [] : a.split('\n');
  const y = b === '' ? [] : b.split('\n');
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let endX = x.length;
  let endY = y.length;
  while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) {
    endX--;
    endY--;
  }
  const mx = x.slice(start, endX);
  const my = y.slice(start, endY);
  if (mx.length * my.length > MAX_DIFF_CELLS) return null;
  const middle = lcsDiff(mx, my);
  return [
    ...x.slice(0, start).map((text): DiffLine => ({ kind: 'same', text })),
    ...middle,
    ...x.slice(endX).map((text): DiffLine => ({ kind: 'same', text })),
  ];
}

function lcsDiff(x: string[], y: string[]): DiffLine[] {
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

/** Why a queued run is not running yet: "Waiting for a free slot (2 of 3 in use)". */
export function queueLabel(queue: RunSummary['queue']): string {
  return queue && queue.inUse !== null && queue.max !== null
    ? `Waiting for a free slot (${queue.inUse} of ${queue.max} in use)`
    : 'Waiting for a free slot';
}

/** "Plan v<n> ready" from the plan version while awaiting approval; else the note. */
export function stageNoteLabel(
  run: Pick<RunSummary, 'stage' | 'stageNote' | 'planVersion'> & { queue?: RunSummary['queue'] },
): string | null {
  if (run.stage === 'queued') return queueLabel(run.queue ?? null);
  if (run.stage === 'awaiting_plan_approval' && run.planVersion !== null) {
    return `Plan v${run.planVersion} ready`;
  }
  const note = run.stageNote?.trim();
  if (!note) return null;
  // A note that only repeats the stage ("cancelled" on a cancelled run) adds nothing.
  return note.toLowerCase() === stageLabel(run.stage).toLowerCase() ||
    note.toLowerCase() === run.stage.replaceAll('_', ' ')
    ? null
    : note;
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
