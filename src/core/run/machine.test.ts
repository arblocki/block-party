import { describe, expect, it } from 'vitest';
import {
  ACTIVE_STAGES,
  assertTransition,
  canTransition,
  IllegalTransitionError,
  isTerminal,
  RUN_STAGES,
  TERMINAL_STAGES,
  type RunStage,
} from './machine.js';

const FORWARD: [RunStage, RunStage][] = [
  ['setup', 'implementing'],
  ['implementing', 'checking'],
  ['checking', 'reviewing'],
  ['checking', 'fixing'],
  ['fixing', 'checking'],
  ['reviewing', 'fixing'],
  ['reviewing', 'publishing'],
  ['reviewing', 'complete'],
  ['publishing', 'waiting_ci'],
  ['publishing', 'complete'],
  ['waiting_ci', 'complete'],
];

const ESCAPES = ['blocked', 'failed', 'cancelled', 'interrupted'] as const;

describe('run stage machine', () => {
  it('lists every stage exactly once, split into active and terminal', () => {
    expect(new Set(RUN_STAGES).size).toBe(RUN_STAGES.length);
    expect([...RUN_STAGES].sort()).toEqual([...ACTIVE_STAGES, ...TERMINAL_STAGES].sort());
    expect(TERMINAL_STAGES).toEqual(['complete', 'blocked', 'failed', 'cancelled', 'interrupted']);
    for (const s of ACTIVE_STAGES) expect(isTerminal(s)).toBe(false);
    for (const s of TERMINAL_STAGES) expect(isTerminal(s)).toBe(true);
  });

  it.each(FORWARD)('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it('allows every active stage to reach blocked, failed, cancelled and interrupted', () => {
    for (const from of ACTIVE_STAGES) {
      for (const to of ESCAPES) expect(canTransition(from, to), `${from} -> ${to}`).toBe(true);
    }
  });

  it('allows self-moves for active stages only', () => {
    for (const s of ACTIVE_STAGES) expect(canTransition(s, s)).toBe(true);
    for (const s of TERMINAL_STAGES) expect(canTransition(s, s)).toBe(false);
  });

  it('gives terminal stages no outgoing moves', () => {
    for (const from of TERMINAL_STAGES) {
      for (const to of RUN_STAGES) expect(canTransition(from, to), `${from} -> ${to}`).toBe(false);
    }
  });

  it('allows nothing outside the table', () => {
    const allowed = new Set(FORWARD.map(([a, b]) => `${a}>${b}`));
    for (const from of ACTIVE_STAGES) {
      for (const to of RUN_STAGES) {
        const expected =
          from === to ||
          allowed.has(`${from}>${to}`) ||
          (ESCAPES as readonly string[]).includes(to);
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it.each([
    ['setup', 'publishing'],
    ['complete', 'implementing'],
    ['checking', 'complete'],
    ['setup', 'complete'],
    ['implementing', 'reviewing'],
    ['fixing', 'reviewing'],
    ['waiting_ci', 'publishing'],
    ['blocked', 'implementing'],
    ['interrupted', 'implementing'],
    ['cancelled', 'failed'],
  ] as [RunStage, RunStage][])('rejects %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    let err: unknown;
    try {
      assertTransition(from, to);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(IllegalTransitionError);
    expect(err).toMatchObject({ from, to });
    expect((err as Error).message).toContain(from);
    expect((err as Error).message).toContain(to);
  });
});
