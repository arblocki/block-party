import type { RunStage } from '../../core/run/machine';

/** What a run's stage means to a person, instead of the raw stage id. */
export const STAGE_LABELS: Record<RunStage, string> = {
  setup: 'Getting ready',
  planning: 'Writing the plan',
  implementing: 'Building',
  checking: 'Running tests',
  reviewing: 'Being reviewed by Codex',
  fixing: 'Fixing problems',
  publishing: 'Opening the pull request',
  waiting_ci: 'Waiting for GitHub CI',
  awaiting_decision: 'Needs your answer',
  queued: 'Queued',
  awaiting_plan_approval: 'Plan ready for you',
  awaiting_review: 'Ready for your review',
  complete: 'Done',
  blocked: 'Stuck — needs you',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

export const stageLabel = (stage: RunStage): string => STAGE_LABELS[stage];
