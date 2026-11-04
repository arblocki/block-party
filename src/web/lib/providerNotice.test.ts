import { describe, expect, it } from 'vitest';
import { providerNotice } from './providerNotice';

const shown = { provider: 'claude-cli', model: 'sonnet' };
const base = { displayed: shown, requested: shown, loading: false, error: null };

describe('providerNotice', () => {
  it('is silent when the displayed result matches the request or nothing is displayed', () => {
    expect(providerNotice(base)).toBeNull();
    expect(
      providerNotice({ ...base, displayed: null, requested: { ...shown, provider: 'x' } }),
    ).toBeNull();
    expect(providerNotice({ ...base, requested: null })).toBeNull();
  });

  it('says the new analysis is running while a switch is pending', () => {
    const requested = { provider: 'openrouter', model: 'a/b' };
    expect(providerNotice({ ...base, requested, loading: true })).toBe(
      'Showing the previous analysis from claude-cli (sonnet); openrouter analysis is running',
    );
  });

  it('reports the failure, with the message, after a failed switch', () => {
    const requested = { provider: 'openrouter', model: 'a/b' };
    expect(providerNotice({ ...base, requested, error: 'no key' })).toBe(
      'Showing the previous analysis from claude-cli (sonnet); openrouter analysis failed: no key',
    );
  });

  it('names the model when only the model changed', () => {
    const requested = { provider: 'claude-cli', model: 'opus' };
    expect(providerNotice({ ...base, requested, error: 'boom' })).toBe(
      'Showing the previous analysis from claude-cli (sonnet); claude-cli (opus) analysis failed: boom',
    );
  });

  it('asks for Analyze when the new selection has nothing cached', () => {
    const requested = { provider: 'codex-cli', model: 'm' };
    expect(providerNotice({ ...base, requested, idle: true })).toBe(
      'Showing the previous analysis from claude-cli (sonnet); press Analyze to run codex-cli',
    );
  });

  it('labels the previous result while the cache lookup for the new selection runs', () => {
    const requested = { provider: 'codex-cli', model: 'm' };
    expect(providerNotice({ ...base, requested, checking: true })).toBe(
      'Showing the previous analysis from claude-cli (sonnet); looking for a cached codex-cli analysis',
    );
  });

  it('is silent when they differ but nothing is pending or failed', () => {
    expect(
      providerNotice({ ...base, requested: { provider: 'openrouter', model: 'm' } }),
    ).toBeNull();
  });
});
