import { describe, expect, it } from 'vitest';
import type { PlanVersion, RunDecision, RunEvent } from '../types';
import { defaultVersion, lineDiff, plannerAttach, planActions, stageNoteLabel } from './plans';

const plan = (version: number, status: PlanVersion['status']): PlanVersion => ({
  version,
  title: `t${version}`,
  status,
  createdBy: 'agent',
  feedback: null,
  createdAt: '2026-01-01T00:00:00Z',
  text: `v${version}`,
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
  it('handles insertions, removals and empty sides', () => {
    expect(lineDiff('a', 'a\nb').map((l) => l.kind)).toEqual(['same', 'add']);
    expect(lineDiff('a\nb', 'b').map((l) => l.kind)).toEqual(['del', 'same']);
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
  it('shortens the plan-ready note', () => {
    expect(stageNoteLabel('awaiting_plan_approval', 'Plan version 3 ready')).toBe('Plan v3 ready');
  });
  it('leaves other notes alone', () => {
    expect(stageNoteLabel('implementing', 'Plan version 3 ready')).toBe('Plan version 3 ready');
    expect(stageNoteLabel('planning', null)).toBeNull();
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
