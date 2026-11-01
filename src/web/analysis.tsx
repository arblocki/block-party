import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, ApiError, prUrl } from './api';
import { isStale, needsReanalysis, prVersionKey } from './lib/staleness';
import { useReview } from './state';
import type { AnalysisResponse, ProvidersResponse } from './types';

export interface ProviderChoice {
  provider: string;
  model: string;
}

export interface AnalysisContextValue {
  /** Last successful analysis; kept while a re-analysis is running. */
  result: AnalysisResponse | null;
  /** The displayed result was computed for an older head/diff than the loaded PR. */
  stale: boolean;
  /** A provider run (which spends LLM quota) is in progress. */
  loading: boolean;
  /** A cache-only lookup is in progress; it never runs a provider. */
  checking: boolean;
  /**
   * Nothing is cached for the current PR version and provider/model, and no run was requested:
   * the user has to press Analyze.
   */
  idle: boolean;
  /** Seconds since the current request started. */
  elapsedS: number;
  error: { code?: string; message: string } | null;
  providers: ProvidersResponse | null;
  /** Provider/model the next (or current) request uses; null = server default. */
  choice: ProviderChoice | null;
  /** Switching only looks up the cache; it doesn't start a run. */
  setChoice(c: ProviderChoice): void;
  /** Run the provider: reuses a cached result for this version if one exists. */
  analyze(): void;
  /** Run the provider again, ignoring the cache. */
  reanalyze(): void;
}

const AnalysisContext = createContext<AnalysisContextValue | null>(null);

export function useAnalysis(): AnalysisContextValue {
  const v = useContext(AnalysisContext);
  if (!v) throw new Error('useAnalysis outside AnalysisProvider');
  return v;
}

type RequestMode = 'cache' | 'run' | 'force';

/**
 * Requests /api/analysis in the background so the file view stays usable. Opening a PR,
 * switching provider/model, or a refresh that loads a new head/diff only asks the cache
 * (`cacheOnly=1`); the provider runs, and spends quota, only when the user presses Analyze or
 * Re-analyze. A request is aborted and replaced by the next one; an older result stays
 * `stale` until a new one arrives.
 */
export function AnalysisProvider({ children }: { children: ReactNode }) {
  const { pr, diffHash } = useReview();
  const version = { headSha: pr.headSha, diffHash };
  const versionRef = useRef(version);
  versionRef.current = version;
  // PR version the latest request was started for.
  const requestedRef = useRef<string | null>(null);
  const [result, setResult] = useState<AnalysisResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);
  const [idle, setIdle] = useState(false);
  const [elapsedS, setElapsedS] = useState(0);
  const [error, setError] = useState<AnalysisContextValue['error']>(null);
  const [providers, setProviders] = useState<ProvidersResponse | null>(null);
  const [choice, setChoiceState] = useState<ProviderChoice | null>(null);
  const [req, setReq] = useState<{ id: number; mode: RequestMode }>({ id: 0, mode: 'cache' });
  const choiceRef = useRef<ProviderChoice | null>(null);

  useEffect(() => {
    api<ProvidersResponse>(prUrl('/providers')).then(setProviders, () => undefined);
  }, []);

  useEffect(() => {
    const ctl = new AbortController();
    requestedRef.current = prVersionKey(versionRef.current);
    const started = Date.now();
    const run = req.mode !== 'cache';
    setLoading(run);
    setChecking(!run);
    setIdle(false);
    setError(null);
    setElapsedS(0);
    const tick = run
      ? setInterval(() => setElapsedS(Math.floor((Date.now() - started) / 1000)), 500)
      : undefined;
    const params = new URLSearchParams();
    if (req.mode === 'force') params.set('force', '1');
    if (req.mode === 'cache') params.set('cacheOnly', '1');
    const choice = choiceRef.current;
    if (choice) {
      params.set('provider', choice.provider);
      if (choice.model) params.set('model', choice.model);
    }
    const qs = params.toString();
    api<AnalysisResponse>(prUrl(`/analysis${qs ? `?${qs}` : ''}`), { signal: ctl.signal })
      .then((res) => {
        setResult(res);
      })
      .catch((err: unknown) => {
        if (ctl.signal.aborted) return;
        const code = err instanceof ApiError ? err.code : undefined;
        if (code === 'not_cached') {
          setIdle(true);
          return;
        }
        setError({ code, message: (err as Error).message });
      })
      .finally(() => {
        clearInterval(tick);
        if (ctl.signal.aborted) return;
        setLoading(false);
        setChecking(false);
      });
    return () => {
      ctl.abort();
      clearInterval(tick);
    };
  }, [req]);

  // A refresh that brought a new head/diff: ask again (the server cache answers if it can).
  useEffect(() => {
    if (needsReanalysis(requestedRef.current, versionRef.current)) {
      setReq((r) => ({ id: r.id + 1, mode: 'cache' }));
    }
  }, [pr.headSha, diffHash]);

  const stale = isStale(result, version);

  const setChoice = useCallback((c: ProviderChoice) => {
    choiceRef.current = c;
    setChoiceState(c);
    setReq((r) => ({ id: r.id + 1, mode: 'cache' }));
  }, []);
  const analyze = useCallback(() => setReq((r) => ({ id: r.id + 1, mode: 'run' })), []);
  const reanalyze = useCallback(() => setReq((r) => ({ id: r.id + 1, mode: 'force' })), []);

  const value = useMemo(
    () => ({
      result,
      stale,
      loading,
      checking,
      idle,
      elapsedS,
      error,
      providers,
      choice,
      setChoice,
      analyze,
      reanalyze,
    }),
    [
      result,
      stale,
      loading,
      checking,
      idle,
      elapsedS,
      error,
      providers,
      choice,
      setChoice,
      analyze,
      reanalyze,
    ],
  );
  return <AnalysisContext.Provider value={value}>{children}</AnalysisContext.Provider>;
}
