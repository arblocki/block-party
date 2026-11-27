/**
 * The run stage state machine: every stage a run can be in, and which moves between them are
 * legal. All stage changes go through `assertTransition`.
 */

export const ACTIVE_STAGES = [
  'setup',
  'planning',
  'implementing',
  'checking',
  'reviewing',
  'fixing',
  'publishing',
  'waiting_ci',
  'awaiting_decision',
] as const;

/**
 * Stages where no process owns the run. Two wait for a person; `queued` waits for a free slot
 * (the manager starts it when one frees).
 */
export const RESTING_STAGES = ['awaiting_plan_approval', 'awaiting_review', 'queued'] as const;

export const TERMINAL_STAGES = [
  'complete',
  'blocked',
  'failed',
  'cancelled',
  'interrupted',
] as const;

export const RUN_STAGES = [...ACTIVE_STAGES, ...RESTING_STAGES, ...TERMINAL_STAGES] as const;

export type ActiveStage = (typeof ACTIVE_STAGES)[number];
export type RestingStage = (typeof RESTING_STAGES)[number];
export type TerminalStage = (typeof TERMINAL_STAGES)[number];
export type RunStage = (typeof RUN_STAGES)[number];

/** Forward moves between stages (the "happy path" and fix loops). */
const FORWARD: Record<ActiveStage, readonly RunStage[]> = {
  setup: ['implementing', 'planning'],
  planning: ['awaiting_plan_approval'],
  implementing: ['checking'],
  checking: ['reviewing', 'fixing'],
  fixing: ['checking'],
  // `complete` straight from review is the --no-publish path.
  reviewing: ['fixing', 'publishing', 'complete', 'awaiting_review'],
  publishing: ['waiting_ci', 'complete', 'awaiting_review'],
  waiting_ci: ['fixing', 'complete', 'awaiting_review'],
  // A question the pipeline waits on; the run goes back to whichever stage can resume.
  awaiting_decision: ['fixing', 'checking', 'reviewing', 'publishing'],
};

/** Moves out of resting stages. */
const FROM_RESTING: Record<RestingStage, readonly RunStage[]> = {
  // `queued` is the move of an answer that found no free slot.
  awaiting_plan_approval: ['planning', 'implementing', 'cancelled', 'queued'],
  awaiting_review: ['fixing', 'complete', 'cancelled', 'queued'],
  // Starts, or continues, once a slot is free. A start begins in `setup`; a continuation goes
  // where its entry leads (the stage it queued from is restored first, and it moves on from there).
  queued: [
    'setup',
    'planning',
    'implementing',
    'fixing',
    'checking',
    'reviewing',
    'publishing',
    'waiting_ci',
    'cancelled',
  ],
};

/** Terminal stages every active stage can drop into. */
const ALWAYS_FROM_ACTIVE: readonly RunStage[] = ['blocked', 'failed', 'cancelled', 'interrupted'];

/** Every active stage can stop to ask a question. */
const TO_DECISION: RunStage = 'awaiting_decision';

export function isResting(stage: RunStage): stage is RestingStage {
  return (RESTING_STAGES as readonly RunStage[]).includes(stage);
}

export function isTerminal(stage: RunStage): stage is TerminalStage {
  return (TERMINAL_STAGES as readonly RunStage[]).includes(stage);
}

/** Stages a run that stopped can be picked up again from (the run's own evidence decides where). */
const RESUMABLE_STAGES: readonly RunStage[] = ['interrupted', 'blocked'];

/** Where a resume may re-enter: the active stages a run does work in (or the queue). */
const RESUME_TARGETS: readonly RunStage[] = [
  // A resume that finds no free slot waits in the queue.
  'queued',
  'setup',
  'planning',
  'implementing',
  'checking',
  'reviewing',
  'fixing',
  'publishing',
  'waiting_ci',
];

/** `interrupted` and `blocked` runs can resume; `failed`, `cancelled` and `complete` never do. */
export function canResume(stage: RunStage): boolean {
  return RESUMABLE_STAGES.includes(stage);
}

export interface TransitionOptions {
  /** The move is a resume: the only way out of `interrupted` and `blocked`. */
  resume?: boolean;
  /** The move is a cancel of a stopped run (`interrupted` or `blocked` to `cancelled`). */
  cancel?: boolean;
}

export function canTransition(from: RunStage, to: RunStage, opts: TransitionOptions = {}): boolean {
  // Terminal stages have no ordinary outgoing moves; a resume, or a cancel of a run that
  // stopped (which nothing drives any more), are the exceptions.
  if (isTerminal(from)) {
    if (opts.cancel === true) return canResume(from) && to === 'cancelled';
    return opts.resume === true && canResume(from) && RESUME_TARGETS.includes(to);
  }
  // A resume or a cancel of a stopped run only leaves a stopped run.
  if (opts.resume || opts.cancel) return false;
  // Nothing owns a resting run, so it only leaves (no self-moves).
  if (isResting(from)) return FROM_RESTING[from].includes(to);
  // Self-moves update the stage note.
  if (from === to) return true;
  return FORWARD[from].includes(to) || to === TO_DECISION || ALWAYS_FROM_ACTIVE.includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: RunStage,
    readonly to: RunStage,
  ) {
    super(`Illegal run stage transition: ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function assertTransition(from: RunStage, to: RunStage, opts: TransitionOptions = {}): void {
  if (!canTransition(from, to, opts)) throw new IllegalTransitionError(from, to);
}
