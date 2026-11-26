import type { DecisionAnswer, RunStore } from '../store/runs.js';

/** The decision a run was waiting on was dismissed (or vanished) instead of answered. */
export class DecisionDismissedError extends Error {
  constructor(readonly decisionId: number) {
    super(`Decision ${decisionId} was dismissed`);
    this.name = 'DecisionDismissedError';
  }
}

export interface WaitOptions {
  signal?: AbortSignal;
  /** Poll interval in ms (default 1000). */
  intervalMs?: number;
}

/**
 * Waits until another writer (the server) answers decision `id`, by polling the store. Read errors are retried. Rejects
 * with the signal's reason when aborted and with `DecisionDismissedError` when the decision
 * is dismissed or missing. A decision already resolved with an answer still yields it.
 */
export function waitForAnswer(
  store: Pick<RunStore, 'getDecision'>,
  id: number,
  opts: WaitOptions = {},
): Promise<DecisionAnswer> {
  const { signal } = opts;
  const intervalMs = opts.intervalMs ?? 1000;
  return new Promise<DecisionAnswer>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const finish = (settle: () => void): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      settle();
    };
    const check = (): void => {
      let d;
      try {
        d = store.getDecision(id);
      } catch {
        // A busy database (the server writing) is transient; try again next tick.
        timer = setTimeout(check, intervalMs);
        return;
      }
      if (d?.answer) {
        const answer = d.answer;
        finish(() => resolve(answer));
      } else if (!d || d.status === 'dismissed') {
        finish(() => reject(new DecisionDismissedError(id)));
      } else {
        timer = setTimeout(check, intervalMs);
      }
    };
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    check();
  });
}
