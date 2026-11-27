import { mkdtemp, lstat, readlink, writeFile, symlink, readdir, realpath } from 'node:fs/promises';
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
    expect(await readlink(join(dir, 'auth.json'))).toBe(await realpath(join(user, 'auth.json')));
    expect(((await lstat(dir)).mode & 0o777).toString(8)).toBe('700');
  });

  it('lets several runs set the home up at the same moment', async () => {
    const { user, dir } = await setup();
    await writeFile(join(user, 'auth.json'), '{}');
    const dirs = await Promise.all(
      [1, 2, 3, 4].map(() => ensureReviewerCodexHome({ dir, userCodexHome: user })),
    );
    expect(dirs).toEqual([dir, dir, dir, dir]);
    expect(await readdir(dir)).toEqual(['auth.json']);
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
    expect(await readlink(join(dir, 'auth.json'))).toBe(await realpath(join(user, 'auth.json')));
  });

  it('throws on a regular auth.json', async () => {
    const { user, dir } = await setup();
    await writeFile(join(user, 'auth.json'), '{}');
    await ensureReviewerCodexHome({ dir, userCodexHome: user });
    const { unlink } = await import('node:fs/promises');
    await unlink(join(dir, 'auth.json'));
    await writeFile(join(dir, 'auth.json'), 'real');
    await expect(ensureReviewerCodexHome({ dir, userCodexHome: user })).rejects.toThrow(
      /regular file/,
    );
  });

  it('chmods an existing dir and rejects customization entries', async () => {
    const { user, dir } = await setup();
    await writeFile(join(user, 'auth.json'), '{}');
    const { mkdir, chmod } = await import('node:fs/promises');
    await mkdir(dir);
    await chmod(dir, 0o755);
    await mkdir(join(dir, 'sessions'));
    await ensureReviewerCodexHome({ dir, userCodexHome: user });
    expect(((await lstat(dir)).mode & 0o777).toString(8)).toBe('700');
    await writeFile(join(dir, 'config.toml'), '');
    await expect(ensureReviewerCodexHome({ dir, userCodexHome: user })).rejects.toThrow(
      /config\.toml/,
    );
  });

  it('links to the realpath of a symlinked user auth.json', async () => {
    const { root, user, dir } = await setup();
    await writeFile(join(root, 'real.json'), '{}');
    await symlink(join(root, 'real.json'), join(user, 'auth.json'));
    await ensureReviewerCodexHome({ dir, userCodexHome: user });
    expect(await readlink(join(dir, 'auth.json'))).toBe(await realpath(join(root, 'real.json')));
  });

  it('accepts the layout codex leaves behind after a run', async () => {
    const { user, dir } = await setup();
    await writeFile(join(user, 'auth.json'), '{}');
    await ensureReviewerCodexHome({ dir, userCodexHome: user });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'skills/.system/review-agent'), { recursive: true });
    await mkdir(join(dir, 'plugins'));
    await mkdir(join(dir, 'cache'));
    await writeFile(join(dir, 'installation_id'), 'x');
    await ensureReviewerCodexHome({ dir, userCodexHome: user });
  });

  it('rejects user-installed skills', async () => {
    const { user, dir } = await setup();
    await writeFile(join(user, 'auth.json'), '{}');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'skills/.system'), { recursive: true });
    await mkdir(join(dir, 'skills/my-skill'));
    await expect(ensureReviewerCodexHome({ dir, userCodexHome: user })).rejects.toThrow(
      /skills\/my-skill/,
    );
  });
});
