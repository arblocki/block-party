import { describe, expect, it } from 'vitest';
import { createStallWatcher, type StallInfo, type StallPolicy } from './stall.js';

const MIN = 60_000;

function fakeClock() {
  let t = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimer(fn: () => void, ms: number) {
      const id = ++seq;
      timers.set(id, { at: t + ms, fn });
      return () => void timers.delete(id);
    },
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        timers.delete(next[0]);
        t = Math.max(t, next[1].at);
        next[1].fn();
      }
      t = end;
    },
  };
}

const POLICY: StallPolicy = { stallAfterMs: 10 * MIN, idleNudgeMs: 3 * MIN, maxNudges: 1 };

function setup(policy: Partial<StallPolicy> = {}, hasReport?: () => boolean) {
  const clock = fakeClock();
  const log: string[] = [];
  const infos: StallInfo[] = [];
  const w = createStallWatcher({
    ...clock,
    policy: { ...POLICY, ...policy },
    ...(hasReport ? { hasReport } : {}),
    onNudge: (i) => (log.push('nudge'), infos.push(i)),
    onStall: (i) => (log.push('stall'), infos.push(i)),
    onResume: () => log.push('resume'),
  });
  return { clock, w, log, infos };
}

describe('createStallWatcher', () => {
  it('nudges once after silence, then raises a stall on more silence', () => {
    const { clock, log, infos } = setup();
    clock.advance(9 * MIN);
    expect(log).toEqual([]);
    clock.advance(1 * MIN);
    expect(log).toEqual(['nudge']);
    expect(infos[0]).toMatchObject({ reason: 'silence', minutes: 10 });
    clock.advance(10 * MIN);
    expect(log).toEqual(['nudge', 'stall']);
    clock.advance(60 * MIN);
    expect(log).toEqual(['nudge', 'stall']);
  });

  it('activity resets the silence timer', () => {
    const { clock, w, log } = setup();
    clock.advance(9 * MIN);
    w.activity();
    clock.advance(9 * MIN);
    expect(log).toEqual([]);
    clock.advance(1 * MIN);
    expect(log).toEqual(['nudge']);
  });

  it('activity closes an open stall', () => {
    const { clock, w, log } = setup();
    clock.advance(20 * MIN);
    expect(w.stalled).toBe(true);
    w.activity();
    expect(log).toEqual(['nudge', 'stall', 'resume']);
    expect(w.stalled).toBe(false);
    // Silence again: nudges are used up, so the next trigger is a stall.
    clock.advance(10 * MIN);
    expect(log).toEqual(['nudge', 'stall', 'resume', 'stall']);
  });

  it('goes straight to a stall when maxNudges is 0', () => {
    const { clock, log } = setup({ maxNudges: 0 });
    clock.advance(10 * MIN);
    expect(log).toEqual(['stall']);
  });

  it('nudges when the terminal says idle with no report', () => {
    const { clock, w, log, infos } = setup();
    w.agentState('idle', { stopped: false });
    clock.advance(3 * MIN);
    expect(log).toEqual(['nudge']);
    expect(infos[0]).toMatchObject({ reason: 'idle', minutes: 3 });
  });

  it('does not nudge an idle agent that wrote its report, or one that has stopped', () => {
    const a = setup({}, () => true);
    a.w.agentState('idle');
    a.clock.advance(3 * MIN);
    expect(a.log).toEqual([]);
    const b = setup();
    b.w.agentState('idle', { stopped: true });
    b.clock.advance(3 * MIN);
    expect(b.log).toEqual([]);
  });

  it('a working state cancels the idle timer', () => {
    const { clock, w, log } = setup();
    w.agentState('idle');
    clock.advance(2 * MIN);
    w.agentState('working');
    clock.advance(5 * MIN);
    expect(log).toEqual([]);
  });

  it('does not count time spent blocked on a human as silence', () => {
    const { clock, w, log } = setup();
    w.agentState('blocked');
    clock.advance(60 * MIN);
    expect(log).toEqual([]);
    w.agentState('working');
    clock.advance(10 * MIN);
    expect(log).toEqual(['nudge']);
  });

  it('answer wait keeps waiting and asks again after another silence', () => {
    const { clock, w, log } = setup();
    clock.advance(20 * MIN);
    w.answer('wait');
    clock.advance(9 * MIN);
    expect(log).toEqual(['nudge', 'stall']);
    clock.advance(1 * MIN);
    expect(log).toEqual(['nudge', 'stall', 'stall']);
  });

  it('answer nudge sends another nudge', () => {
    const { clock, w, log, infos } = setup();
    clock.advance(20 * MIN);
    w.answer('nudge');
    expect(log).toEqual(['nudge', 'stall', 'nudge']);
    expect(infos[2]!.reason).toBe('requested');
    expect(w.nudges).toBe(2);
  });

  it('stop clears every timer', () => {
    const { clock, w, log } = setup();
    w.agentState('idle');
    w.stop();
    clock.advance(60 * MIN);
    expect(log).toEqual([]);
  });

  it('allows a longer silence while the terminal says working', () => {
    const { clock, w, log } = setup({ workingStallAfterMs: 30 * MIN });
    w.agentState('working');
    clock.advance(29 * MIN);
    expect(log).toEqual([]);
    clock.advance(1 * MIN);
    expect(log).toEqual(['nudge']);
  });

  it('uses the short limit for idle and unknown states, even after working', () => {
    const { clock, w, log } = setup({ workingStallAfterMs: 30 * MIN });
    w.agentState('working');
    clock.advance(8 * MIN);
    w.agentState('unknown');
    clock.advance(2 * MIN);
    expect(log).toEqual(['nudge']);
  });

  it('a skipped nudge is not counted', () => {
    const { clock, w, log } = setup();
    clock.advance(10 * MIN);
    w.nudgeSkipped();
    expect(w.nudges).toBe(0);
    clock.advance(10 * MIN);
    expect(log).toEqual(['nudge', 'nudge']);
  });
});
