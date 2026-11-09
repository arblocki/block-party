import { mkdtemp, lstat, readlink, writeFile, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureReviewerCodexHome } from './codex-home.js';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'bp-chome-'));
  const user = join(root, 'user');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(user);
  return { root, user, dir: join(root, 'home') };
}

describe('ensureReviewerCodexHome', () => {
  it('creates a dir with only an auth.json symlink', async () => {
    const { user, dir } = await setup();
    await writeFile(join(user, 'auth.json'), '{}');
    await ensureReviewerCodexHome({ dir, userCodexHome: user });
    expect(await readdir(dir)).toEqual(['auth.json']);
    expect((await lstat(join(dir, 'auth.json'))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(dir, 'auth.json'))).toBe(join(user, 'auth.json'));
    expect(((await lstat(dir)).mode & 0o777).toString(8)).toBe('700');
  });

  it('throws when the user auth.json is missing', async () => {
    const { user, dir } = await setup();
    await expect(ensureReviewerCodexHome({ dir, userCodexHome: user })).rejects.toThrow(
      /codex login/,
    );
  });

  it('replaces a stale symlink but leaves a real file alone', async () => {
    const { root, user, dir } = await setup();
    await writeFile(join(user, 'auth.json'), '{}');
    await ensureReviewerCodexHome({ dir, userCodexHome: user });
    const { unlink } = await import('node:fs/promises');
    await unlink(join(dir, 'auth.json'));
    await symlink(join(root, 'elsewhere'), join(dir, 'auth.json'));
    await ensureReviewerCodexHome({ dir, userCodexHome: user });
    expect(await readlink(join(dir, 'auth.json'))).toBe(join(user, 'auth.json'));
    await unlink(join(dir, 'auth.json'));
    await writeFile(join(dir, 'auth.json'), 'real');
    await ensureReviewerCodexHome({ dir, userCodexHome: user });
    expect((await lstat(join(dir, 'auth.json'))).isSymbolicLink()).toBe(false);
  });
});
