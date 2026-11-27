export interface ImplementerSession {
  mode: 'pane' | 'headless';
  sessionId: string;
  cwd: string;
  paneLabel?: string;
}

export interface ImplementerStartInput {
  runId: string;
  /** Which agent this is: names its pane and saved output apart (default `impl`). */
  role?: 'impl' | 'plan';
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
  /**
   * Pane mode only: called when the agent is waiting for a human permission decision. The
   * adapter keeps waiting for the turn to end (until the timeout or abort).
   */
  onPermission?: (message: string) => void;
  /** Any sign of life during the turn (a hook line, a stream event): feeds stall detection. */
  onActivity?: () => void;
  /**
   * Pane mode only: the terminal's view of the agent. `stopped`: a final Stop was seen, so the
   * turn is ending and idleness is expected.
   */
  onAgentState?: (state: string, info: { stopped: boolean }) => void;
  /** Adapter diagnostics (`agent.*`: pane opened, dialogs answered, start timeouts, …). */
  onEvent?: (event: { type: string; data: Record<string, unknown> }) => void;
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
  /**
   * Ends the session. `force` skips the polite exit (a cancel). `runDir` and `eventsPath` let
   * an adapter that has not seen the session (a server restarted since) still find its pane
   * and save the pane's last screen into the run directory.
   */
  stop(
    session: ImplementerSession,
    opts?: { force?: boolean; runDir?: string; eventsPath?: string },
  ): Promise<void>;
  /**
   * A resume of a pane session whose agent may still be running (the server died, its terminal
   * did not): when the agent is still working in its live pane, waits for that turn to end and
   * returns its outcome, so nothing is sent on top of it. Null when there is no such pane or
   * the agent is not working: the caller then sends as usual (which also uses a live pane).
   */
  reattach?(session: ImplementerSession, input: ImplementerStartInput): Promise<TurnOutcome | null>;
  describe(session: ImplementerSession): string; // e.g. attach command or log path
}
