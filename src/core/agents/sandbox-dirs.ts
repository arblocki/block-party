import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Directories outside the worktree that package installs and checks write to, which a
 * sandboxed run must be allowed to write: pnpm's content-addressable store at its default
 * locations (`pnpm store path` prints one of these unless the user configured another; put
 * that in `policy.sandboxAllowWrite`). Only directories that exist are returned.
 */
export function pnpmStoreDirs(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  exists: (p: string) => boolean = existsSync,
): string[] {
  const candidates = [
    ...(env.PNPM_HOME ? [join(env.PNPM_HOME, 'store')] : []),
    join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'pnpm', 'store'),
    join(home, 'Library', 'pnpm', 'store'),
  ];
  return [...new Set(candidates)].filter(exists);
}
