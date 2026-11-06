import { useEffect, useRef, useState, type ReactNode } from 'react';
import { pullsHref } from '../lib/route';
import { useDraftCount, useReview } from '../state';
import { ThemeToggle } from './ThemeToggle';

const btn =
  'rounded-md border border-line bg-surface-elevated px-2.5 py-1 text-sm hover:bg-surface-hover disabled:opacity-50';

export function Header({ onSubmit, extra }: { onSubmit: () => void; extra?: ReactNode }) {
  const {
    session,
    pr,
    incomplete,
    refreshing,
    refresh,
    refreshError,
    dismissRefreshError,
    viewType,
    setViewType,
    hideWhitespace,
    setHideWhitespace,
    flushDrafts,
  } = useReview();
  const [leaving, setLeaving] = useState(false);
  const draftCount = useDraftCount();
  const ref = useRef<HTMLDivElement>(null);

  // The sticky rail and scroll offsets key off the header's real height.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = () =>
      document.documentElement.style.setProperty('--header-h', `${el.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={ref}>
      {incomplete && (
        <div
          role="alert"
          data-testid="incomplete-banner"
          className="border-b border-error/40 bg-error-soft px-4 py-2 text-sm font-medium text-error"
        >
          GitHub only returned {incomplete.fetchedFiles} of {incomplete.changedFiles} changed files.
          This view is incomplete — review the rest on GitHub.{' '}
          <a
            href={`${pr.url}/files`}
            target="_blank"
            rel="noreferrer"
            className="underline hover:no-underline"
          >
            Open the files tab ↗
          </a>
        </div>
      )}
      {refreshError !== null && (
        <div
          role="alert"
          data-testid="refresh-error"
          className="flex items-center gap-2 border-b border-error/40 bg-error-soft px-4 py-1.5 text-sm text-error"
        >
          <span className="min-w-0 flex-1">
            Refresh failed, showing the previous data: {refreshError}
          </span>
          <button
            type="button"
            className="shrink-0 rounded-md px-1.5 hover:bg-error-soft"
            aria-label="Dismiss"
            onClick={dismissRefreshError}
          >
            ✕
          </button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <a
              href={pullsHref(session.pr)}
              className="shrink-0 text-sm text-accent hover:underline"
              title="All open pull requests"
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                // Save pending drafts before the page goes away. Anything still unsaved after
                // that is caught by the page's beforeunload prompt.
                e.preventDefault();
                if (leaving) return;
                setLeaving(true);
                void flushDrafts().finally(() => {
                  location.search = pullsHref(session.pr);
                  // Still here if the user cancelled the leave prompt.
                  setLeaving(false);
                });
              }}
            >
              ← PRs
            </a>
            <span className="shrink-0 font-mono text-sm text-muted">
              {session.pr.owner}/{session.pr.repo} #{session.pr.number}
            </span>
            <h1 className="truncate text-base font-semibold" title={pr.title}>
              {pr.title}
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 text-xs text-muted">
            <span>
              <span className="text-success">+{pr.additions}</span>{' '}
              <span className="text-error">−{pr.deletions}</span>
            </span>
            <span>
              {incomplete
                ? `${incomplete.fetchedFiles} of ${incomplete.changedFiles} files`
                : `${pr.changedFiles} files`}
            </span>
            <span>
              head <code className="font-mono">{pr.headSha.slice(0, 7)}</code>
            </span>
            <span>
              {pr.headRef} → {pr.baseRef}
            </span>
            <a
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              View on GitHub ↗
            </a>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-sm text-muted">
            <input
              type="checkbox"
              checked={hideWhitespace}
              onChange={(e) => setHideWhitespace(e.target.checked)}
            />
            Hide whitespace
          </label>
          <div className="flex overflow-hidden rounded-md border border-line text-sm">
            {(['unified', 'split'] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={viewType === v}
                className={`px-2.5 py-1 capitalize ${
                  viewType === v
                    ? 'bg-accent-soft text-accent'
                    : 'bg-surface-elevated hover:bg-surface-hover'
                }`}
                onClick={() => setViewType(v)}
              >
                {v}
              </button>
            ))}
          </div>
          <ThemeToggle />
          <button
            type="button"
            className={btn}
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          <button
            type="button"
            className="rounded-md bg-accent px-3 py-1 text-sm font-medium text-accent-fg hover:bg-accent-hover"
            onClick={onSubmit}
          >
            Submit review ({draftCount} {draftCount === 1 ? 'draft' : 'drafts'})
          </button>
        </div>
      </div>
      {extra}
    </div>
  );
}
