/**
 * The run stage state machine: every stage a run can be in, and which moves between them are
 * legal. All stage changes go through `assertTransition`.
 */

export const ACTIVE_STAGES = [
  'setup',
  'implementing',
  'checking',
  'reviewing',
  'fixing',
  'publishing',
  'waiting_ci',
] as const;

export const TERMINAL_STAGES = [
  'complete',
  'blocked',
  'failed',
  'cancelled',
  'interrupted',
] as const;

export const RUN_STAGES = [...ACTIVE_STAGES, ...TERMINAL_STAGES] as const;

export type ActiveStage = (typeof ACTIVE_STAGES)[number];
export type TerminalStage = (typeof TERMINAL_STAGES)[number];
export type RunStage = (typeof RUN_STAGES)[number];

/** Forward moves between stages (the "happy path" and fix loops). */
const FORWARD: Record<ActiveStage, readonly RunStage[]> = {
  setup: ['implementing'],
  implementing: ['checking'],
  checking: ['reviewing', 'fixing'],
  fixing: ['checking'],
  // `complete` straight from review is the --no-publish path.
  reviewing: ['fixing', 'publishing', 'complete'],
  publishing: ['waiting_ci', 'complete'],
  waiting_ci: ['complete'],
};

/** Terminal stages every active stage can drop into. */
const ALWAYS_FROM_ACTIVE: readonly RunStage[] = ['blocked', 'failed', 'cancelled', 'interrupted'];

export function isTerminal(stage: RunStage): stage is TerminalStage {
  return (TERMINAL_STAGES as readonly RunStage[]).includes(stage);
}

export function canTransition(from: RunStage, to: RunStage): boolean {
  // Terminal stages have no outgoing moves (no resume yet).
  if (isTerminal(from)) return false;
  // Self-moves update the stage note.
  if (from === to) return true;
  return FORWARD[from].includes(to) || ALWAYS_FROM_ACTIVE.includes(to);
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

export function assertTransition(from: RunStage, to: RunStage): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}
