/**
 * How an /api/analysis request was started. Only 'run' and 'force' invoke the provider and
 * spend quota; 'cache' answers from the cache and never runs anything.
 */
export type RequestMode = 'cache' | 'run' | 'force';

/** Query string for an analysis request in `mode` with an optional provider/model choice. */
export function analysisQuery(
  mode: RequestMode,
  choice: { provider: string; model: string } | null,
): string {
  const params = new URLSearchParams();
  if (mode === 'force') params.set('force', '1');
  if (mode === 'cache') params.set('cacheOnly', '1');
  if (choice) {
    params.set('provider', choice.provider);
    if (choice.model) params.set('model', choice.model);
  }
  return params.toString();
}

/**
 * Retry repeats the request that failed, nothing more expensive: a failed cache lookup is
 * retried as a cache lookup, so Retry never spends quota the user didn't already ask to spend.
 */
export function retryMode(failed: RequestMode): RequestMode {
  return failed;
}

/** Label for the Retry button, so a paid retry says so. */
export function retryLabel(failed: RequestMode): string {
  return failed === 'cache' ? 'Retry lookup' : 'Retry analysis (uses quota)';
}
