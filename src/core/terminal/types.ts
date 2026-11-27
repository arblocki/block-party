export interface PaneRef {
  session: string;
  label: string;
  cwd: string;
}

export type AgentState = 'idle' | 'working' | 'blocked' | 'unknown';

export interface TerminalHost {
  open(opts: {
    label: string;
    cwd: string;
    argv: string[];
    env?: Record<string, string>;
  }): Promise<PaneRef>;
  sendText(pane: PaneRef, text: string, opts?: { submit?: boolean }): Promise<void>;
  sendKeys(pane: PaneRef, keys: string[]): Promise<void>;
  /** Diagnostics only; never parse this for control flow. */
  read(pane: PaneRef, lines?: number): Promise<string>;
  agentState(pane: PaneRef): Promise<AgentState>;
  isAlive(pane: PaneRef): Promise<boolean>;
  close(pane: PaneRef): Promise<void>;
  attachCommand(pane: PaneRef): string;
  /**
   * The argv (no shell) that attaches a terminal to this one pane, and nothing else in the
   * host. Resolved on the server from the pane's recorded label and cwd, never from client
   * input. Rejects if the pane is gone.
   */
  attachArgv(pane: PaneRef): Promise<string[]>;
  list(): Promise<PaneRef[]>;
}
