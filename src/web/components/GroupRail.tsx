import { useMemo } from 'react';
import { itemCounts } from '../lib/groups';
import { groupProgress } from '../lib/progress';
import { useReviewState } from '../reviewState';
import type { AnalysisGroup } from '../types';
import { ProgressBar } from './ProgressBar';
import { RiskBadge } from './RiskBadge';

/**
 * Left rail for the grouped views: one row per group with its progress ("2/5", or a check when
 * every hunk is reviewed or auto-cleared), and the overall progress bar below the list.
 */
export function GroupRail({
  groups,
  selectedKey,
  onSelect,
  unrelated,
  loading,
}: {
  groups: AnalysisGroup[];
  selectedKey: string | undefined;
  onSelect(key: string): void;
  unrelated: string[];
  loading?: boolean;
}) {
  const { knownItemIds, fileKeys, status } = useReviewState();
  const progress = useMemo(
    () => groupProgress(groups, fileKeys, knownItemIds, status),
    [groups, fileKeys, knownItemIds, status],
  );
  if (loading && groups.length === 0) {
    return (
      <div className="space-y-2 p-3" aria-label="Loading groups">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="h-6 animate-pulse rounded-md bg-surface-elevated" />
        ))}
      </div>
    );
  }
  return (
    <nav className="py-2 text-sm">
      <div className="px-3 pb-1 text-xs font-semibold tracking-wide text-muted uppercase">
        Groups ({groups.length})
      </div>
      <ul>
        {groups.map((g) => {
          const selected = g.key === selectedKey;
          const muted = g.autoClear && !g.unclassified;
          const p = progress.get(g.key);
          return (
            <li key={g.key}>
              <button
                type="button"
                title={`${g.title} (${itemCounts(g)})`}
                aria-current={selected ? 'true' : undefined}
                onClick={() => onSelect(g.key)}
                className={`flex w-full items-center gap-2 border-l-2 px-3 py-1.5 text-left hover:bg-surface-hover ${
                  selected ? 'border-accent bg-accent-soft' : 'border-transparent'
                } ${muted ? 'opacity-60' : ''}`}
              >
                <RiskBadge group={g} />
                <span className={`min-w-0 flex-1 truncate ${selected ? 'font-medium' : ''}`}>
                  {g.title}
                </span>
                <span
                  className="shrink-0 font-mono text-xs text-muted"
                  data-testid="group-progress"
                  title={
                    p
                      ? `${p.reviewed} reviewed${p.auto ? `, ${p.auto} auto-cleared` : ''} of ${p.total} ${g.files.length > 0 ? 'hunks + files' : 'hunks'}`
                      : undefined
                  }
                >
                  {p?.complete ? (
                    <span
                      className={p.reviewed === 0 ? 'text-info' : 'font-bold text-success'}
                      aria-label={p.reviewed === 0 ? 'auto-cleared' : 'complete'}
                    >
                      ✓
                    </span>
                  ) : (
                    `${p?.done ?? 0}/${p?.total ?? g.hunkIds.length + g.files.length}`
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {unrelated.length > 0 && (
        <div className="m-3 rounded-md border border-warning/40 bg-warning-soft p-2 text-xs text-warning">
          <div className="mb-1 font-semibold">Unrelated or suspicious</div>
          <ul className="list-disc space-y-1 pl-4">
            {unrelated.map((u, i) => (
              <li key={i}>{u}</li>
            ))}
          </ul>
        </div>
      )}
      <ProgressBar />
    </nav>
  );
}
