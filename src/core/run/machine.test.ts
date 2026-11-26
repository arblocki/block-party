import { describe, expect, it } from 'vitest';
import {
  ACTIVE_STAGES,
  assertTransition,
  canTransition,
  IllegalTransitionError,
  isResting,
  isTerminal,
  RESTING_STAGES,
  RUN_STAGES,
  TERMINAL_STAGES,
  type RunStage,
} from './machine.js';

const FORWARD: [RunStage, RunStage][] = [
  ['setup', 'implementing'],
  ['setup', 'planning'],
  ['planning', 'awaiting_plan_approval'],
  ['awaiting_plan_approval', 'planning'],
  ['awaiting_plan_approval', 'implementing'],
  ['awaiting_plan_approval', 'cancelled'],
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
  ['waiting_ci', 'awaiting_review'],
  ['publishing', 'awaiting_review'],
  ['reviewing', 'awaiting_review'],
  ['awaiting_review', 'fixing'],
  ['awaiting_review', 'complete'],
  ['awaiting_review', 'cancelled'],
  ['awaiting_decision', 'fixing'],
  ['awaiting_decision', 'checking'],
  ['awaiting_decision', 'reviewing'],
  ['awaiting_decision', 'publishing'],
];

const ESCAPES = ['blocked', 'failed', 'cancelled', 'interrupted'] as const;

describe('run stage machine', () => {
  it('lists every stage exactly once, split into active, resting and terminal', () => {
    expect(new Set(RUN_STAGES).size).toBe(RUN_STAGES.length);
    expect([...RUN_STAGES].sort()).toEqual(
      [...ACTIVE_STAGES, ...RESTING_STAGES, ...TERMINAL_STAGES].sort(),
    );
    expect(RESTING_STAGES).toEqual(['awaiting_plan_approval', 'awaiting_review']);
    expect(ACTIVE_STAGES).toContain('planning');
    expect(ACTIVE_STAGES).toContain('awaiting_decision');
    for (const s of RESTING_STAGES) {
      expect(isResting(s)).toBe(true);
      expect(isTerminal(s)).toBe(false);
    }
    for (const s of [...ACTIVE_STAGES, ...TERMINAL_STAGES]) expect(isResting(s)).toBe(false);
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

  it('allows every active stage to ask a decision', () => {
    for (const from of ACTIVE_STAGES) {
      expect(canTransition(from, 'awaiting_decision'), from).toBe(true);
    }
  });

  it('allows self-moves for active stages only', () => {
    for (const s of ACTIVE_STAGES) expect(canTransition(s, s)).toBe(true);
    for (const s of RESTING_STAGES) expect(canTransition(s, s)).toBe(false);
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
          to === 'awaiting_decision' ||
          (ESCAPES as readonly string[]).includes(to);
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }
    for (const from of RESTING_STAGES) {
      for (const to of RUN_STAGES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(allowed.has(`${from}>${to}`));
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
    ['awaiting_plan_approval', 'failed'],
    ['awaiting_review', 'publishing'],
    ['planning', 'implementing'],
    ['awaiting_decision', 'implementing'],
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
