import { describe, expect, it } from 'vitest';
import { analysisQuery, retryLabel, retryMode } from './analysisRequest';

describe('analysisQuery', () => {
  it('asks only the cache for a lookup', () => {
    expect(analysisQuery('cache', null)).toBe('cacheOnly=1');
  });
  it('runs the provider on run, and ignores the cache on force', () => {
    expect(analysisQuery('run', null)).toBe('');
    expect(analysisQuery('force', null)).toBe('force=1');
  });
  it('passes the provider/model choice', () => {
    expect(analysisQuery('cache', { provider: 'claude-cli', model: 'opus' })).toBe(
      'cacheOnly=1&provider=claude-cli&model=opus',
    );
  });
});

describe('retry', () => {
  it('retries a failed cache lookup as a cache lookup, never a paid run', () => {
    const next = retryMode('cache');
    expect(next).toBe('cache');
    const qs = new URLSearchParams(analysisQuery(next, null));
    expect(qs.get('cacheOnly')).toBe('1');
    expect(qs.has('force')).toBe(false);
    expect(retryLabel('cache')).toBe('Retry lookup');
  });
  it('retries a failed run the same way and labels it as using quota', () => {
    expect(retryMode('run')).toBe('run');
    expect(retryMode('force')).toBe('force');
    expect(retryLabel('run')).toMatch(/uses quota/);
  });
});
