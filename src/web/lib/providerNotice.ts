export interface ProviderModel {
  provider: string;
  model: string;
}

function sameSelection(a: ProviderModel, b: ProviderModel): boolean {
  return a.provider === b.provider && a.model === b.model;
}

/**
 * Notice for when the displayed analysis came from a different provider/model than the one
 * requested: the switch is being looked up, running, failed, or waiting for Analyze. Null when
 * they match, nothing is displayed, or nothing is pending.
 */
export function providerNotice(input: {
  displayed: ProviderModel | null;
  requested: ProviderModel | null;
  loading: boolean;
  error: string | null;
  /** A cache lookup for the requested selection is in progress. */
  checking?: boolean;
  /** Nothing is cached for the requested selection and no run was started. */
  idle?: boolean;
}): string | null {
  const { displayed, requested, loading, error, checking, idle } = input;
  if (!displayed || !requested || sameSelection(displayed, requested)) return null;
  const shown = `Showing the previous analysis from ${displayed.provider} (${displayed.model})`;
  // Same provider, different model: name the model so the notice isn't self-contradictory.
  const asked =
    requested.provider === displayed.provider && requested.model
      ? `${requested.provider} (${requested.model})`
      : requested.provider;
  if (loading) return `${shown}; ${asked} analysis is running`;
  if (error !== null) return `${shown}; ${asked} analysis failed: ${error}`;
  if (checking) return `${shown}; looking for a cached ${asked} analysis`;
  if (idle) return `${shown}; press Analyze to run ${asked}`;
  return null;
}
