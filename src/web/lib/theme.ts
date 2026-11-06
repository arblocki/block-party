export type ThemePreference = 'dark' | 'light' | 'system';

export const THEME_STORAGE_KEY = 'block-party:theme';
export const THEME_PREFERENCES: readonly ThemePreference[] = ['dark', 'light', 'system'];

/** Dark is the default for anyone without a stored preference. */
export const DEFAULT_THEME: ThemePreference = 'dark';

export function parseThemePreference(raw: unknown): ThemePreference {
  return raw === 'dark' || raw === 'light' || raw === 'system' ? raw : DEFAULT_THEME;
}

export function resolveTheme(pref: ThemePreference, systemPrefersDark: boolean): 'dark' | 'light' {
  if (pref === 'system') return systemPrefersDark ? 'dark' : 'light';
  return pref;
}

export function readThemePreference(): ThemePreference {
  try {
    return parseThemePreference(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyThemePreference(pref: ThemePreference): void {
  const dark =
    typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)').matches : true;
  document.documentElement.dataset.theme = resolveTheme(pref, dark);
}

export function saveThemePreference(pref: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    // Storage may be blocked; the choice still applies for this session.
  }
  applyThemePreference(pref);
}
