export type TurnOutcome =
  | { kind: 'report' }
  | { kind: 'no_report'; detail?: string }
  | { kind: 'permission'; message: string }
  | { kind: 'exited'; reason: string }
  | { kind: 'timeout' };
