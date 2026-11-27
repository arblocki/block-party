import { describe, expect, it } from 'vitest';
import { pnpmStoreDirs } from './sandbox-dirs.js';

describe('pnpmStoreDirs', () => {
  it('returns the default store locations that exist', () => {
    const present = new Set(['/h/.local/share/pnpm/store']);
    expect(pnpmStoreDirs({}, '/h', (p) => present.has(p))).toEqual(['/h/.local/share/pnpm/store']);
  });

  it('honours PNPM_HOME and XDG_DATA_HOME', () => {
    const all = () => true;
    expect(pnpmStoreDirs({ PNPM_HOME: '/p', XDG_DATA_HOME: '/x' }, '/h', all)).toEqual([
      '/p/store',
      '/x/pnpm/store',
      '/h/Library/pnpm/store',
    ]);
  });

  it('returns nothing when none exists', () => {
    expect(pnpmStoreDirs({}, '/h', () => false)).toEqual([]);
  });
});
