import { lstat, mkdir, readlink, symlink, unlink, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dataDir } from '../paths.js';

export interface EnsureCodexHomeOptions {
  dir?: string;
  userCodexHome?: string;
}

/**
 * Create a minimal CODEX_HOME for the reviewer: only a symlink `auth.json` to the user's, so
 * token refreshes are shared but no user skills, config, or MCP servers are visible.
 */
export async function ensureReviewerCodexHome(opts: EnsureCodexHomeOptions = {}): Promise<string> {
  const dir = opts.dir ?? join(dataDir(), 'codex-home');
  const userHome = opts.userCodexHome ?? (process.env.CODEX_HOME || join(homedir(), '.codex'));
  const userAuth = join(userHome, 'auth.json');
  const exists = await stat(userAuth).then(
    () => true,
    () => false,
  );
  if (!exists) {
    throw new Error(`Codex auth not found at ${userAuth}. Run \`codex login\` first.`);
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const link = join(dir, 'auth.json');
  const info = await lstat(link).catch(() => undefined);
  if (info) {
    if (!info.isSymbolicLink()) return dir; // a real file: leave it alone
    if ((await readlink(link)) === userAuth) return dir;
    await unlink(link);
  }
  await symlink(userAuth, link);
  return dir;
}
