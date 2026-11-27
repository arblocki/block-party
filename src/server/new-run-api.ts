import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { createGit, type Git } from '../core/git/index.js';
import type { GitHubClient } from '../core/github/types.js';
import { parseRepoRef } from '../core/pr-ref.js';
import type { Project, RunStore } from '../core/store/runs.js';
import { cloneRoots, findLocalClones, type LocalClone } from './local-clones.js';
import { parseBody } from './state.js';

export interface NewRunApiDeps {
  runs: RunStore;
  github: Pick<GitHubClient, 'listRepos'>;
  git?: Pick<Git, 'repoRoot' | 'originRepo' | 'defaultBranch'> & Partial<Pick<Git, 'clone'>>;
  /** Home directory the usual code folders are looked up in (default: the user's). */
  homeDir?: string;
  /** Clock for the clone-list cache (default `Date.now`). */
  now?: () => number;
}

/** One repo in the new-run form. */
export interface NewRunRepo {
  owner: string;
  repo: string;
  private: boolean;
  pushedAt: string | null;
  /** Known only for a registered project. */
  defaultBranch: string | null;
  /** Real paths of the clones on this computer. */
  clones: string[];
  /** The registered project (most recently used) for this repo, if any. */
  projectId: string | null;
  lastUsedAt: string | null;
}

const CACHE_MS = 60_000;
const key = (owner: string, repo: string): string => `${owner}/${repo}`.toLowerCase();
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const prepareSchema = z.strictObject({
  owner: z.string().trim().min(1),
  repo: z.string().trim().min(1),
  clonePath: z.string().trim().min(1).optional(),
});

/** An unusable request, with an optional command the person can run by hand. */
class PrepareError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 409 | 502,
    readonly command?: string,
  ) {
    super(message);
  }
}

export function registerNewRunApi(app: Hono, deps: NewRunApiDeps): void {
  const { runs, github } = deps;
  const git = deps.git ?? createGit();
  const home = deps.homeDir ?? homedir();
  const now = deps.now ?? Date.now;
  const clone = git.clone ?? createGit().clone;

  let cache: { at: number; clones: LocalClone[] } | undefined;
  const locate = async (refresh: boolean) => {
    const { roots, cloneRoot } = cloneRoots(
      runs.listProjects().map((p) => p.localPath),
      home,
    );
    if (refresh || !cache || now() - cache.at > CACHE_MS) {
      cache = { at: now(), clones: await findLocalClones(roots, git) };
    }
    return { clones: cache.clones, cloneRoot };
  };

  /** When each project was last used: its newest run, else when it was registered. */
  const lastUsed = (projects: Project[]): Map<string, string> => {
    const out = new Map(projects.map((p) => [p.id, p.updatedAt]));
    for (const r of runs.listRuns({ limit: 500 })) {
      if ((out.get(r.projectId) ?? '') < r.createdAt) out.set(r.projectId, r.createdAt);
    }
    return out;
  };

  const newestFirst = (projects: Project[]): Project[] => {
    const used = lastUsed(projects);
    return [...projects].sort((a, b) => (used.get(b.id)! < used.get(a.id)! ? -1 : 1));
  };

  app.get('/api/new-run/repos', async (c) => {
    let listed;
    try {
      listed = await github.listRepos();
    } catch (e) {
      return c.json({ error: `could not list your repositories: ${errorMessage(e)}` }, 502);
    }
    const { clones, cloneRoot } = await locate(c.req.query('refresh') === '1');
    const projects = runs.listProjects();
    const used = lastUsed(projects);

    const rows = new Map<string, NewRunRepo>();
    for (const r of listed) {
      rows.set(key(r.owner, r.name), {
        owner: r.owner,
        repo: r.name,
        private: r.private,
        pushedAt: r.pushedAt,
        defaultBranch: null,
        clones: [],
        projectId: null,
        lastUsedAt: null,
      });
    }
    const rowFor = (owner: string, repo: string): NewRunRepo | undefined => {
      return rows.get(key(owner, repo));
    };
    for (const lc of clones) {
      const row = rowFor(lc.owner, lc.repo);
      if (row && !row.clones.includes(lc.path)) row.clones.push(lc.path);
    }
    for (const p of newestFirst(projects)) {
      let row = rowFor(p.owner, p.repo);
      if (!row) {
        // Registered, but GitHub does not list it for this viewer.
        row = {
          owner: p.owner,
          repo: p.repo,
          private: false,
          pushedAt: null,
          defaultBranch: null,
          clones: [],
          projectId: null,
          lastUsedAt: null,
        };
        rows.set(key(p.owner, p.repo), row);
      }
      if (!row.clones.includes(p.localPath)) row.clones.push(p.localPath);
      if (row.projectId === null) {
        row.projectId = p.id;
        row.defaultBranch = p.defaultBase;
        row.lastUsedAt = used.get(p.id) ?? null;
      }
    }

    const rank = (r: NewRunRepo): number => (r.projectId ? 0 : r.clones.length > 0 ? 1 : 2);
    const repos = [...rows.values()].sort((a, b) => {
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      if (rank(a) === 0) return (b.lastUsedAt ?? '') < (a.lastUsedAt ?? '') ? -1 : 1;
      return (b.pushedAt ?? '') < (a.pushedAt ?? '')
        ? -1
        : (b.pushedAt ?? '') > (a.pushedAt ?? '')
          ? 1
          : 0;
    });
    return c.json({ repos, cloneRoot });
  });

  const register = async (path: string): Promise<Project> => {
    const localPath = await git.repoRoot(path);
    const origin = await git.originRepo(localPath);
    const defaultBase = await git.defaultBranch(localPath);
    return runs.upsertProject({ ...origin, localPath, defaultBase });
  };

  const inFlight = new Map<string, Promise<Project>>();

  const prepare = async (
    owner: string,
    repo: string,
    clonePath: string | undefined,
  ): Promise<Project> => {
    const k = key(owner, repo);
    const existing = newestFirst(runs.listProjects().filter((p) => key(p.owner, p.repo) === k));
    if (existing.length > 0) {
      if (clonePath === undefined) return existing[0]!;
      const wanted = realOrSame(clonePath);
      const match = existing.find((p) => p.localPath === wanted);
      if (match) return match;
    }

    let listed;
    try {
      listed = await github.listRepos();
    } catch (e) {
      throw new PrepareError(`could not list your repositories: ${errorMessage(e)}`, 502);
    }
    const canonical = listed.find((r) => key(r.owner, r.name) === k);
    if (!canonical) {
      throw new PrepareError(`${owner}/${repo} is not one of the repositories you can access`, 403);
    }

    const { clones: all, cloneRoot } = await locate(true);
    const clones = all.filter((c) => key(c.owner, c.repo) === k);
    if (clonePath !== undefined) {
      const wanted = realOrSame(clonePath);
      if (!clones.some((c) => c.path === wanted)) {
        throw new PrepareError(`${clonePath} is not a copy of ${owner}/${repo}`, 400);
      }
      return register(wanted);
    }
    if (clones.length === 1) return register(clones[0]!.path);
    if (clones.length > 1) {
      throw new PrepareError(
        `there is more than one copy of ${owner}/${repo} on this computer; choose which one to use`,
        400,
      );
    }

    // Not on this computer yet: clone it, as the person would with `git clone`.
    const url = `https://github.com/${canonical.owner}/${canonical.name}.git`;
    const plain = join(cloneRoot, canonical.name);
    const dest =
      existsSync(plain) && !(await isThisRepo(plain, k))
        ? join(cloneRoot, `${canonical.owner}-${canonical.name}`)
        : plain;
    const command = `git clone ${url} ${dest}`;
    if (existsSync(dest)) {
      if (await isThisRepo(dest, k)) return register(dest);
      throw new PrepareError(
        `${dest} already exists and is not a copy of ${owner}/${repo}; move it or clone by hand`,
        409,
        command,
      );
    }
    try {
      mkdirSync(cloneRoot, { recursive: true });
      await clone(url, dest);
      if (!(await isThisRepo(dest, k))) {
        throw new Error(`the clone at ${dest} does not point at ${owner}/${repo}`);
      }
      const project = await register(dest);
      cache = undefined;
      return project;
    } catch (e) {
      throw new PrepareError(`could not clone ${owner}/${repo}: ${errorMessage(e)}`, 502, command);
    }
  };

  const isThisRepo = async (path: string, k: string): Promise<boolean> => {
    try {
      const o = await git.originRepo(path);
      return key(o.owner, o.repo) === k;
    } catch {
      return false;
    }
  };

  app.post('/api/new-run/prepare', async (c: Context) => {
    const body = await parseBody(c, prepareSchema);
    if ('error' in body) return c.json({ error: body.error }, 400);
    const ref = parseRepoRef(`${body.data.owner}/${body.data.repo}`);
    if (!ref || ref.repo !== body.data.repo) return c.json({ error: 'invalid repository' }, 400);
    // Two picks of the same repo and copy share one clone.
    const k = `${key(ref.owner, ref.repo)}|${body.data.clonePath ?? ''}`;
    let work = inFlight.get(k);
    if (!work) {
      work = prepare(ref.owner, ref.repo, body.data.clonePath).finally(() => inFlight.delete(k));
      inFlight.set(k, work);
    }
    try {
      return c.json({ project: await work });
    } catch (e) {
      if (e instanceof PrepareError) {
        return c.json({ error: e.message, ...(e.command ? { command: e.command } : {}) }, e.status);
      }
      return c.json({ error: `could not prepare the repository: ${errorMessage(e)}` }, 500);
    }
  });
}

function realOrSame(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
