import { readdir, realpath, stat } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Git } from '../core/git/index.js';

/** A directory on this computer that is a clone of a GitHub repository. */
export interface LocalClone {
  owner: string;
  repo: string;
  /** Real path (symlinks resolved) of the clone's top directory. */
  path: string;
}

/** Folders people usually keep their code in, under the home directory. */
export const DEFAULT_CLONE_ROOTS = [
  'repos',
  'code',
  'src',
  'projects',
  'dev',
  'Developer',
  'git',
  'workspace',
];

/** How deep below a root to look: the root itself (0), its children (1) and theirs (2). */
const MAX_DEPTH = 2;
/** How many `git remote get-url` calls run at once. */
const ORIGIN_PARALLELISM = 8;

const isDir = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Finds clones of GitHub repositories under `roots`, up to two levels deep. Directories whose
 * origin is not on GitHub are skipped, a directory reached twice (symlinks) is reported once,
 * and unreadable directories are ignored. A clone is not searched for further clones.
 *
 * Only directories with a `.git` directory count. Worktrees and submodules have a `.git`
 * file instead, and are left out on purpose: they are not the repo's own copy.
 */
export async function findLocalClones(
  roots: string[],
  git: Pick<Git, 'originRepo'>,
): Promise<LocalClone[]> {
  const seen = new Set<string>();
  const candidates: string[] = [];

  const visit = async (dir: string, depth: number): Promise<void> => {
    let real: string;
    try {
      real = await realpath(dir);
    } catch {
      return;
    }
    if (seen.has(real) || !(await isDir(real))) return;
    seen.add(real);
    if (await isDir(join(real, '.git'))) {
      candidates.push(real);
      return;
    }
    if (depth >= MAX_DEPTH) return;
    let names: string[];
    try {
      names = await readdir(real);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      await visit(join(real, name), depth + 1);
    }
  };
  for (const root of roots) await visit(root, 0);

  // Read the origins a few at a time; results stay in scan order.
  const found: (LocalClone | undefined)[] = new Array(candidates.length).fill(undefined);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < candidates.length) {
      const i = next++;
      const path = candidates[i]!;
      try {
        found[i] = { ...(await git.originRepo(path)), path };
      } catch {
        // No GitHub origin: not one of ours.
      }
    }
  };
  await Promise.all(Array.from({ length: ORIGIN_PARALLELISM }, worker));
  return found.filter((c): c is LocalClone => c !== undefined);
}

/**
 * Roots to scan: the parents of registered projects, then the usual code folders that exist.
 * The home directory itself is never a root, so a project directly in it does not make the
 * whole home directory get scanned.
 */
export function cloneRoots(
  projectPaths: string[],
  home: string = homedir(),
): { roots: string[]; cloneRoot: string } {
  const isDirSync = (p: string): boolean => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  const defaults = DEFAULT_CLONE_ROOTS.map((n) => join(home, n)).filter(isDirSync);
  const parents = projectPaths.map((p) => dirname(p)).filter((p) => p !== home);
  const roots = [...new Set([...parents, ...defaults])];
  return { roots, cloneRoot: defaults[0] ?? join(home, 'repos') };
}
