import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}
export type GitRunner = (args: string[], opts: { cwd: string }) => Promise<GitResult>;

export const defaultRunner: GitRunner = (args, { cwd }) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        timeout: 120_000,
        maxBuffer: 64 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (!err) return resolve({ stdout, stderr, code: 0 });
        const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
        if (typeof e.code === 'number') return resolve({ stdout, stderr, code: e.code });
        reject(e);
      },
    );
  });

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly stderr: string,
    readonly code: number,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export interface OriginRepo {
  owner: string;
  repo: string;
}

/** Parses ssh (`git@github.com:o/r.git`) and https (`https://github.com/o/r(.git)`) remotes. */
export function parseOriginUrl(url: string): OriginRepo | undefined {
  const u = url.trim();
  const m =
    /^(?:[\w.-]+@)?github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(u) ??
    /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(
      u,
    );
  if (!m?.[1] || !m[2]) return undefined;
  return { owner: m[1], repo: m[2] };
}

export interface CreateWorktreeOptions {
  repo: string;
  path: string;
  branch: string;
  baseSha: string;
}

export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
}

export function createGit(runner: GitRunner = defaultRunner) {
  const run = async (cwd: string, args: string[]): Promise<string> => {
    const r = await runner(args, { cwd });
    if (r.code !== 0) {
      throw new GitError(
        `git ${args[0] ?? ''} failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`,
        args,
        r.stderr,
        r.code,
      );
    }
    return r.stdout;
  };
  const ok = async (cwd: string, args: string[]): Promise<boolean> =>
    (await runner(args, { cwd })).code === 0;

  async function hasOrigin(cwd: string): Promise<boolean> {
    return ok(cwd, ['remote', 'get-url', 'origin']);
  }

  async function assertBranchName(cwd: string, branch: string): Promise<void> {
    if (branch.startsWith('-') || !(await ok(cwd, ['check-ref-format', '--branch', branch]))) {
      throw new Error(`Invalid branch name: ${JSON.stringify(branch)}`);
    }
  }

  return {
    async repoRoot(cwd: string): Promise<string> {
      return realpathSync((await run(cwd, ['rev-parse', '--show-toplevel'])).trim());
    },

    async originRepo(cwd: string): Promise<OriginRepo> {
      const url = (await run(cwd, ['remote', 'get-url', 'origin'])).trim();
      const parsed = parseOriginUrl(url);
      if (!parsed) throw new Error(`Cannot parse a GitHub owner/repo from origin URL: ${url}`);
      return parsed;
    },

    async fetchBase(
      repo: string,
      baseRef: string,
    ): Promise<{ sha: string; source: 'origin' | 'local' }> {
      await assertBranchName(repo, baseRef);
      if (await hasOrigin(repo)) {
        // Explicit refspec: single-branch clones only map their own branch, so a plain
        // `fetch origin <ref>` would not create or update refs/remotes/origin/<ref>.
        const tracking = `refs/remotes/origin/${baseRef}`;
        await run(repo, ['fetch', 'origin', `+refs/heads/${baseRef}:${tracking}`]);
        const sha = (await run(repo, ['rev-parse', `${tracking}^{commit}`])).trim();
        return { sha, source: 'origin' };
      }
      const sha = (await run(repo, ['rev-parse', `${baseRef}^{commit}`])).trim();
      return { sha, source: 'local' };
    },

    async createWorktree(opts: CreateWorktreeOptions): Promise<void> {
      const { repo, path, branch, baseSha } = opts;
      await assertBranchName(repo, branch);
      if (existsSync(path)) throw new Error(`Worktree path already exists: ${path}`);
      if (await ok(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) {
        throw new Error(`Branch already exists: ${branch}`);
      }
      await run(repo, ['worktree', 'add', '-b', branch, path, baseSha]);
    },

    async headSha(cwd: string): Promise<string> {
      return (await run(cwd, ['rev-parse', 'HEAD'])).trim();
    },

    async statusLines(cwd: string): Promise<string[]> {
      const out = await run(cwd, ['status', '--porcelain=v1', '--untracked-files=all']);
      return out.split('\n').filter((l) => l.length > 0);
    },

    async isClean(cwd: string): Promise<boolean> {
      return (await this.statusLines(cwd)).length === 0;
    },

    async commitsBetween(
      cwd: string,
      base: string,
      head: string,
    ): Promise<{ sha: string; subject: string }[]> {
      const out = await run(cwd, [
        'log',
        '--reverse',
        '--format=%H%x09%s',
        `${base}..${head}`,
        '--',
      ]);
      return out
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => {
          const i = l.indexOf('\t');
          return { sha: l.slice(0, i), subject: l.slice(i + 1) };
        });
    },

    async diffStat(cwd: string, base: string, head: string): Promise<DiffStat> {
      const out = await run(cwd, ['diff', '--shortstat', base, head, '--']);
      const num = (re: RegExp) => Number(re.exec(out)?.[1] ?? 0);
      return {
        files: num(/(\d+) files? changed/),
        insertions: num(/(\d+) insertions?\(\+\)/),
        deletions: num(/(\d+) deletions?\(-\)/),
      };
    },

    async pushBranch(cwd: string, branch: string): Promise<void> {
      await assertBranchName(cwd, branch);
      await run(cwd, ['push', '-u', 'origin', `${branch}:refs/heads/${branch}`]);
    },

    async remoteBranchSha(cwd: string, branch: string): Promise<string | undefined> {
      await assertBranchName(cwd, branch);
      const out = await run(cwd, ['ls-remote', 'origin', `refs/heads/${branch}`]);
      const line = out.split('\n').find((l) => l.trim().length > 0);
      return line?.split(/\s+/)[0] || undefined;
    },
  };
}

export type Git = ReturnType<typeof createGit>;
