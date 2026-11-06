import { describe, expect, it } from 'vitest';
import { configDir, dataDir, dbPath } from './paths.js';

describe('paths', () => {
  it('uses home-relative defaults', () => {
    expect(dataDir({}, '/home/me')).toBe('/home/me/.block-party');
    expect(configDir({}, '/home/me')).toBe('/home/me/.config/block-party');
    expect(dbPath({}, '/home/me')).toBe('/home/me/.block-party/block-party.db');
  });

  it('respects env overrides', () => {
    const env = { BLOCK_PARTY_HOME: '/data', XDG_CONFIG_HOME: '/xdg' };
    expect(dataDir(env, '/home/me')).toBe('/data');
    expect(configDir(env, '/home/me')).toBe('/xdg/block-party');
  });
});
