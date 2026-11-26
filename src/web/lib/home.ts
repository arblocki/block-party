import { isTerminal, type RunStage } from '../../core/run/machine';
import type { DecisionKind } from '../../core/store/runs';
import type { RunSummary } from '../types';

/** Finished runs the home page lists after the active ones. */
export const RECENT_RUN_LIMIT = 20;

export type StageTone = 'active' | 'done' | 'attention' | 'stopped';

export function stageTone(stage: RunStage): StageTone {
  if (!isTerminal(stage)) return 'active';
  switch (stage) {
    case 'complete':
      return 'done';
    case 'blocked':
    case 'failed':
      return 'attention';
    default:
      return 'stopped';
  }
}

const byUpdatedDesc = (a: RunSummary, b: RunSummary): number =>
  a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;

/** Active runs first, then the most recent others (capped), each group newest-updated first. */
export function orderRuns(runs: readonly RunSummary[], limit = RECENT_RUN_LIMIT): RunSummary[] {
  const active = runs.filter((r) => !isTerminal(r.stage)).sort(byUpdatedDesc);
  const rest = runs
    .filter((r) => isTerminal(r.stage))
    .sort(byUpdatedDesc)
    .slice(0, limit);
  return [...active, ...rest];
}

const DECISION_LABELS: Record<DecisionKind, string> = {
  blocked: 'Blocked',
  permission: 'Permission',
  interrupted: 'Interrupted',
  cap_reached: 'Cap reached',
  failed: 'Failed',
};

export function decisionLabel(kind: DecisionKind): string {
  return DECISION_LABELS[kind] ?? kind;
}
