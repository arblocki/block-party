import { repoKey } from './repoList';
import type { NewRunRepo } from '../types';

/** Keeps repos where every whitespace-separated term appears in `owner/repo`. */
export function filterNewRunRepos(repos: NewRunRepo[], query: string): NewRunRepo[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return repos.filter((r) => {
    const name = repoKey({ owner: r.owner, repo: r.repo });
    return terms.every((t) => name.includes(t));
  });
}

/** `/Users/me/repos` as `~/repos`, for showing a folder under the home directory. */
export const tildify = (path: string): string => path.replace(/^\/(?:Users|home)\/[^/]+/, '~');

/** Where the repo's code is, or will be. */
export function cloneState(repo: NewRunRepo, cloneRoot: string): string {
  return repo.clones.length > 0
    ? 'on this computer'
    : `will be cloned to ${tildify(cloneRoot)}/${repo.repo}`;
}
