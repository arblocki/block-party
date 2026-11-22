import { createSseState, parseSse, type SseMessage } from './lib/sse';

const TOKEN_HEADER = 'x-block-party-token';

const STORAGE_KEY = 'block-party-token';

/** Session token; persisted in sessionStorage so a reload keeps it. */
let token = '';

type TokenStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** A token in the hash wins and is stored; otherwise fall back to storage. Never throws. */
export function resolveToken(hash: string, storage: TokenStorage | undefined): string {
  const fromHash = new URLSearchParams(hash.replace(/^#/, '')).get('token') ?? '';
  try {
    if (fromHash) {
      storage?.setItem(STORAGE_KEY, fromHash);
      return fromHash;
    }
    return storage?.getItem(STORAGE_KEY) ?? '';
  } catch {
    return fromHash;
  }
}

/** Resolves the token from `#token=...` or sessionStorage, then strips the hash. */
export function initToken(): void {
  let storage: TokenStorage | undefined;
  try {
    storage = sessionStorage;
  } catch {
    storage = undefined;
  }
  token = resolveToken(location.hash, storage);
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}

/** Non-2xx response; `body` is the parsed JSON error payload when there was one. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get code(): string | undefined {
    return typeof this.body.code === 'string' ? this.body.code : undefined;
  }
}

/** PR the page is reviewing. Fixed for the page's lifetime: switching PRs reloads the page. */
let selected: { owner: string; repo: string; number: number } | undefined;

export function selectPr(pr: { owner: string; repo: string; number: number }): void {
  selected = pr;
}

/** API URL of a repository, e.g. `repoUrl(repo, '/pulls')`. */
export function repoUrl(repo: { owner: string; repo: string }, path: string): string {
  return `/api/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}${path}`;
}

/** URL of a route in the selected PR's API, e.g. `prUrl('/drafts')`. */
export function prUrl(path: string): string {
  if (!selected) throw new Error('No pull request selected');
  return repoUrl(selected, `/pulls/${selected.number}${path}`);
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set(TOKEN_HEADER, token);
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      // not JSON
    }
    const message = typeof body.error === 'string' ? body.error : `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, message, body);
  }
  return (await res.json()) as T;
}

const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 10_000;

/** Resolves after `ms`, or immediately when `signal` aborts (timer is cleared). */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}

export interface OpenStreamDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Follows a `text/event-stream` endpoint until `signal` aborts, reconnecting with
 * `Last-Event-ID` and 1s..10s exponential backoff when the connection drops or fails.
 */
export async function openStream(
  path: string,
  onMessage: (msg: SseMessage) => void,
  signal: AbortSignal,
  deps: OpenStreamDeps = {},
): Promise<void> {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? abortableSleep;
  let lastId: string | undefined;
  let delay = BACKOFF_START_MS;
  while (!signal.aborted) {
    try {
      const headers = new Headers({ [TOKEN_HEADER]: token, accept: 'text/event-stream' });
      if (lastId !== undefined) headers.set('Last-Event-ID', lastId);
      const res = await doFetch(path, { headers, signal });
      if (res.ok && res.body) {
        delay = BACKOFF_START_MS;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const state = createSseState(lastId);
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const msg of parseSse(decoder.decode(value, { stream: true }), state)) {
            if (msg.id !== undefined) lastId = msg.id;
            onMessage(msg);
          }
        }
      } else {
        await res.body?.cancel().catch(() => {});
      }
    } catch {
      // network error, dropped connection, or abort: handled below
    }
    if (signal.aborted) return;
    await sleep(delay, signal);
    delay = Math.min(delay * 2, BACKOFF_MAX_MS);
  }
}

export function jsonBody(value: unknown): RequestInit {
  return { body: JSON.stringify(value) };
}
