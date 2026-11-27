import { isResting, isTerminal, type RunStage } from '../../core/run/machine';
import type { DecisionKind } from '../../core/store/runs';
import type { RunSummary } from '../types';

/** Finished runs the home page lists after the active ones. */
export const RECENT_RUN_LIMIT = 20;

export type StageTone = 'active' | 'waiting' | 'done' | 'attention' | 'stopped';

export function stageTone(stage: RunStage): StageTone {
  if (isResting(stage)) return 'waiting';
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

/**
 * Active runs first, then runs resting for a person, then the most recent finished ones
 * (capped), each group newest-updated first.
 */
export function orderRuns(runs: readonly RunSummary[], limit = RECENT_RUN_LIMIT): RunSummary[] {
  const active = runs
    .filter((r) => !isTerminal(r.stage) && !isResting(r.stage))
    .sort(byUpdatedDesc);
  const resting = runs.filter((r) => isResting(r.stage)).sort(byUpdatedDesc);
  const rest = runs
    .filter((r) => isTerminal(r.stage))
    .sort(byUpdatedDesc)
    .slice(0, limit);
  return [...active, ...resting, ...rest];
}

const DECISION_LABELS: Record<DecisionKind, string> = {
  blocked: 'Stuck',
  permission: 'Permission needed',
  interrupted: 'Interrupted',
  cap_reached: 'Limit reached',
  failed: 'Failed',
  plan_approval: 'Approve the plan',
  finding_triage: 'Review findings',
  dispute: 'Disagreement',
  broad_fix: 'Large fix',
  final_review: 'Review the PR',
  ci_gap: 'Missing CI check',
  resume_conflict: 'Check before resuming',
};

export function decisionLabel(kind: DecisionKind): string {
  return DECISION_LABELS[kind] ?? kind;
}

/** The repository a run belongs to, when its project is known. */
export function runProject(run: Pick<RunSummary, 'owner' | 'repo'>): {
  owner: string;
  repo: string;
} | null {
  return run.owner && run.repo ? { owner: run.owner, repo: run.repo } : null;
}

/** Options whose answer means nothing without a note saying what to change. */
const NOTE_REQUIRED = new Set(['send_back', 'revise']);
export const needsNote = (optionId: string): boolean => NOTE_REQUIRED.has(optionId);

export const NOTE_PREVIEW = 300;

/** The first `max` characters of an answered note, and whether the rest was cut. */
export function clipNote(note: string, max = NOTE_PREVIEW): { text: string; clipped: boolean } {
  return note.length > max
    ? { text: note.slice(0, max).trimEnd(), clipped: true }
    : { text: note, clipped: false };
}
