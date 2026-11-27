/**
 * Stall detection for one agent turn. No LLM and no I/O: the clock and timers are injected,
 * so tests drive it with a fake clock. The pipeline feeds it activity (hook, stream and
 * transcript events) and the terminal's agent state, and reacts to its two callbacks.
 */

export interface StallPolicy {
  /** Silence (no activity) that counts as a stall, in ms. */
  stallAfterMs: number;
  /** The terminal reports the agent idle, with no report, for this long: nudge. */
  idleNudgeMs: number;
  /** Nudges sent per turn before a stall becomes an inbox item. 0 skips nudging. */
  maxNudges: number;
}

export interface StallClock {
  now(): number;
  /** Runs `fn` after `ms`; returns a function that cancels it. */
  setTimer(fn: () => void, ms: number): () => void;
}

/** `requested`: a human chose "Nudge again". */
export type StallReason = 'silence' | 'idle' | 'requested';

export interface StallInfo {
  reason: StallReason;
  /** Whole minutes of silence (or idleness) behind this trigger. */
  minutes: number;
  /** When the last activity was seen (clock time). */
  lastActivityAt: number;
}

export interface StallWatcherOptions extends StallClock {
  policy: StallPolicy;
  /** The agent's report already exists: an idle agent is then just finishing. */
  hasReport?: () => boolean;
  /** Time to nudge the agent. */
  onNudge(info: StallInfo): void;
  /** Nudges are used up (or off): ask a human. */
  onStall(info: StallInfo): void;
  /** Activity came back after `onStall`. */
  onResume(): void;
}

export interface StallWatcher {
  /** Something happened: resets the silence timer; closes an open stall. */
  activity(): void;
  /**
   * The terminal's view of the agent. `stopped`: a final Stop (empty `background_tasks`) was
   * seen, so the turn is ending and idleness is expected.
   */
  agentState(state: string, opts?: { stopped?: boolean }): void;
  /** The human's answer to the open stall: nudge again, or keep waiting. */
  answer(choice: 'nudge' | 'wait'): void;
  /** Nudges sent so far this turn. */
  readonly nudges: number;
  /** A stall is open (asked about, not yet answered or resumed). */
  readonly stalled: boolean;
  stop(): void;
}

const MINUTE = 60_000;

export function createStallWatcher(opts: StallWatcherOptions): StallWatcher {
  const { policy } = opts;
  let lastActivity = opts.now();
  let nudges = 0;
  let stalled = false;
  let stopped = false;
  let blocked = false;
  let idleSince: number | undefined;
  let cancelSilence: (() => void) | undefined;
  let cancelIdle: (() => void) | undefined;

  const clearSilence = (): void => {
    cancelSilence?.();
    cancelSilence = undefined;
  };
  const clearIdle = (): void => {
    cancelIdle?.();
    cancelIdle = undefined;
  };

  const armSilence = (): void => {
    clearSilence();
    if (stopped || blocked || stalled) return;
    cancelSilence = opts.setTimer(() => {
      cancelSilence = undefined;
      trigger('silence', lastActivity);
    }, policy.stallAfterMs);
  };

  const armIdle = (): void => {
    clearIdle();
    if (stopped || blocked || stalled || idleSince === undefined) return;
    const since = idleSince;
    cancelIdle = opts.setTimer(() => {
      cancelIdle = undefined;
      if (opts.hasReport?.()) return;
      trigger('idle', since);
    }, policy.idleNudgeMs);
  };

  const trigger = (reason: 'silence' | 'idle', since: number): void => {
    if (stopped || stalled) return;
    const info: StallInfo = {
      reason,
      minutes: Math.max(1, Math.round((opts.now() - since) / MINUTE)),
      lastActivityAt: lastActivity,
    };
    if (nudges < policy.maxNudges) {
      nudges += 1;
      // The next trigger is a full period away, whatever the agent does with the nudge.
      if (idleSince !== undefined) idleSince = opts.now();
      armSilence();
      armIdle();
      opts.onNudge(info);
      return;
    }
    stalled = true;
    clearSilence();
    clearIdle();
    opts.onStall(info);
  };

  armSilence();

  return {
    activity() {
      if (stopped) return;
      lastActivity = opts.now();
      blocked = false;
      if (idleSince !== undefined) idleSince = lastActivity;
      if (stalled) {
        stalled = false;
        opts.onResume();
      }
      armSilence();
      armIdle();
    },
    agentState(state, o) {
      if (stopped) return;
      if (state === 'blocked') {
        // Waiting on a human (a permission item is open): not silence.
        blocked = true;
        idleSince = undefined;
        clearSilence();
        clearIdle();
        return;
      }
      if (blocked) {
        blocked = false;
        lastActivity = opts.now();
        armSilence();
      }
      if (state === 'idle' && !o?.stopped) {
        if (idleSince === undefined) {
          idleSince = opts.now();
          armIdle();
        }
      } else if (idleSince !== undefined) {
        idleSince = undefined;
        clearIdle();
      }
    },
    answer(choice) {
      if (stopped || !stalled) return;
      stalled = false;
      lastActivity = opts.now();
      if (idleSince !== undefined) idleSince = lastActivity;
      if (choice === 'nudge') {
        nudges += 1;
        opts.onNudge({ reason: 'requested', minutes: 0, lastActivityAt: lastActivity });
      }
      armSilence();
      armIdle();
    },
    get nudges() {
      return nudges;
    },
    get stalled() {
      return stalled;
    },
    stop() {
      stopped = true;
      clearSilence();
      clearIdle();
    },
  };
}

/** Real clock; timers do not keep the process alive. */
export const realStallClock: StallClock = {
  now: () => Date.now(),
  setTimer(fn, ms) {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return () => clearTimeout(t);
  },
};
