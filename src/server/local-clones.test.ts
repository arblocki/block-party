import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cloneRoots, findLocalClones } from './local-clones.js';

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'bp-clones-')));
const repoDir = (path: string) => mkdirSync(join(path, '.git'), { recursive: true });

/** Origins by directory name; a missing name has no GitHub origin. */
const fakeGit = (origins: Record<string, string>) => ({
  async originRepo(cwd: string) {
    const o = origins[basename(cwd)];
    if (!o) throw new Error('no GitHub origin');
    const [owner, repo] = o.split('/') as [string, string];
    return { owner, repo };
  },
});

describe('findLocalClones', () => {
  it('finds clones in the root, one level down and two levels down, but not deeper', async () => {
    const root = tmp();
    repoDir(join(root, 'a'));
    repoDir(join(root, 'org', 'b'));
    repoDir(join(root, 'x', 'y', 'too-deep'));
    const found = await findLocalClones(
      [root],
      fakeGit({ a: 'me/a', b: 'org/b', 'too-deep': 'me/deep' }),
    );
    expect(found).toEqual([
      { owner: 'me', repo: 'a', path: join(root, 'a') },
      { owner: 'org', repo: 'b', path: join(root, 'org', 'b') },
    ]);
  });

  it('treats the root itself as a clone when it is one', async () => {
    const root = tmp();
    repoDir(root);
    const found = await findLocalClones([root], fakeGit({ [basename(root)]: 'me/r' }));
    expect(found).toEqual([{ owner: 'me', repo: 'r', path: root }]);
  });

  it('skips directories without a GitHub origin and does not search inside clones', async () => {
    const root = tmp();
    repoDir(join(root, 'plain'));
    repoDir(join(root, 'mine'));
    repoDir(join(root, 'mine', 'vendored'));
    const found = await findLocalClones([root], fakeGit({ mine: 'me/mine', vendored: 'x/y' }));
    expect(found.map((f) => f.repo)).toEqual(['mine']);
  });

  it('reports a clone once when it is reached through a symlink or an overlapping root', async () => {
    const root = tmp();
    repoDir(join(root, 'real'));
    symlinkSync(join(root, 'real'), join(root, 'alias'));
    const found = await findLocalClones(
      [root, root, join(root, 'real')],
      fakeGit({ real: 'me/r' }),
    );
    expect(found).toEqual([{ owner: 'me', repo: 'r', path: join(root, 'real') }]);
  });

  it('survives missing roots, dangling links and unreadable directories', async () => {
    const root = tmp();
    repoDir(join(root, 'ok'));
    symlinkSync(join(root, 'nowhere'), join(root, 'dangling'));
    const locked = join(root, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    try {
      const found = await findLocalClones([join(root, 'missing'), root], fakeGit({ ok: 'me/ok' }));
      expect(found.map((f) => f.repo)).toEqual(['ok']);
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});

describe('cloneRoots', () => {
  it('uses registered projects parents and the default folders that exist', () => {
    const home = tmp();
    mkdirSync(join(home, 'code'));
    mkdirSync(join(home, 'Developer'));
    const r = cloneRoots(['/work/a/one', '/work/a/two'], home);
    expect(r.roots).toEqual(['/work/a', join(home, 'code'), join(home, 'Developer')]);
    expect(r.cloneRoot).toBe(join(home, 'code'));
  });

  it('never scans the home directory itself', () => {
    const home = tmp();
    expect(cloneRoots([join(home, 'loose-project')], home).roots).toEqual([]);
  });

  it('falls back to ~/repos for cloning when no default folder exists', () => {
    const home = tmp();
    expect(cloneRoots([], home)).toEqual({ roots: [], cloneRoot: join(home, 'repos') });
  });
});
