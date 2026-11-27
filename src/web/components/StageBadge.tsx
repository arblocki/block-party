import { stageTone, type StageTone } from '../lib/home';
import { stageLabel } from '../lib/stageLabel';
import type { RunStage } from '../../core/run/machine';

/** Badge colours per tone; shared by the home list and the run view. */
export const stageToneClass: Record<StageTone, string> = {
  active: 'bg-info-soft text-info',
  waiting: 'bg-warning-soft text-warning ring-1 ring-inset ring-warning/40',
  done: 'bg-success-soft text-success',
  attention: 'bg-error-soft text-error',
  stopped: 'bg-surface-elevated text-muted',
};

export function StageBadge({ stage }: { stage: RunStage }) {
  return (
    <span
      className={`inline-block rounded-md px-1.5 py-0.5 text-xs font-medium ${stageToneClass[stageTone(stage)]}`}
    >
      {stageLabel(stage)}
    </span>
  );
}
