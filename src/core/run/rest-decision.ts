import type { DecisionKind, DecisionOption, RunStore } from '../store/runs.js';
import type { RestingStage } from './machine.js';

export const FINAL_REVIEW_TITLE = 'Ready for your review';

export const FINAL_REVIEW_OPTIONS: DecisionOption[] = [
  { id: 'approve', label: 'Approve' },
  { id: 'send_back', label: 'Send back' },
];

export const PLAN_APPROVAL_TITLE = 'Plan ready for your approval';

export const PLAN_APPROVAL_OPTIONS: DecisionOption[] = [
  { id: 'approve', label: 'Approve' },
  { id: 'revise', label: 'Request changes' },
];

/** The question a resting run waits on: what to ask again when an answer cannot be carried out. */
export interface RestDecision {
  kind: DecisionKind;
  title: string;
  options: DecisionOption[];
  /** Body of the item that is reopened because the last answer failed. */
  reopenedBody(runTitle: string, reason: string): string;
}

const REST_DECISIONS: Record<RestingStage, RestDecision> = {
  awaiting_review: {
    kind: 'final_review',
    title: FINAL_REVIEW_TITLE,
    options: FINAL_REVIEW_OPTIONS,
    reopenedBody: (title, reason) =>
      `${title} is still waiting for your review. Your last answer could not be carried out: ${reason}`,
  },
  awaiting_plan_approval: {
    kind: 'plan_approval',
    title: PLAN_APPROVAL_TITLE,
    options: PLAN_APPROVAL_OPTIONS,
    reopenedBody: (title, reason) =>
      `The plan for ${title} is still waiting for your approval. Your last answer could not be carried out: ${reason}`,
  },
};

/** The decision a run in `stage` waits on; undefined for a stage that is not resting. */
export function restDecisionFor(stage: string): RestDecision | undefined {
  return (REST_DECISIONS as Record<string, RestDecision | undefined>)[stage];
}

/**
 * Reopens a fresh decision (same kind and options) for a run that is still resting, after an
 * answer that could not be carried out. Does nothing (returns null) when the run is not
 * resting or already has that decision open. Store only: used where there is no pipeline
 * context.
 */
export function reopenRestDecision(runs: RunStore, runId: string, reason: string): number | null {
  try {
    const run = runs.getRun(runId);
    const spec = run && restDecisionFor(run.stage);
    if (!run || !spec) return null;
    const open = runs.listDecisions({ runId, status: 'open' });
    if (open.some((d) => d.kind === spec.kind)) return null;
    runs.appendEvent({
      runId,
      ts: new Date().toISOString(),
      type: 'continuation.failed',
      payload: { reason },
    });
    return runs.openDecision({
      runId,
      kind: spec.kind,
      title: spec.title,
      body: spec.reopenedBody(run.title, reason),
      options: spec.options,
    });
  } catch {
    return null;
  }
}
