import { describe, expect, it } from 'vitest';
import type { NewRunRepo } from '../types';
import { cloneState, filterNewRunRepos, tildify } from './newRunRepos';

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
