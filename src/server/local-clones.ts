import { readdirSync, realpathSync, statSync } from 'node:fs';
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

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Finds clones of GitHub repositories under `roots`, up to two levels deep. Directories whose
 * origin is not on GitHub are skipped, a directory reached twice (symlinks) is reported once,
 * and unreadable directories are ignored. A clone is not searched for further clones.
 */
export async function findLocalClones(
  roots: string[],
  git: Pick<Git, 'originRepo'>,
): Promise<LocalClone[]> {
  const seen = new Set<string>();
  const found: LocalClone[] = [];

  const visit = async (dir: string, depth: number): Promise<void> => {
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      return;
    }
    if (seen.has(real) || !isDir(real)) return;
    seen.add(real);
    if (isDir(join(real, '.git'))) {
      try {
        const origin = await git.originRepo(real);
        found.push({ ...origin, path: real });
      } catch {
        // No GitHub origin: not one of ours.
      }
      return;
    }
    if (depth >= MAX_DEPTH) return;
    let names: string[];
    try {
      names = readdirSync(real);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      await visit(join(real, name), depth + 1);
    }
  };

  for (const root of roots) await visit(root, 0);
  return found;
}

/** Roots to scan: the parents of registered projects, then the usual code folders that exist. */
export function cloneRoots(
  projectPaths: string[],
  home: string = homedir(),
): { roots: string[]; cloneRoot: string } {
  const defaults = DEFAULT_CLONE_ROOTS.map((n) => join(home, n)).filter(isDir);
  const roots = [...new Set([...projectPaths.map((p) => dirname(p)), ...defaults])];
  return { roots, cloneRoot: defaults[0] ?? join(home, 'repos') };
}
