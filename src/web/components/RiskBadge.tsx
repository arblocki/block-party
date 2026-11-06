import { riskBadge, type BadgeTone } from '../lib/groups';
import type { AnalysisGroup } from '../types';

const TONE: Record<BadgeTone, string> = {
  high: 'bg-risk-high text-risk-on',
  medium: 'bg-risk-medium text-risk-on',
  low: 'bg-risk-low text-risk-on',
  auto: 'bg-surface-elevated text-muted',
  unclassified: 'border border-error/40 bg-transparent text-error',
};

export function RiskBadge({
  group,
}: {
  group: Pick<AnalysisGroup, 'risk' | 'autoClear' | 'unclassified'>;
}) {
  const b = riskBadge(group);
  return (
    <span
      className={`inline-block w-11 shrink-0 rounded-md px-1 py-0.5 text-center font-mono text-[10px] leading-none font-bold ${TONE[b.tone]}`}
    >
      {b.label}
    </span>
  );
}
