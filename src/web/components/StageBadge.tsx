import { stageTone, type StageTone } from '../lib/home';
import type { RunStage } from '../../core/run/machine';

/** Badge colours per tone; shared by the home list and the run view. */
export const stageToneClass: Record<StageTone, string> = {
  active: 'bg-info-soft text-info',
  done: 'bg-success-soft text-success',
  attention: 'bg-error-soft text-error',
  stopped: 'bg-surface-elevated text-muted',
};

export function StageBadge({ stage }: { stage: RunStage }) {
  return (
    <span
      className={`inline-block rounded-md px-1.5 py-0.5 text-xs font-medium ${stageToneClass[stageTone(stage)]}`}
    >
      {stage.replace('_', ' ')}
    </span>
  );
}
