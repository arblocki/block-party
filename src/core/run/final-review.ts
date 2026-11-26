import type { DecisionOption, RunStore } from '../store/runs.js';
import { isResting } from './machine.js';

export const FINAL_REVIEW_TITLE = 'Ready for your review';

export const FINAL_REVIEW_OPTIONS: DecisionOption[] = [
  { id: 'approve', label: 'Approve' },
  { id: 'send_back', label: 'Send back' },
];

/** Body of a final_review item that is reopened because the last answer could not be carried out. */
export function reopenedBody(title: string, reason: string): string {
  return `${title} is still waiting for your review. Your last answer could not be carried out: ${reason}`;
}

/**
 * Reopens a fresh `final_review` item for a run that is still resting, after an answer that
 * could not be carried out. Does nothing (returns null) when the run is not resting or already
 * has an open final review. Store only: used where there is no pipeline context.
 */
export function reopenFinalReview(runs: RunStore, runId: string, reason: string): number | null {
  try {
    const run = runs.getRun(runId);
    if (!run || !isResting(run.stage)) return null;
    const open = runs.listDecisions({ runId, status: 'open' });
    if (open.some((d) => d.kind === 'final_review')) return null;
    runs.appendEvent({
      runId,
      ts: new Date().toISOString(),
      type: 'continuation.failed',
      payload: { reason },
    });
    return runs.openDecision({
      runId,
      kind: 'final_review',
      title: FINAL_REVIEW_TITLE,
      body: reopenedBody(run.title, reason),
      options: FINAL_REVIEW_OPTIONS,
    });
  } catch {
    return null;
  }
}
