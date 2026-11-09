import { chmod, lstat, mkdir, readlink, realpath, symlink, unlink } from 'node:fs/promises';
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
  const requested = join(userHome, 'auth.json');
  const userAuth = await realpath(requested).catch(() => undefined);
  if (!userAuth) {
    throw new Error(`Codex auth not found at ${requested}. Run \`codex login\` first.`);
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  for (const name of ['config.toml', 'AGENTS.md', 'skills', 'prompts', 'rules']) {
    if (
      await lstat(join(dir, name)).then(
        () => true,
        () => false,
      )
    ) {
      throw new Error(
        `Reviewer CODEX_HOME ${dir} contains ${name}; remove it so the reviewer runs without user customization.`,
      );
    }
  }
  const link = join(dir, 'auth.json');
  const info = await lstat(link).catch(() => undefined);
  if (info) {
    if (!info.isSymbolicLink()) {
      throw new Error(
        `${link} is a regular file, not a symlink to the user's auth.json; remove it and retry.`,
      );
    }
    if ((await readlink(link)) === userAuth) return dir;
    await unlink(link);
  }
  await symlink(userAuth, link);
  return dir;
}
