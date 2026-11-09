import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HookWatcher,
  isFinalStop,
  isRealSubagentStop,
  readHookEvents,
  waitForTurnEnd,
  type HookEvent,
} from './hook-events.js';

let dir: string;
let eventsPath: string;
let reportPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bp-events-'));
  eventsPath = join(dir, 'events.jsonl');
  reportPath = join(dir, 'report.json');
});

const line = (payload: Record<string, unknown>) =>
  JSON.stringify({ ts: '2026-01-01T00:00:00Z', payload }) + '\n';
const add = (payload: Record<string, unknown>) => appendFileSync(eventsPath, line(payload));

describe('readHookEvents', () => {
  it('does not consume a partial last line', () => {
    const full = line({ hook_event_name: 'Stop', session_id: 's' });
    writeFileSync(eventsPath, full + full.slice(0, 10));
    const first = readHookEvents(eventsPath, 0);
    expect(first.events).toHaveLength(1);
    expect(first.nextOffset).toBe(Buffer.byteLength(full));
    appendFileSync(eventsPath, full.slice(10));
    const second = readHookEvents(eventsPath, first.nextOffset);
    expect(second.events).toHaveLength(1);
    expect(second.events[0]?.hook_event_name).toBe('Stop');
  });

  it('skips malformed lines and tolerates a missing file', () => {
    expect(readHookEvents(eventsPath, 0)).toEqual({ events: [], nextOffset: 0 });
    writeFileSync(eventsPath, 'garbage\n' + line({ hook_event_name: 'Stop' }));
    expect(readHookEvents(eventsPath, 0).events).toHaveLength(1);
  });
});

describe('predicates', () => {
  it('classifies stops', () => {
    const ev = (e: Partial<HookEvent>) => ({ hook_event_name: 'Stop', ...e }) as HookEvent;
    expect(isFinalStop(ev({}))).toBe(true);
    expect(isFinalStop(ev({ background_tasks: [] }))).toBe(true);
    expect(isFinalStop(ev({ background_tasks: [{ id: 'a' }] }))).toBe(false);
    expect(isFinalStop(ev({ hook_event_name: 'SubagentStop' }))).toBe(false);
    const sub = (agent_type?: string) =>
      ({ hook_event_name: 'SubagentStop', agent_type }) as HookEvent;
    expect(isRealSubagentStop(sub('helper'))).toBe(true);
    expect(isRealSubagentStop(sub(''))).toBe(false);
    expect(isRealSubagentStop(sub())).toBe(false);
  });
});

describe('waitForTurnEnd', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const start = (extra: Partial<Parameters<typeof waitForTurnEnd>[0]> = {}) =>
    waitForTurnEnd({
      watcher: new HookWatcher(eventsPath),
      sessionId: 's1',
      reportPath,
      settleMs: 1000,
      timeoutMs: 60_000,
      ...extra,
    });

  it('ignores a Stop with background tasks; the second Stop resolves report', async () => {
    const p = start();
    add({ hook_event_name: 'Stop', session_id: 's1', background_tasks: [{ id: 'a' }] });
    await vi.advanceTimersByTimeAsync(3000);
    writeFileSync(reportPath, '{}');
    add({ hook_event_name: 'Stop', session_id: 's1', background_tasks: [] });
    await vi.advanceTimersByTimeAsync(2000);
    expect(await p).toEqual({ kind: 'report' });
  });

  it('first Stop with tasks and report present does not resolve', async () => {
    writeFileSync(reportPath, '{}');
    let settled = false;
    const p = start().then((o) => ((settled = true), o));
    add({ hook_event_name: 'Stop', session_id: 's1', background_tasks: [{ id: 'a' }] });
    await vi.advanceTimersByTimeAsync(5000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await p).toEqual({ kind: 'timeout' });
  });

  it('resolves no_report unless the agent is still working', async () => {
    let state = 'working';
    const p = start({ agentState: () => Promise.resolve(state as 'working' | 'idle') });
    add({ hook_event_name: 'Stop', session_id: 's1' });
    await vi.advanceTimersByTimeAsync(3000);
    state = 'idle';
    await vi.advanceTimersByTimeAsync(500);
    expect((await p).kind).toBe('no_report');
  });

  it('resolves permission from a Notification', async () => {
    const p = start();
    add({
      hook_event_name: 'Notification',
      session_id: 's1',
      notification_type: 'permission_prompt',
      message: 'Claude needs permission to use Bash',
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(await p).toEqual({ kind: 'permission', message: 'Claude needs permission to use Bash' });
  });

  it('resolves permission when blocked for more than 3 seconds', async () => {
    const p = start({ agentState: () => Promise.resolve('blocked' as const) });
    await vi.advanceTimersByTimeAsync(2500);
    await vi.advanceTimersByTimeAsync(1500);
    expect((await p).kind).toBe('permission');
  });

  it('resolves exited on SessionEnd', async () => {
    const p = start();
    add({ hook_event_name: 'SessionEnd', session_id: 's1', reason: 'logout' });
    await vi.advanceTimersByTimeAsync(300);
    expect(await p).toEqual({ kind: 'exited', reason: 'logout' });
  });

  it('ignores other sessions', async () => {
    const p = start({ timeoutMs: 5000 });
    add({ hook_event_name: 'SessionEnd', session_id: 'other' });
    add({
      hook_event_name: 'Notification',
      session_id: 'other',
      notification_type: 'permission_prompt',
    });
    add({ hook_event_name: 'Stop', session_id: 'other' });
    writeFileSync(reportPath, '{}');
    await vi.advanceTimersByTimeAsync(6000);
    expect(await p).toEqual({ kind: 'timeout' });
  });

  it('only counts events after the starting offset', async () => {
    add({ hook_event_name: 'SessionEnd', session_id: 's1' });
    const offset = readHookEvents(eventsPath, 0).nextOffset;
    const p = start({
      watcher: new HookWatcher(eventsPath, { startOffset: offset }),
      timeoutMs: 3000,
    });
    await vi.advanceTimersByTimeAsync(4000);
    expect(await p).toEqual({ kind: 'timeout' });
  });

  it('does not start the watcher for a pre-aborted signal', async () => {
    const watcher = new HookWatcher(eventsPath);
    const out = await start({ watcher, signal: AbortSignal.abort() });
    expect(out).toEqual({ kind: 'exited', reason: 'aborted' });
    expect(watcher.running).toBe(false);
  });

  it('treats a rejected agentState as unknown and never overlaps calls', async () => {
    let calls = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const p = start({
      agentState: async () => {
        calls++;
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        await new Promise((r) => setTimeout(r, 600));
        inFlight--;
        throw new Error('boom');
      },
    });
    add({ hook_event_name: 'Stop', session_id: 's1' });
    await vi.advanceTimersByTimeAsync(5000);
    expect((await p).kind).toBe('no_report');
    expect(maxInFlight).toBe(1);
    expect(calls).toBeGreaterThan(0);
  });

  it('resolves report even when agentState never resolves', async () => {
    writeFileSync(reportPath, '{}');
    const p = start({ agentState: () => new Promise<never>(() => undefined) });
    add({ hook_event_name: 'Stop', session_id: 's1' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(await p).toEqual({ kind: 'report' });
  });

  it('does not emit no_report while the last resolved state is working', async () => {
    let calls = 0;
    const p = start({
      timeoutMs: 10_000,
      agentState: () =>
        calls++ === 0 ? Promise.resolve('working' as const) : new Promise<never>(() => undefined),
    });
    add({ hook_event_name: 'Stop', session_id: 's1' });
    await vi.advanceTimersByTimeAsync(11_000);
    expect(await p).toEqual({ kind: 'timeout' });
  });

  it('does not emit no_report when the first state query resolves working after settle', async () => {
    let resolveFirst: (s: 'working') => void = () => undefined;
    let calls = 0;
    const p = start({
      timeoutMs: 20_000,
      agentState: () =>
        calls++ === 0
          ? new Promise<'working'>((r) => (resolveFirst = r))
          : Promise.resolve('working' as const),
    });
    add({ hook_event_name: 'Stop', session_id: 's1' });
    await vi.advanceTimersByTimeAsync(3000);
    resolveFirst('working');
    await vi.advanceTimersByTimeAsync(21_000);
    expect(await p).toEqual({ kind: 'timeout' });
  });

  it('emits no_report once a post-Stop query resolves idle', async () => {
    const p = start({ agentState: () => Promise.resolve('idle' as const) });
    add({ hook_event_name: 'Stop', session_id: 's1' });
    await vi.advanceTimersByTimeAsync(3000);
    expect((await p).kind).toBe('no_report');
  });

  it('emits no_report without agentState', async () => {
    const p = start();
    add({ hook_event_name: 'Stop', session_id: 's1' });
    await vi.advanceTimersByTimeAsync(3000);
    expect((await p).kind).toBe('no_report');
  });

  it('treats a post-Stop query resolving undefined as unknown and emits no_report', async () => {
    const p = start({ timeoutMs: 20_000, agentState: () => Promise.resolve(undefined) });
    add({ hook_event_name: 'Stop', session_id: 's1' });
    await vi.advanceTimersByTimeAsync(3000);
    expect((await p).kind).toBe('no_report');
  });

  it('ignores a query issued before the Stop even if it resolves idle after settle', async () => {
    let resolveFirst: (s: 'idle') => void = () => undefined;
    let calls = 0;
    const p = start({
      timeoutMs: 10_000,
      agentState: () =>
        calls++ === 0
          ? new Promise<'idle'>((r) => (resolveFirst = r))
          : new Promise<never>(() => undefined),
    });
    add({ hook_event_name: 'Stop', session_id: 's1' });
    await vi.advanceTimersByTimeAsync(3000);
    resolveFirst('idle');
    await vi.advanceTimersByTimeAsync(11_000);
    expect(await p).toEqual({ kind: 'timeout' });
  });

  it('ignores a query issued before a UserPromptSubmit reset', async () => {
    let resolveSecond: (s: 'idle') => void = () => undefined;
    let calls = 0;
    const p = start({
      timeoutMs: 10_000,
      agentState: () => {
        calls++;
        if (calls === 1) return Promise.resolve('working' as const);
        if (calls === 2) return new Promise<'idle'>((r) => (resolveSecond = r));
        return new Promise<never>(() => undefined);
      },
    });
    add({ hook_event_name: 'Stop', session_id: 's1' });
    await vi.advanceTimersByTimeAsync(300); // call 1 (pre-Stop) at 250; Stop seen at 250
    await vi.advanceTimersByTimeAsync(250); // call 2 issued after the Stop
    expect(calls).toBe(2);
    add({ hook_event_name: 'UserPromptSubmit', session_id: 's1' });
    await vi.advanceTimersByTimeAsync(300);
    add({ hook_event_name: 'Stop', session_id: 's1' });
    await vi.advanceTimersByTimeAsync(300);
    resolveSecond('idle');
    await vi.advanceTimersByTimeAsync(11_000);
    expect(await p).toEqual({ kind: 'timeout' });
  });

  it('does not emit permission when blocked clears within 3 seconds', async () => {
    let state: 'blocked' | 'idle' = 'blocked';
    const p = start({ timeoutMs: 8000, agentState: () => Promise.resolve(state) });
    await vi.advanceTimersByTimeAsync(2500);
    state = 'idle';
    await vi.advanceTimersByTimeAsync(6000);
    expect(await p).toEqual({ kind: 'timeout' });
  });

  it('resolves exited on abort', async () => {
    const ac = new AbortController();
    const p = start({ signal: ac.signal });
    ac.abort();
    expect(await p).toEqual({ kind: 'exited', reason: 'aborted' });
  });
});
