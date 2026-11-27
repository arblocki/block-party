import { describe, expect, it } from 'vitest';
import {
  ACTIVE_STAGES,
  assertTransition,
  canResume,
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
  // A queued run leaves for any stage work starts in, or is cancelled; an answer with no free
  // slot moves a resting run into the queue.
  ['awaiting_plan_approval', 'queued'],
  ['awaiting_review', 'queued'],
  ['queued', 'setup'],
  ['queued', 'planning'],
  ['queued', 'implementing'],
  ['queued', 'fixing'],
  ['queued', 'checking'],
  ['queued', 'reviewing'],
  ['queued', 'publishing'],
  ['queued', 'waiting_ci'],
  ['queued', 'cancelled'],
  ['implementing', 'checking'],
  ['checking', 'reviewing'],
  ['checking', 'fixing'],
  ['fixing', 'checking'],
  ['reviewing', 'fixing'],
  ['reviewing', 'publishing'],
  ['reviewing', 'complete'],
  ['publishing', 'waiting_ci'],
  ['publishing', 'complete'],
  ['waiting_ci', 'fixing'],
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
    expect(RESTING_STAGES).toEqual(['awaiting_plan_approval', 'awaiting_review', 'queued']);
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

  describe('queued', () => {
    it('is a resting stage nobody owns, and it cannot be re-queued or finished directly', () => {
      expect(isResting('queued')).toBe(true);
      for (const to of ['queued', 'complete', 'awaiting_review', 'blocked', 'failed'] as const) {
        expect(canTransition('queued', to), `queued -> ${to}`).toBe(false);
      }
    });

    it('is entered from rest and from a stopped run only (never from active work)', () => {
      for (const from of ACTIVE_STAGES) expect(canTransition(from, 'queued')).toBe(false);
      expect(canTransition('awaiting_review', 'queued')).toBe(true);
      expect(canTransition('interrupted', 'queued')).toBe(false);
      expect(canTransition('interrupted', 'queued', { resume: true })).toBe(true);
      expect(canTransition('failed', 'queued', { resume: true })).toBe(false);
    });
  });

  describe('resume', () => {
    const TARGETS = [
      'queued',
      'setup',
      'planning',
      'implementing',
      'checking',
      'reviewing',
      'fixing',
      'publishing',
      'waiting_ci',
    ] as const;

    it('is possible only from interrupted and blocked', () => {
      for (const s of RUN_STAGES) {
        expect(canResume(s), s).toBe(s === 'interrupted' || s === 'blocked');
      }
      for (const s of ['failed', 'cancelled', 'complete'] as const)
        expect(canResume(s)).toBe(false);
    });

    it.each(['interrupted', 'blocked'] as const)(
      'lets %s resume into each active stage',
      (from) => {
        for (const to of TARGETS) {
          expect(canTransition(from, to, { resume: true }), `${from} -> ${to}`).toBe(true);
          expect(() => assertTransition(from, to, { resume: true })).not.toThrow();
        }
      },
    );

    it('allows resume moves into the listed stages and nothing else', () => {
      for (const from of ['interrupted', 'blocked'] as const) {
        for (const to of RUN_STAGES) {
          expect(canTransition(from, to, { resume: true }), `${from} -> ${to}`).toBe(
            (TARGETS as readonly string[]).includes(to),
          );
        }
      }
    });

    it('never resumes failed, cancelled or complete', () => {
      for (const from of ['failed', 'cancelled', 'complete'] as const) {
        for (const to of RUN_STAGES) {
          expect(canTransition(from, to, { resume: true }), `${from} -> ${to}`).toBe(false);
        }
      }
    });

    it('keeps ordinary moves out of interrupted and blocked illegal', () => {
      for (const from of ['interrupted', 'blocked'] as const) {
        for (const to of TARGETS) expect(canTransition(from, to), `${from} -> ${to}`).toBe(false);
      }
    });

    it('does not let a resume move leave an active or resting stage', () => {
      for (const from of [...ACTIVE_STAGES, ...RESTING_STAGES]) {
        for (const to of RUN_STAGES) {
          expect(canTransition(from, to, { resume: true }), `${from} -> ${to}`).toBe(false);
        }
      }
    });
  });
  describe('cancel of a stopped run', () => {
    it('moves only interrupted and blocked to cancelled', () => {
      for (const from of RUN_STAGES) {
        for (const to of RUN_STAGES) {
          expect(canTransition(from, to, { cancel: true }), `${from} -> ${to}`).toBe(
            (from === 'interrupted' || from === 'blocked') && to === 'cancelled',
          );
        }
      }
    });

    it('is not an ordinary move', () => {
      expect(canTransition('interrupted', 'cancelled')).toBe(false);
      expect(canTransition('blocked', 'cancelled')).toBe(false);
      expect(() => assertTransition('blocked', 'cancelled', { cancel: true })).not.toThrow();
    });
  });
});
