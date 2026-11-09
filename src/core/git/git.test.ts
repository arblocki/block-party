import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGit, parseOriginUrl, type GitRunner } from './git.js';

const git = createGit();
let root: string;
let bare: string;
let clone: string;

const sh = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=t@example.com',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'init.defaultBranch=main',
      ...args,
    ],
    { cwd, encoding: 'utf8' },
  ).trim();

const commit = (cwd: string, file: string, msg: string) => {
  writeFileSync(join(cwd, file), msg);
  sh(cwd, 'add', '-A');
  sh(cwd, 'commit', '-m', msg);
  return sh(cwd, 'rev-parse', 'HEAD');
};

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'bp-git-')));
  bare = join(root, 'origin.git');
  clone = join(root, 'clone');
  mkdirSync(bare);
  sh(bare, 'init', '--bare', '-b', 'main');
  sh(root, 'clone', bare, clone);
  sh(clone, 'checkout', '-B', 'main');
  commit(clone, 'a.txt', 'first');
  sh(clone, 'push', '-u', 'origin', 'main');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('parseOriginUrl', () => {
  it.each([
    ['git@github.com:o/r.git', { owner: 'o', repo: 'r' }],
    ['https://github.com/o/r', { owner: 'o', repo: 'r' }],
    ['https://github.com/o/r.git', { owner: 'o', repo: 'r' }],
    ['https://github.com/o/my.repo.git/', { owner: 'o', repo: 'my.repo' }],
    ['ssh://git@github.com/o/r.git', { owner: 'o', repo: 'r' }],
    ['https://x-access-token:abc@github.com/o/r.git', { owner: 'o', repo: 'r' }],
  ])('parses %s', (url, expected) => {
    expect(parseOriginUrl(url)).toEqual(expected);
  });
  it('rejects non-GitHub or malformed urls', () => {
    expect(parseOriginUrl('https://gitlab.com/o/r.git')).toBeUndefined();
    expect(parseOriginUrl('/some/local/path')).toBeUndefined();
  });
});

describe('git service', () => {
  it('repoRoot resolves the toplevel', async () => {
    mkdirSync(join(clone, 'sub'), { recursive: true });
    expect(await git.repoRoot(join(clone, 'sub'))).toBe(clone);
  });

  it('originRepo throws when origin is not a GitHub URL', async () => {
    await expect(git.originRepo(clone)).rejects.toThrow(/Cannot parse/);
    const noRemote = mkdtempSync(join(root, 'nr-'));
    sh(noRemote, 'init');
    await expect(git.originRepo(noRemote)).rejects.toThrow();
  });

  it('originRepo parses the remote url', async () => {
    const r = mkdtempSync(join(root, 'gh-'));
    sh(r, 'init');
    sh(r, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
    expect(await git.originRepo(r)).toEqual({ owner: 'acme', repo: 'widgets' });
  });

  it('fetchBase uses origin when present and local otherwise', async () => {
    const head = sh(clone, 'rev-parse', 'HEAD');
    expect(await git.fetchBase(clone, 'main')).toEqual({ sha: head, source: 'origin' });

    const local = mkdtempSync(join(root, 'local-'));
    sh(local, 'init', '-b', 'main');
    const sha = commit(local, 'x', 'x');
    expect(await git.fetchBase(local, 'main')).toEqual({ sha, source: 'local' });
  });

  it('fetchBase fails clearly when origin exists but the fetch fails', async () => {
    const r = mkdtempSync(join(root, 'bad-'));
    sh(r, 'init', '-b', 'main');
    commit(r, 'x', 'x');
    sh(r, 'remote', 'add', 'origin', join(root, 'does-not-exist.git'));
    await expect(git.fetchBase(r, 'main')).rejects.toThrow(/git fetch failed/);
  });

  it('rejects invalid branch names', async () => {
    await expect(git.fetchBase(clone, 'bad..name')).rejects.toThrow(/Invalid branch/);
    await expect(git.fetchBase(clone, '--upload-pack=x')).rejects.toThrow(/Invalid branch/);
  });

  it('createWorktree creates a branch and refuses existing path or branch', async () => {
    const base = sh(clone, 'rev-parse', 'HEAD');
    const wt = join(root, 'wt1');
    await git.createWorktree({ repo: clone, path: wt, branch: 'bp/one', baseSha: base });
    expect(existsSync(join(wt, 'a.txt'))).toBe(true);
    expect(sh(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('bp/one');

    await expect(
      git.createWorktree({ repo: clone, path: wt, branch: 'bp/two', baseSha: base }),
    ).rejects.toThrow(/path already exists/);
    await expect(
      git.createWorktree({ repo: clone, path: join(root, 'wt2'), branch: 'bp/one', baseSha: base }),
    ).rejects.toThrow(/Branch already exists/);
    await expect(
      git.createWorktree({ repo: clone, path: join(root, 'wt3'), branch: 'a..b', baseSha: base }),
    ).rejects.toThrow(/Invalid branch/);
  });

  it('tracks head, cleanliness, status, commits and diffstat in a worktree', async () => {
    const base = sh(clone, 'rev-parse', 'HEAD');
    const wt = join(root, 'wt-work');
    await git.createWorktree({ repo: clone, path: wt, branch: 'bp/work', baseSha: base });
    expect(await git.headSha(wt)).toBe(base);
    expect(await git.isClean(wt)).toBe(true);

    writeFileSync(join(wt, 'untracked.txt'), 'u');
    expect(await git.isClean(wt)).toBe(false);
    expect(await git.statusLines(wt)).toEqual(['?? untracked.txt']);
    writeFileSync(join(wt, 'a.txt'), 'changed');
    expect((await git.statusLines(wt)).sort()).toEqual([' M a.txt', '?? untracked.txt']);

    expect(await git.diffStat(wt, base, base)).toEqual({ files: 0, insertions: 0, deletions: 0 });
    commit(wt, 'b.txt', 'second');
    const head = commit(wt, 'c.txt', 'third');
    expect(await git.isClean(wt)).toBe(true);
    expect(await git.commitsBetween(wt, base, head)).toEqual([
      { sha: expect.stringMatching(/^[0-9a-f]{40}$/), subject: 'second' },
      { sha: head, subject: 'third' },
    ]);
    expect(await git.diffStat(wt, base, head)).toEqual({
      files: 4,
      insertions: 4,
      deletions: 1,
    });
  });

  it('pushBranch pushes to the bare remote and remoteBranchSha matches', async () => {
    const base = sh(clone, 'rev-parse', 'HEAD');
    const wt = join(root, 'wt-push');
    await git.createWorktree({ repo: clone, path: wt, branch: 'bp/push', baseSha: base });
    expect(await git.remoteBranchSha(wt, 'bp/push')).toBeUndefined();
    const head = commit(wt, 'p.txt', 'pushed');
    await git.pushBranch(wt, 'bp/push');
    expect(await git.remoteBranchSha(wt, 'bp/push')).toBe(head);
    expect(sh(bare, 'rev-parse', 'refs/heads/bp/push')).toBe(head);
  });

  it('never passes --force when pushing', async () => {
    const calls: string[][] = [];
    const runner: GitRunner = (args) => {
      calls.push(args);
      return Promise.resolve({ stdout: '', stderr: '', code: 0 });
    };
    await createGit(runner).pushBranch('/x', 'feat/y');
    const push = calls.find((c) => c[0] === 'push');
    expect(push).toEqual(['push', '-u', 'origin', 'feat/y:refs/heads/feat/y']);
  });
});
