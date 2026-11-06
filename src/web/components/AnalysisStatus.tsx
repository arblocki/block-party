import { useAnalysis } from '../analysis';
import { describeAnalysisError, type ViewMode } from '../lib/groups';
import { retryLabel } from '../lib/analysisRequest';
import { providerNotice } from '../lib/providerNotice';

/** Skeleton shown in the main pane of a grouped view while analysis is running. */
export function AnalysisSkeleton() {
  const { elapsedS, checking } = useAnalysis();
  return (
    <div aria-busy="true" aria-label="Analyzing pull request">
      <p className="mb-4 text-sm text-muted">
        {checking
          ? 'Looking for a cached analysis…'
          : `Grouping hunks… ${elapsedS}s elapsed (usually 10–60s). The By file view works meanwhile.`}
      </p>
      <div className="space-y-3">
        <div className="h-8 w-2/3 animate-pulse rounded-md bg-surface-elevated" />
        <div className="h-4 w-full animate-pulse rounded-md bg-surface-elevated" />
        <div className="h-4 w-5/6 animate-pulse rounded-md bg-surface-elevated" />
        <div className="h-48 animate-pulse rounded-md bg-surface-elevated" />
        <div className="h-32 animate-pulse rounded-md bg-surface-elevated" />
      </div>
    </div>
  );
}

/** Provider/model the next run will use, for button labels. */
export function useRequestedProvider(): string {
  const { choice, providers } = useAnalysis();
  return choice?.provider ?? providers?.current.provider ?? '';
}

/** Grouped view before any analysis exists: running one is opt-in because it spends quota. */
export function AnalysisIdle({ onView }: { onView(v: ViewMode): void }) {
  const { analyze, loading } = useAnalysis();
  const provider = useRequestedProvider();
  return (
    <div data-testid="analysis-idle" className="rounded-md border border-line p-4 text-sm">
      <p className="text-fg">
        This PR hasn't been analyzed{provider ? ` with ${provider}` : ''} yet. Grouping runs the
        provider and uses your subscription or API quota, so it only starts when you ask.
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50"
          disabled={loading}
          onClick={analyze}
        >
          Analyze{provider ? ` with ${provider}` : ''}
        </button>
        <button
          type="button"
          className="rounded-md border border-line bg-surface px-3 py-1.5 hover:bg-surface-hover"
          onClick={() => onView('file')}
        >
          Review by file
        </button>
      </div>
    </div>
  );
}

/** Analysis failure with a hint and a way back to the By file view. */
export function AnalysisError({ view, onView }: { view: ViewMode; onView(v: ViewMode): void }) {
  const { error, retry, loading, checking } = useAnalysis();
  if (!error) return null;
  const info = describeAnalysisError(error.code, error.message);
  return (
    <div
      role="alert"
      className="mb-3 rounded-md border border-error/40 bg-error-soft p-3 text-sm text-error"
    >
      <div className="font-semibold">{info.title}</div>
      <p className="mt-1">{info.hint}</p>
      <p className="mt-1 font-mono text-xs opacity-80">{error.message}</p>
      <div className="mt-2 flex gap-3">
        <button type="button" className="underline" disabled={loading || checking} onClick={retry}>
          {retryLabel(error.mode)}
        </button>
        {view !== 'file' && (
          <button type="button" className="underline" onClick={() => onView('file')}>
            Review by file instead
          </button>
        )}
      </div>
    </div>
  );
}

/** A successful analysis that found nothing to group. */
export function AnalysisEmpty({ summary, onView }: { summary: string; onView(v: ViewMode): void }) {
  return (
    <div data-testid="analysis-empty" className="rounded-md border border-line p-4">
      {summary && (
        <p className="mb-3 text-sm">
          <span className="font-semibold">Summary: </span>
          {summary}
        </p>
      )}
      <p className="text-sm text-fg">No groups to review — the analysis found nothing to group.</p>
      <button
        type="button"
        className="mt-3 rounded-md border border-line bg-surface-elevated px-3 py-1.5 text-sm hover:bg-surface-hover"
        onClick={() => onView('file')}
      >
        Review by file
      </button>
    </div>
  );
}

/** Says which provider produced the displayed groups while a switch is running or has failed. */
export function ProviderNotice() {
  const { result, providers, choice, loading, checking, error, idle } = useAnalysis();
  const requested = choice ?? providers?.current ?? null;
  const text = providerNotice({
    displayed: result ? { provider: result.analysis.provider, model: result.analysis.model } : null,
    requested,
    loading,
    error: error?.message ?? null,
    checking,
    idle,
  });
  if (!text) return null;
  return (
    <p
      role="status"
      data-testid="provider-notice"
      className="mb-3 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning"
    >
      {text}
    </p>
  );
}

/** Slim banner above the file view while analysis runs in the background. */
export function AnalysisBanner() {
  const { loading, elapsedS, stale, result, idle, analyze } = useAnalysis();
  const provider = useRequestedProvider();
  if (stale) {
    const sha = result?.headSha?.slice(0, 7) ?? '';
    return (
      <p
        role="status"
        data-testid="stale-banner"
        className="mb-3 flex items-center gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning"
      >
        {loading && (
          <span className="inline-block size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
        )}
        Analysis is for an older version of this PR ({sha}){loading ? ' — re-analyzing…' : '.'}{' '}
        Showing the By file view meanwhile.
        {idle && !loading && (
          <button type="button" className="font-medium underline" onClick={analyze}>
            Analyze this version
          </button>
        )}
      </p>
    );
  }
  if (idle && !result) {
    return (
      <p
        role="status"
        data-testid="idle-banner"
        className="mb-3 flex flex-wrap items-center gap-2 rounded-md bg-surface-elevated px-3 py-2 text-sm text-fg"
      >
        Not analyzed yet. Grouping by intent and risk uses your provider quota.
        <button type="button" className="font-medium underline" onClick={analyze}>
          Analyze{provider ? ` with ${provider}` : ''}
        </button>
      </p>
    );
  }
  if (!loading) return null;
  return (
    <p className="mb-3 flex items-center gap-2 rounded-md bg-accent-soft px-3 py-2 text-sm text-accent">
      <span className="inline-block size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
      Grouping in the background… {elapsedS}s. Keep reviewing by file; groups appear when ready.
    </p>
  );
}
