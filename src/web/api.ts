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
  // No token (e.g. a device logged in by cookie): send none, so the session cookie decides.
  if (token) headers.set(TOKEN_HEADER, token);
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
  /** Called once when the server answers 401; the stream then stops instead of retrying. */
  onUnauthorized?: () => void;
}

/** Default for a 401 on a stream: reload, which lands on the login screen. */
function reloadToLogin(): void {
  if (typeof location !== 'undefined') location.reload();
}

/**
 * Follows a `text/event-stream` endpoint until `signal` aborts, reconnecting with
 * `Last-Event-ID` and 1s..10s exponential backoff when the connection drops or fails.
 * A 401 means the session is gone: it stops (no retry) and calls `onUnauthorized`.
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
      const headers = new Headers({ accept: 'text/event-stream' });
      if (token) headers.set(TOKEN_HEADER, token);
      if (lastId !== undefined) headers.set('Last-Event-ID', lastId);
      const res = await doFetch(path, { headers, signal });
      if (res.status === 401) {
        await res.body?.cancel().catch(() => {});
        (deps.onUnauthorized ?? reloadToLogin)();
        return;
      }
      if (res.ok && res.body) {
        delay = BACKOFF_START_MS;
        const reader = res.body.getReader();
        // Stopping must release the connection even while a read is pending.
        const stop = () => void reader.cancel().catch(() => {});
        signal.addEventListener('abort', stop);
        try {
          const decoder = new TextDecoder();
          const state = createSseState(lastId);
          while (!signal.aborted) {
            const { done, value } = await reader.read();
            if (done) break;
            for (const msg of parseSse(decoder.decode(value, { stream: true }), state)) {
              if (msg.id !== undefined) lastId = msg.id;
              // A failing handler is the page's bug, not a dropped connection: report it
              // and keep reading, so it neither reconnects nor skips later messages.
              try {
                onMessage(msg);
              } catch (err) {
                console.error('stream message handler failed', err);
              }
              if (signal.aborted) break;
            }
          }
        } finally {
          signal.removeEventListener('abort', stop);
          stop();
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

/** Trades a pasted token for the session cookie. Throws ApiError (401 when wrong). */
export async function login(pastedToken: string): Promise<void> {
  const res = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: pastedToken }),
  });
  if (!res.ok) {
    throw new ApiError(
      res.status,
      res.status === 401 ? 'Wrong token' : `${res.status} ${res.statusText}`,
    );
  }
  clearToken();
}

/** Forgets the stored token. A stale one would be sent as a header and beat the cookie. */
export function clearToken(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage unavailable
  }
  token = '';
}

/** Clears the session cookie and the stored token. */
export async function logout(): Promise<void> {
  await fetch('/auth/logout', { method: 'POST' });
  clearToken();
}

export function jsonBody(value: unknown): RequestInit {
  return { body: JSON.stringify(value) };
}
