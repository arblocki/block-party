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

const idOf = (r: Pick<NewRunRepo, 'owner' | 'repo'>): string => `${r.owner}/${r.repo}`;

/** The copy to use for a repo: the one picked in "Which copy?", else the first (the registered one). */
export function chosenCopy(repo: NewRunRepo, picked: Record<string, string>): string | undefined {
  if (repo.clones.length < 2) return undefined;
  const mine = picked[idOf(repo)];
  return mine && repo.clones.includes(mine) ? mine : repo.clones[0];
}

/** Changing the copy of the repo that is already chosen means getting the new copy ready. */
export function shouldRepick(
  chosen: Pick<NewRunRepo, 'owner' | 'repo'> | null,
  changed: NewRunRepo,
): boolean {
  return chosen !== null && idOf(chosen) === idOf(changed);
}
