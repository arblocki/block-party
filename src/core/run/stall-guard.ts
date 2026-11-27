import { existsSync } from 'node:fs';
import type { ImplementerSession, ImplementerStartInput } from '../agents/types.js';
import type { DecisionOption } from '../store/runs.js';
import { attachCommand, type Ctx } from './context.js';
import { createStallWatcher, realStallClock, type StallInfo, type StallWatcher } from './stall.js';

/** The person chose to stop a stalled agent's run. */
export class StallStopError extends Error {
  constructor() {
    super('Stopped by you: the agent went quiet and did not recover');
    this.name = 'StallStopError';
  }
}

/** Where a nudge goes: the planner's turns nudge the planner, everything else the implementer. */
export interface NudgeTarget {
  session: ImplementerSession | undefined;
  start: Omit<ImplementerStartInput, 'prompt'>;
}

export interface StallGuard {
  /** Rejects with `StallStopError` when the person answers `stop`; never resolves. */
  stopped: Promise<never>;
  /** The turn ended: stops the watcher and closes any open stall. */
  end(): void;
}

const DEFAULT_POLL_MS = 1000;

const MINUTE = 60_000;

export const nudgeMessage = (reportPath: string): string =>
  `Status check from block-party: if you're finished, write the report at ${reportPath}. ` +
  `If you're stuck or need a decision, say so in one line and stop.`;

function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function stalledOptions(canNudge: boolean): DecisionOption[] {
  return [
    ...(canNudge ? [{ id: 'nudge', label: 'Nudge again' }] : []),
    { id: 'wait', label: 'Keep waiting' },
    { id: 'stop', label: 'Stop the run → blocked' },
  ];
}

/**
 * Watches one awaited agent turn for silence. A first trigger sends a nudge (pane runs); a
 * further one opens a `stalled` inbox item while the turn keeps running. The answer is read
 * by polling the store, as `awaiting_decision` does, so the run keeps its stage and its slot.
 * Returns undefined when detection is off.
 */
export function startStallGuard(ctx: Ctx, target?: NudgeTarget): StallGuard | undefined {
  const cfg = ctx.input.config.policy;
  if (cfg.stallAfterMinutes <= 0) return undefined;
  const clock = ctx.deps.stallClock ?? realStallClock;
  const pollMs = ctx.deps.stallClock?.answerPollMs ?? DEFAULT_POLL_MS;
  // A running headless process has no terminal to type into, so there is nothing to nudge:
  // silence goes straight to the inbox item.
  const canNudge = ctx.input.config.implementer.mode === 'pane';
  const nudgeTarget = (): NudgeTarget => target ?? { session: ctx.session, start: ctx.start };
  const { rec } = ctx;

  let decisionId: number | null = null;
  let cancelPoll: (() => void) | undefined;
  let ended = false;
  let rejectStopped: (e: Error) => void = () => undefined;
  const stopped = new Promise<never>((_, reject) => {
    rejectStopped = reject;
  });

  const closeDecision = (): void => {
    cancelPoll?.();
    cancelPoll = undefined;
    const id = decisionId;
    decisionId = null;
    if (id === null) return;
    try {
      ctx.deps.store?.resolveDecision(id);
    } catch {
      // A busy store leaves a stale item; the run carries on.
    }
  };

  const sendNudge = (info: StallInfo): void => {
    const { session, start } = nudgeTarget();
    const skip = (why: string): void => {
      watcher.nudgeSkipped();
      rec.event('implementer.nudge_skipped', { reason: info.reason, why });
    };
    if (!session) return skip('no session');
    const message = nudgeMessage(start.reportPath);
    let typed = false;
    const onMessageSent = (): void => {
      typed = true;
      rec.event('implementer.nudged', { reason: info.reason, minutes: info.minutes });
    };
    // The turn already being awaited sees the agent's reply; this send only types the message.
    void Promise.resolve()
      .then(() =>
        ctx.deps.adapter.send(session, { ...start, prompt: message, onMessageSent }, message),
      )
      .then((outcome) => {
        // Settled without the message going in (the agent stayed busy, or it was not submitted).
        if (!typed && !ended) skip(outcome.kind === 'timeout' ? 'busy' : 'not submitted');
      })
      .catch((e: unknown) => {
        if (!typed) watcher.nudgeSkipped();
        rec.event('implementer.nudge_failed', {
          error: e instanceof Error ? e.message : String(e),
        });
      });
  };

  const handleAnswer = (choice: string): void => {
    closeDecision();
    if (choice === 'stop') {
      rec.event('implementer.stall_stopped', {});
      watcher.stop();
      rejectStopped(new StallStopError());
    } else if (choice === 'nudge' && canNudge) {
      watcher.answer('nudge');
    } else {
      rec.event('implementer.stall_waiting', {});
      watcher.answer('wait');
    }
  };

  const poll = (id: number): void => {
    cancelPoll = undefined;
    if (ended || decisionId !== id) return;
    let d;
    try {
      d = ctx.deps.store?.getDecision(id);
    } catch {
      cancelPoll = clock.setTimer(() => poll(id), pollMs);
      return;
    }
    if (d?.answer) handleAnswer(d.answer.choice);
    else if (d && d.status === 'open') cancelPoll = clock.setTimer(() => poll(id), pollMs);
    // Dismissed or resolved elsewhere: nobody is waiting on it any more.
  };

  const onStall = (info: StallInfo): void => {
    const session = nudgeTarget().session;
    const attach = session ? ctx.deps.adapter.describe(session) : attachCommand(ctx);
    const what =
      info.reason === 'idle'
        ? `The agent has been idle for ${info.minutes} min without writing its report.`
        : `The agent has shown no activity for ${info.minutes} min.`;
    const body =
      `${what} Last activity: ${clockTime(info.lastActivityAt)}. ` +
      (canNudge ? 'It was already nudged once. ' : '') +
      'The run is still waiting for it: if it recovers, this item closes by itself.' +
      (attach ? ` Attach: ${attach}` : '');
    rec.event('implementer.stalled', {
      reason: info.reason,
      minutes: info.minutes,
      lastActivityAt: new Date(info.lastActivityAt).toISOString(),
    });
    const id = rec.openDecision(
      'stalled',
      'Agent may be stuck',
      body,
      attach,
      stalledOptions(canNudge),
    );
    if (id === null || !ctx.deps.store) return;
    decisionId = id;
    cancelPoll = clock.setTimer(() => poll(id), pollMs);
  };

  const watcher: StallWatcher = createStallWatcher({
    ...clock,
    now: () => clock.now(),
    setTimer: (fn, ms) => clock.setTimer(fn, ms),
    policy: {
      stallAfterMs: cfg.stallAfterMinutes * MINUTE,
      workingStallAfterMs: cfg.workingStallMinutes * MINUTE,
      idleNudgeMs: cfg.idleNudgeMinutes * MINUTE,
      maxNudges: canNudge ? cfg.maxNudges : 0,
    },
    hasReport: () => existsSync(nudgeTarget().start.reportPath),
    onNudge: sendNudge,
    onStall,
    onResume: () => {
      rec.event('implementer.resumed', { note: 'the agent resumed' });
      closeDecision();
    },
  });
  ctx.stall = watcher;
  // A rejection nobody awaits (the turn ended first) must not surface.
  stopped.catch(() => undefined);

  return {
    stopped,
    end() {
      ended = true;
      watcher.stop();
      closeDecision();
      if (ctx.stall === watcher) ctx.stall = undefined;
    },
  };
}
