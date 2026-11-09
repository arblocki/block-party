import { describe, expect, it } from 'vitest';
import { branchName, newRunId, slugify } from './id.js';

describe('ids', () => {
  it('formats run ids', () => {
    const id = newRunId(new Date('2026-11-08T12:00:00Z'), () => Buffer.from([0x3f, 0xa9, 0xc1]));
    expect(id).toBe('r20261108-3fa9c1');
    expect(newRunId()).toMatch(/^r\d{8}-[0-9a-f]{6}$/);
  });
  it('slugifies', () => {
    expect(slugify('Add Login: OAuth & SSO!')).toBe('add-login-oauth-sso');
    expect(slugify('Café déjà')).toBe('cafe-deja');
    expect(slugify('日本語')).toBe('run');
    expect(slugify('')).toBe('run');
    const long = slugify('a'.repeat(30) + ' ' + 'b'.repeat(30));
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith('-')).toBe(false);
  });
  it('builds branch names', () => {
    expect(branchName('Fix the bug', 'r20261108-3fa9c1')).toBe('bp/fix-the-bug-3fa9c1');
  });
});
