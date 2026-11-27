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
   * The argv (no shell) that attaches a terminal to the pane's host session. Built only from
   * the pane's own session name, never from client input.
   */
  attachArgv(pane: PaneRef): string[];
  list(): Promise<PaneRef[]>;
}
