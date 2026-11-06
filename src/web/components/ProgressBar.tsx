import { useMemo } from 'react';
import { progressFor } from '../lib/progress';
import { useReviewState } from '../reviewState';

/** Overall progress: share of the PR's hunks and hunkless files that are reviewed or auto-cleared. */
export function ProgressBar() {
  const { knownItemIds, status, analysisStale } = useReviewState();
  const p = useMemo(() => progressFor(knownItemIds, status), [knownItemIds, status]);
  const hasFiles = [...knownItemIds].some((id) => id.startsWith('file:'));
  return (
    <div
      className="mt-2 border-t border-line px-3 pt-2 pb-3 text-xs"
      data-testid="overall-progress"
    >
      <div className="mb-1 flex items-baseline justify-between">
        <span className="font-semibold tracking-wide text-muted uppercase">Progress</span>
        <span className="font-mono">{p.pct}%</span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-md bg-surface-elevated"
        role="progressbar"
        aria-valuenow={p.pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Review progress"
      >
        <div className="flex h-full">
          <div
            className="bg-success"
            style={{ width: `${p.total ? (p.reviewed / p.total) * 100 : 0}%` }}
          />
          <div
            className="bg-info/70"
            style={{ width: `${p.total ? (p.auto / p.total) * 100 : 0}%` }}
          />
        </div>
      </div>
      <p className="mt-1 text-muted">
        {p.reviewed} reviewed
        {p.auto > 0 ? ` + ${p.auto} auto-cleared` : ''} of {p.total}{' '}
        {hasFiles ? 'items' : p.total === 1 ? 'hunk' : 'hunks'}
      </p>
      {analysisStale && (
        <p className="mt-1 text-warning" data-testid="progress-stale">
          Analysis is out of date: auto-clear is paused until it is re-analyzed.
        </p>
      )}
    </div>
  );
}
