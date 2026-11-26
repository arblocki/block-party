import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, initToken, openStream, resolveToken } from './api.js';

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
}

const throwing = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

describe('resolveToken', () => {
  it('uses and stores the token from the hash', () => {
    const s = memoryStorage();
    expect(resolveToken('#token=abc', s)).toBe('abc');
    expect(s.getItem('block-party-token')).toBe('abc');
  });

  it('survives a refresh (empty hash, same storage)', () => {
    const s = memoryStorage();
    resolveToken('#token=abc', s);
    expect(resolveToken('', s)).toBe('abc');
  });

  it('a new hash overrides the stored token', () => {
    const s = memoryStorage();
    resolveToken('#token=old', s);
    expect(resolveToken('#token=new', s)).toBe('new');
    expect(resolveToken('', s)).toBe('new');
  });

  it('returns empty string with no hash and no storage', () => {
    expect(resolveToken('', undefined)).toBe('');
    expect(resolveToken('', memoryStorage())).toBe('');
  });

  it('degrades gracefully when storage throws', () => {
    expect(resolveToken('#token=abc', throwing)).toBe('abc');
    expect(resolveToken('', throwing)).toBe('');
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('api() header', () => {
  const stubFetch = () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };
  const sentHeaders = (m: ReturnType<typeof stubFetch>) =>
    (m.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Headers;

  it('omits the token header when there is no token', async () => {
    const m = stubFetch();
    await api('/api/health');
    expect(sentHeaders(m).has('x-block-party-token')).toBe(false);
  });

  it('sends the token header once a token is set', async () => {
    vi.stubGlobal('location', { hash: '#token=abc', pathname: '/', search: '' });
    vi.stubGlobal('history', { replaceState: () => {} });
    vi.stubGlobal('sessionStorage', memoryStorage());
    initToken();
    const m = stubFetch();
    await api('/api/health');
    expect(sentHeaders(m).get('x-block-party-token')).toBe('abc');
  });
});

describe('openStream on 401', () => {
  it('stops without retrying and reports it', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 401 }));
    const sleep = vi.fn(async () => {});
    const onUnauthorized = vi.fn();
    const onMessage = vi.fn();
    await openStream('/api/stream', onMessage, new AbortController().signal, {
      fetch: fetchMock as unknown as typeof fetch,
      sleep,
      onUnauthorized,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('still retries other failures', async () => {
    const ac = new AbortController();
    const fetchMock = vi.fn(async () => new Response('x', { status: 503 }));
    const sleep = vi.fn(async () => {
      if (fetchMock.mock.calls.length >= 2) ac.abort();
    });
    const onUnauthorized = vi.fn();
    await openStream('/api/stream', () => {}, ac.signal, {
      fetch: fetchMock as unknown as typeof fetch,
      sleep,
      onUnauthorized,
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
