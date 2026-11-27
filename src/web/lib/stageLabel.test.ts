import { describe, expect, it } from 'vitest';
import { RUN_STAGES } from '../../core/run/machine';
import { stageLabel } from './stageLabel';

describe('stageLabel', () => {
  it.each(RUN_STAGES)('gives %s a plain label with no underscores', (stage) => {
    const label = stageLabel(stage);
    expect(label).not.toBe('');
    expect(label).not.toMatch(/_/);
    expect(label).not.toBe(stage);
  });

  it('uses the wording the brief names', () => {
    expect(stageLabel('awaiting_plan_approval')).toBe('Plan ready for you');
    expect(stageLabel('awaiting_review')).toBe('Ready for your review');
    expect(stageLabel('awaiting_decision')).toBe('Needs your answer');
    expect(stageLabel('waiting_ci')).toBe('Waiting for GitHub CI');
    expect(stageLabel('interrupted')).toBe('Interrupted');
    expect(stageLabel('blocked')).toBe('Stuck — needs you');
  });
});
