import { describe, expect, it } from 'vitest';
import type { NewRunRepo } from '../types';
import { chosenCopy, cloneState, filterNewRunRepos, shouldRepick, tildify } from './newRunRepos';

const repo = (owner: string, name: string, clones: string[] = []): NewRunRepo => ({
  owner,
  repo: name,
  private: false,
  pushedAt: null,
  defaultBranch: null,
  clones,
  projectId: null,
  lastUsedAt: null,
});

describe('filterNewRunRepos', () => {
  const all = [repo('Acme', 'widgets'), repo('me', 'blog'), repo('acme', 'blog-theme')];
  it('keeps everything for an empty filter', () => {
    expect(filterNewRunRepos(all, '  ')).toEqual(all);
  });
  it('needs every term, ignoring case', () => {
    expect(filterNewRunRepos(all, 'ACME blog').map((r) => r.repo)).toEqual(['blog-theme']);
    expect(filterNewRunRepos(all, 'blog').map((r) => r.repo)).toEqual(['blog', 'blog-theme']);
    expect(filterNewRunRepos(all, 'nope')).toEqual([]);
  });
});

describe('cloneState', () => {
  it('says whether the repo is on this computer or where it would be cloned', () => {
    expect(cloneState(repo('a', 'b', ['/x/b']), '/Users/me/repos')).toBe('on this computer');
    expect(cloneState(repo('a', 'b'), '/Users/me/repos')).toBe('will be cloned to ~/repos/b');
  });
  it('shortens only a home directory', () => {
    expect(tildify('/Users/me/code')).toBe('~/code');
    expect(tildify('/home/me/code')).toBe('~/code');
    expect(tildify('/srv/code')).toBe('/srv/code');
  });
});

describe('which copy', () => {
  const two = repo('a', 'b', ['/x/one', '/x/two']);
  it('defaults to the first copy and follows a valid pick', () => {
    expect(chosenCopy(two, {})).toBe('/x/one');
    expect(chosenCopy(two, { 'a/b': '/x/two' })).toBe('/x/two');
    expect(chosenCopy(two, { 'a/b': '/gone' })).toBe('/x/one');
  });
  it('has no choice to make with fewer than two copies', () => {
    expect(chosenCopy(repo('a', 'b', ['/x/one']), { 'a/b': '/x/one' })).toBeUndefined();
    expect(chosenCopy(repo('a', 'b'), {})).toBeUndefined();
  });
  it('re-prepares only when the chosen repo changes its copy', () => {
    expect(shouldRepick(repo('a', 'b'), two)).toBe(true);
    expect(shouldRepick(repo('a', 'other'), two)).toBe(false);
    expect(shouldRepick(null, two)).toBe(false);
  });
});
