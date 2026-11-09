export interface ImplementerSession {
  mode: 'pane' | 'headless';
  sessionId: string;
  cwd: string;
  paneLabel?: string;
}

export interface ImplementerStartInput {
  runId: string;
  cwd: string;
  runDir: string;
  prompt: string;
  model: string;
  agentsPath: string;
  settingsPath: string;
  eventsPath: string;
  reportPath: string;
  permissionMode: string;
  allowedTools: string[];
  disallowedTools: string[];
  timeoutMs: number;
  signal?: AbortSignal;
  /** Called as soon as the session exists (pane opened / process spawned), before the turn ends. */
  onSession?: (session: ImplementerSession) => void;
}

export type TurnOutcome =
  | { kind: 'report' } // report.json present (not yet validated)
  | { kind: 'no_report'; detail?: string }
  | { kind: 'permission'; message: string }
  | { kind: 'exited'; reason: string }
  | { kind: 'timeout' };

export interface ImplementerAdapter {
  start(
    input: ImplementerStartInput,
  ): Promise<{ session: ImplementerSession; outcome: TurnOutcome }>;
  /** New turn in the same conversation (resume if the process is gone). */
  send(
    session: ImplementerSession,
    input: ImplementerStartInput,
    message: string,
  ): Promise<TurnOutcome>;
  stop(session: ImplementerSession, opts?: { force?: boolean }): Promise<void>;
  describe(session: ImplementerSession): string; // e.g. attach command or log path
}
