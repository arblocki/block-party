import { describe, expect, it } from 'vitest';
import type { PlanVersion, RunDecision, RunEvent, RunSummary } from '../types';
import { defaultVersion, lineDiff, plannerAttach, planActions, stageNoteLabel } from './plans';

const plan = (version: number, status: PlanVersion['status']): PlanVersion => ({
  version,
  title: `t${version}`,
  status,
  createdBy: 'agent',
  feedback: null,
  createdAt: '2026-01-01T00:00:00Z',
  text: `v${version}`,
  acceptanceCriteria: [],
});

const decision = (over: Partial<RunDecision> = {}): RunDecision => ({
  id: 1,
  runId: 'r',
  kind: 'plan_approval',
  status: 'open',
  title: 't',
  body: '',
  attach: null,
  createdAt: '2026-01-01T00:00:00Z',
  resolvedAt: null,
  options: [
    { id: 'approve', label: 'Approve' },
    { id: 'revise', label: 'Request changes' },
  ],
  answer: null,
  answeredAt: null,
  ...over,
});

describe('lineDiff', () => {
  it('marks identical text as unchanged', () => {
    expect(lineDiff('a\nb', 'a\nb')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'same', text: 'b' },
    ]);
  });
  it('shows a revised line as a deletion and an addition', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'B' },
      { kind: 'same', text: 'c' },
    ]);
  });
  it('trims the common prefix and suffix', () => {
    const many = Array.from({ length: 5000 }, (_, i) => `l${i}`);
    const changed = [...many.slice(0, 2500), 'X', ...many.slice(2501)];
    const d = lineDiff(many.join('\n'), changed.join('\n'))!;
    expect(d).toHaveLength(5001);
    expect(d.filter((l) => l.kind !== 'same')).toEqual([
      { kind: 'del', text: 'l2500' },
      { kind: 'add', text: 'X' },
    ]);
  });
  it('gives up when the changed middle is too large', () => {
    const a = Array.from({ length: 2500 }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: 2500 }, (_, i) => `b${i}`).join('\n');
    expect(lineDiff(a, b)).toBeNull();
  });
  it('handles insertions, removals and empty sides', () => {
    expect(lineDiff('a', 'a\nb')!.map((l) => l.kind)).toEqual(['same', 'add']);
    expect(lineDiff('a\nb', 'b')!.map((l) => l.kind)).toEqual(['del', 'same']);
    expect(lineDiff('', 'x')).toEqual([{ kind: 'add', text: 'x' }]);
    expect(lineDiff('x', '')).toEqual([{ kind: 'del', text: 'x' }]);
  });
});

describe('defaultVersion', () => {
  it('is null with no versions', () => {
    expect(defaultVersion([])).toBeNull();
  });
  it('is the only version of a single-version run', () => {
    expect(defaultVersion([plan(1, 'draft')])).toBe(1);
  });
  it('is the latest of a revised plan', () => {
    expect(defaultVersion([plan(1, 'draft'), plan(2, 'draft')])).toBe(2);
  });
  it('prefers the approved version, even when it is older', () => {
    expect(defaultVersion([plan(1, 'approved'), plan(2, 'superseded')])).toBe(1);
  });
});

describe('planActions', () => {
  it('returns the open plan_approval decision while awaiting approval', () => {
    const d = decision();
    expect(planActions({ stage: 'awaiting_plan_approval' }, [d])).toBe(d);
  });
  it('is null with no open decision', () => {
    expect(planActions({ stage: 'awaiting_plan_approval' }, [])).toBeNull();
    expect(
      planActions({ stage: 'awaiting_plan_approval' }, [decision({ status: 'answered' })]),
    ).toBeNull();
    expect(
      planActions({ stage: 'awaiting_plan_approval' }, [decision({ kind: 'blocked' })]),
    ).toBeNull();
  });
  it('is null once the run left the approval stage', () => {
    expect(planActions({ stage: 'implementing' }, [decision()])).toBeNull();
    expect(planActions({ stage: 'planning' }, [decision()])).toBeNull();
  });
});

describe('stageNoteLabel', () => {
  const r = (stage: RunSummary['stage'], stageNote: string | null, planVersion: number | null) => ({
    stage,
    stageNote,
    planVersion,
  });
  it('builds the plan-ready label from the plan version, not the note', () => {
    expect(stageNoteLabel(r('awaiting_plan_approval', 'whatever', 3))).toBe('Plan v3 ready');
  });
  it('says why a queued run is waiting, with the slots in use', () => {
    const queued = (queue: RunSummary['queue']) => ({
      ...r('queued', 'Waiting for a free slot', null),
      queue,
    });
    expect(stageNoteLabel(queued({ position: 2, inUse: 2, max: 3, perProjectMax: null }))).toBe(
      'Waiting for a free slot (2 of 3 in use)',
    );
    expect(
      stageNoteLabel(queued({ position: 1, inUse: null, max: null, perProjectMax: null })),
    ).toBe('Waiting for a free slot');
    expect(stageNoteLabel(queued(null))).toBe('Waiting for a free slot');
    // Held back by its own repository while the machine has room: no contradictory count.
    expect(stageNoteLabel(queued({ position: 1, inUse: 1, max: 3, perProjectMax: 2 }))).toBe(
      'Only 2 runs of the same repository go at once.',
    );
    expect(stageNoteLabel(queued({ position: 1, inUse: 1, max: 3, perProjectMax: 1 }))).toBe(
      'Only 1 run of the same repository goes at once.',
    );
  });
  it('leaves other notes alone', () => {
    expect(stageNoteLabel(r('implementing', 'Plan version 3 ready', 3))).toBe(
      'Plan version 3 ready',
    );
    expect(stageNoteLabel(r('awaiting_plan_approval', 'n', null))).toBe('n');
    expect(stageNoteLabel(r('planning', null, null))).toBeNull();
  });
  it('drops a note that is empty or only repeats the stage', () => {
    expect(stageNoteLabel(r('cancelled', 'cancelled', null))).toBeNull();
    expect(stageNoteLabel(r('cancelled', 'Cancelled', null))).toBeNull();
    expect(stageNoteLabel(r('waiting_ci', 'waiting ci', null))).toBeNull();
    expect(stageNoteLabel(r('failed', '  ', null))).toBeNull();
    expect(stageNoteLabel(r('cancelled', 'Cancelled by you', null))).toBe('Cancelled by you');
  });
});

describe('plannerAttach', () => {
  const ev = (type: string, attach: unknown): RunEvent => ({
    id: 1,
    runId: 'r',
    stageId: null,
    ts: '',
    type,
    payload: { attach },
  });
  it('takes the latest planner session and ignores implementer ones', () => {
    expect(
      plannerAttach([
        ev('planner.session', 'a'),
        ev('implementer.session', 'x'),
        ev('planner.session', 'b'),
      ]),
    ).toBe('b');
    expect(plannerAttach([ev('implementer.session', 'x')])).toBeNull();
  });
});
