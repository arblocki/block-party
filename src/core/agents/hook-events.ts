import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { z } from 'zod';
import type { AgentState } from '../terminal/types.js';
import type { TurnOutcome } from './types.js';

export const HookEventSchema = z.looseObject({
  hook_event_name: z.string(),
  session_id: z.string().optional(),
  background_tasks: z.array(z.unknown()).optional(),
  agent_type: z.string().optional(),
  agent_id: z.string().optional(),
  transcript_path: z.string().optional(),
  notification_type: z.string().optional(),
  reason: z.string().optional(),
  source: z.string().optional(),
  message: z.string().optional(),
});
export type HookEvent = z.infer<typeof HookEventSchema> & { ts?: string };

export function isFinalStop(ev: HookEvent): boolean {
  return (
    ev.hook_event_name === 'Stop' &&
    (ev.background_tasks === undefined || ev.background_tasks.length === 0)
  );
}

export function isRealSubagentStop(ev: HookEvent): boolean {
  return ev.hook_event_name === 'SubagentStop' && !!ev.agent_type;
}

/**
 * Reads complete lines from `fromOffset` (bytes). A trailing partial line is not consumed.
 * Malformed lines are skipped (but consumed).
 */
export function readHookEvents(
  path: string,
  fromOffset: number,
): { events: HookEvent[]; nextOffset: number } {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { events: [], nextOffset: fromOffset };
  }
  if (size <= fromOffset) return { events: [], nextOffset: fromOffset };
  const buf = Buffer.alloc(size - fromOffset);
  const fd = openSync(path, 'r');
  let read = 0;
  try {
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, fromOffset + read);
      if (n === 0) break;
      read += n;
    }
  } finally {
    closeSync(fd);
  }
  const lastNl = buf.subarray(0, read).lastIndexOf(0x0a);
  if (lastNl === -1) return { events: [], nextOffset: fromOffset };
  const events: HookEvent[] = [];
  for (const line of buf.subarray(0, lastNl).toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = z
        .looseObject({ ts: z.string().optional(), payload: HookEventSchema })
        .parse(JSON.parse(line));
      events.push({ ...row.payload, ...(row.ts ? { ts: row.ts } : {}) });
    } catch {
      // skip malformed line
    }
  }
  return { events, nextOffset: fromOffset + lastNl + 1 };
}

export type HookListener = (ev: HookEvent) => void;

/** Polls an events file and emits typed events appended after `startOffset`. */
export class HookWatcher {
  private offset: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  private listeners = new Set<HookListener>();
  private readonly intervalMs: number;

  constructor(
    private readonly path: string,
    opts: { startOffset?: number; intervalMs?: number } = {},
  ) {
    this.offset = opts.startOffset ?? 0;
    this.intervalMs = opts.intervalMs ?? 250;
  }

  on(listener: HookListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** One poll; also callable directly. */
  poll(): void {
    const { events, nextOffset } = readHookEvents(this.path, this.offset);
    this.offset = nextOffset;
    for (const ev of events) for (const l of [...this.listeners]) l(ev);
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

export interface WaitForTurnEndOptions {
  watcher: HookWatcher;
  sessionId: string;
  reportPath: string;
  /**
   * Current terminal agent state. Polled at most once per tick with no overlapping calls;
   * a rejection counts as 'unknown'.
   */
  agentState?: () => Promise<AgentState | undefined>;
  settleMs?: number;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Re-check cadence for settle and blocked-state polling. */
  pollMs?: number;
}

const BLOCKED_MS = 3000;

/**
 * Resolves with the first turn-ending condition. Only events the watcher emits while this
 * call is pending count, so create the watcher with the offset taken before the turn began.
 * Starts the watcher and stops it when the turn ends.
 */
export function waitForTurnEnd(opts: WaitForTurnEndOptions): Promise<TurnOutcome> {
  const { watcher, sessionId, reportPath } = opts;
  const settleMs = opts.settleMs ?? 1500;
  const pollMs = opts.pollMs ?? 250;
  return new Promise<TurnOutcome>((resolve) => {
    let finalStopAt: number | undefined;
    let blockedSince: number | undefined;
    let done = false;

    const finish = (outcome: TurnOutcome): void => {
      if (done) return;
      done = true;
      unsubscribe();
      clearInterval(tick);
      clearTimeout(timeout);
      opts.signal?.removeEventListener('abort', onAbort);
      watcher.stop();
      resolve(outcome);
    };
    const onAbort = (): void => finish({ kind: 'exited', reason: 'aborted' });

    const unsubscribe = watcher.on((ev) => {
      if (ev.session_id !== sessionId) return;
      if (ev.hook_event_name === 'SessionEnd') {
        finish({ kind: 'exited', reason: ev.reason ?? 'session_end' });
      } else if (
        ev.hook_event_name === 'Notification' &&
        ev.notification_type === 'permission_prompt'
      ) {
        finish({ kind: 'permission', message: ev.message ?? 'permission prompt' });
      } else if (isFinalStop(ev)) {
        finalStopAt = Date.now();
      } else if (ev.hook_event_name === 'UserPromptSubmit') {
        finalStopAt = undefined;
      }
    });

    let inFlight = false;
    const tick = setInterval(() => {
      if (inFlight || done) return;
      inFlight = true;
      const getState = opts.agentState
        ? opts.agentState().catch((): AgentState => 'unknown')
        : Promise.resolve<AgentState | undefined>(undefined);
      void getState.then((state) => {
        inFlight = false;
        if (done) return;
        if (state === 'blocked') {
          blockedSince ??= Date.now();
          if (Date.now() - blockedSince > BLOCKED_MS) {
            finish({ kind: 'permission', message: 'agent is blocked awaiting input' });
            return;
          }
        } else {
          blockedSince = undefined;
        }
        if (finalStopAt !== undefined && Date.now() - finalStopAt >= settleMs) {
          if (existsSync(reportPath)) finish({ kind: 'report' });
          else if (state !== 'working') {
            finish({ kind: 'no_report', detail: 'turn ended without report.json' });
          }
        }
      });
    }, pollMs);

    const timeout = setTimeout(() => finish({ kind: 'timeout' }), opts.timeoutMs);
    if (opts.signal?.aborted) {
      onAbort();
      return;
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    watcher.start();
  });
}
