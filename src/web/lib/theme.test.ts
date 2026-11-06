import { describe, expect, it } from 'vitest';
import { parseThemePreference, resolveTheme } from './theme';

describe('theme', () => {
  it('defaults to dark for missing or invalid values', () => {
    expect(parseThemePreference(null)).toBe('dark');
    expect(parseThemePreference('purple')).toBe('dark');
  });
  it('keeps valid preferences', () => {
    for (const p of ['dark', 'light', 'system'] as const) expect(parseThemePreference(p)).toBe(p);
  });
  it('resolves system preference from the OS', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
  });
});
