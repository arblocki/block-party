import { useEffect, useState } from 'react';
import { useAnalysis } from '../analysis';
import { HideReviewedToggle } from './ReReviewBanner';
import { usageParts, VIEW_LABELS, type ViewMode } from '../lib/groups';

const btn =
  'rounded-md border border-line bg-surface-elevated px-2.5 py-1 text-sm hover:bg-surface-hover disabled:opacity-50';
const input = 'rounded-md border border-line bg-surface px-1.5 py-1 text-sm';

/** Second header row: view switcher, provider/model, Re-analyze, usage line, and PR summary. */
export function AnalysisBar({
  view,
  onView,
  onHelp,
}: {
  view: ViewMode;
  onView(v: ViewMode): void;
  onHelp?: () => void;
}) {
  const {
    result,
    stale,
    loading,
    checking,
    idle,
    elapsedS,
    providers,
    choice,
    setChoice,
    analyze,
    reanalyze,
  } = useAnalysis();
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [dismissedWarning, setDismissedWarning] = useState<string | null>(null);
  // A stale analysis describes an older head; its summary and badges must not read as current.
  const analysis = stale ? undefined : result?.analysis;

  const provider = choice?.provider ?? providers?.current.provider ?? analysis?.provider ?? '';
  const appliedModel = choice?.model ?? providers?.current.model ?? analysis?.model ?? '';
  const [model, setModel] = useState(appliedModel);
  useEffect(() => setModel(appliedModel), [appliedModel]);
  const applyModel = () => {
    if (model.trim() && model.trim() !== appliedModel) setChoice({ provider, model: model.trim() });
  };

  return (
    <div className="border-t border-line px-4 py-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex overflow-hidden rounded-md border border-line text-sm">
          {(Object.keys(VIEW_LABELS) as ViewMode[]).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              className={`px-2.5 py-1 ${
                view === v
                  ? 'bg-accent-soft text-accent'
                  : 'bg-surface-elevated hover:bg-surface-hover'
              }`}
              onClick={() => onView(v)}
            >
              {VIEW_LABELS[v]}
            </button>
          ))}
        </div>
        {providers && (
          <div className="flex items-center gap-1">
            <select
              aria-label="Analysis provider"
              className={input}
              value={provider}
              onChange={(e) =>
                setChoice({
                  provider: e.target.value,
                  model: providers.models[e.target.value] ?? '',
                })
              }
            >
              {providers.available.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <input
              aria-label="Analysis model"
              className={`${input} w-52 font-mono text-xs`}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              onBlur={applyModel}
              onKeyDown={(e) => e.key === 'Enter' && applyModel()}
            />
          </div>
        )}
        {/* Runs the provider (spends quota) only on click; nothing runs on open. */}
        {idle || !result ? (
          <button
            type="button"
            className="rounded-md bg-accent px-2.5 py-1 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50"
            disabled={loading || checking}
            title="Run the provider to group this PR's hunks (uses your quota)"
            onClick={analyze}
          >
            {loading ? `Analyzing… ${elapsedS}s` : 'Analyze'}
          </button>
        ) : (
          <button type="button" className={btn} disabled={loading} onClick={reanalyze}>
            {loading ? `Analyzing… ${elapsedS}s` : 'Re-analyze'}
          </button>
        )}
        <HideReviewedToggle />
        {onHelp && (
          <button
            type="button"
            className={btn}
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts (?)"
            onClick={onHelp}
          >
            ?
          </button>
        )}
        {analysis && (
          <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
            <span>{usageParts(analysis).join(' · ')}</span>
            {result?.cached && (
              <span className="rounded-md bg-accent-soft px-1.5 py-0.5 text-accent">cached</span>
            )}
            {analysis.fallback && (
              <span className="rounded-md bg-warning-soft px-1.5 py-0.5 text-warning">
                fallback grouping
              </span>
            )}
            {analysis.backfilled > 0 && (
              <span className="rounded-md bg-warning-soft px-1.5 py-0.5 text-warning">
                {analysis.backfilled} {analysis.backfilled === 1 ? 'hunk' : 'hunks'} back-filled
              </span>
            )}
          </div>
        )}
      </div>
      {result?.configNotice && (
        <p
          className="mt-1 rounded-md bg-accent-soft px-2 py-1 text-sm text-accent"
          role="status"
          data-testid="config-notice"
        >
          {result.configNotice}
        </p>
      )}
      {result?.configWarning && result.configWarning !== dismissedWarning && (
        <div
          className="mt-1 flex items-start gap-2 rounded-md bg-warning-soft px-2 py-1 text-sm text-warning"
          role="alert"
          data-testid="config-warning"
        >
          <p className="min-w-0 flex-1">{result.configWarning}</p>
          <button
            type="button"
            className="shrink-0 text-xs hover:underline"
            aria-label="Dismiss warning"
            onClick={() => setDismissedWarning(result.configWarning ?? null)}
          >
            Dismiss
          </button>
        </div>
      )}
      {analysis?.summary && (
        <div className="mt-1 flex items-start gap-2 text-sm">
          <p
            className={`min-w-0 flex-1 text-fg ${
              summaryOpen ? 'max-h-40 overflow-y-auto' : 'line-clamp-1'
            }`}
          >
            <span className="font-semibold">Summary: </span>
            {analysis.summary}
          </p>
          <button
            type="button"
            className="shrink-0 text-xs text-accent hover:underline"
            onClick={() => setSummaryOpen((o) => !o)}
          >
            {summaryOpen ? 'Collapse' : 'Expand'}
          </button>
        </div>
      )}
    </div>
  );
}
