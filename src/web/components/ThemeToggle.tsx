import { useEffect, useState } from 'react';
import {
  applyThemePreference,
  readThemePreference,
  saveThemePreference,
  THEME_PREFERENCES,
  type ThemePreference,
} from '../lib/theme';

export function ThemeToggle() {
  const [pref, setPref] = useState<ThemePreference>(readThemePreference);

  // Follow OS changes while "system" is selected.
  useEffect(() => {
    if (pref !== 'system' || typeof matchMedia !== 'function') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => applyThemePreference('system');
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [pref]);

  return (
    <div
      role="group"
      aria-label="Theme"
      className="flex overflow-hidden rounded-md border border-line text-sm"
    >
      {THEME_PREFERENCES.map((t) => (
        <button
          key={t}
          type="button"
          aria-pressed={pref === t}
          className={`px-2 py-1 capitalize ${
            pref === t
              ? 'bg-accent-soft text-accent'
              : 'bg-surface-elevated text-muted hover:bg-surface-hover'
          }`}
          onClick={() => {
            setPref(t);
            saveThemePreference(t);
          }}
        >
          {t}
        </button>
      ))}
    </div>
  );
}
