import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { z } from 'zod';
import { createGit, type Git } from '../core/git/index.js';
import type { GitHubClient } from '../core/github/types.js';
import type { NewRunRepo } from '../core/new-run-types.js';
import { parseRepoRef } from '../core/pr-ref.js';
import type { Project, RunStore } from '../core/store/runs.js';
import { cloneRoots, findLocalClones, type LocalClone } from './local-clones.js';
import { parseBody } from './state.js';

export type { NewRunRepo };

export interface NewRunApiDeps {
  runs: RunStore;
  github: Pick<GitHubClient, 'listRepos'>;
  git?: Pick<Git, 'repoRoot' | 'originRepo' | 'defaultBranch'> & Partial<Pick<Git, 'clone'>>;
  /** Home directory the usual code folders are looked up in (default: the user's). */
  homeDir?: string;
  /** Clock for the clone-list cache (default `Date.now`). */
  now?: () => number;
  /**
   * Runs a clone one at a time per repository (the run manager's lock, keyed `repo:owner/name`),
   * so two prepares of the same repository never clone it together. The key is not a project
   * id: a clone creates a new directory, so it has no main clone to share with a run's `fetch`
   * or `worktree add`.
   */
  lockProject?: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
}

const CACHE_MS = 60_000;
const key = (owner: string, repo: string): string => `${owner}/${repo}`.toLowerCase();
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Orders strings descending, with 0 for equal values (and `null` last). */
const byDesc = (a: string | null, b: string | null): number =>
  (b ?? '') < (a ?? '') ? -1 : (b ?? '') > (a ?? '') ? 1 : 0;

/** Quotes a word for a shell, unless it is plain already. */
const shellQuote = (word: string): string =>
  /^[\w./:@%+=,-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

const prepareSchema = z.strictObject({
  owner: z.string().trim().min(1),
  repo: z.string().trim().min(1),
  clonePath: z.string().trim().min(1).optional(),
});

/** A request that cannot be served, with an optional command the person can run by hand. */
class PrepareError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 409 | 500 | 502,
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

  // The clone scan: cached for a minute, and concurrent requests share one scan.
  let cache: { at: number; clones: LocalClone[] } | undefined;
  let scanning: Promise<LocalClone[]> | undefined;
  const locate = async (refresh: boolean) => {
    const { roots, cloneRoot } = cloneRoots(
      runs.listProjects().map((p) => p.localPath),
      home,
    );
    if (!refresh && cache && now() - cache.at <= CACHE_MS)
      return { clones: cache.clones, cloneRoot };
    scanning ??= findLocalClones(roots, git)
      .then((clones) => {
        cache = { at: now(), clones };
        return clones;
      })
      .finally(() => {
        scanning = undefined;
      });
    return { clones: await scanning, cloneRoot };
  };

  const locateRoot = (): string =>
    cloneRoots(
      runs.listProjects().map((p) => p.localPath),
      home,
    ).cloneRoot;

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
    return [...projects].sort((a, b) => byDesc(used.get(a.id) ?? null, used.get(b.id) ?? null));
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
    for (const lc of clones) {
      const row = rows.get(key(lc.owner, lc.repo));
      if (row && !row.clones.includes(lc.path)) row.clones.push(lc.path);
    }
    for (const p of newestFirst(projects)) {
      let row = rows.get(key(p.owner, p.repo));
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
      if (row.projectId === null) {
        row.projectId = p.id;
        row.defaultBranch = p.defaultBase;
        row.lastUsedAt = used.get(p.id) ?? null;
        // The registered copy comes first, so it is the one chosen by default.
        row.clones = [p.localPath, ...row.clones.filter((c) => c !== p.localPath)];
      } else if (!row.clones.includes(p.localPath)) {
        row.clones.push(p.localPath);
      }
    }

    const rank = (r: NewRunRepo): number => (r.projectId ? 0 : r.clones.length > 0 ? 1 : 2);
    const repos = [...rows.values()].sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (rank(a) === 0 ? byDesc(a.lastUsedAt, b.lastUsedAt) : byDesc(a.pushedAt, b.pushedAt)),
    );
    return c.json({ repos, cloneRoot });
  });

  const isThisRepo = async (path: string, k: string): Promise<boolean> => {
    try {
      const o = await git.originRepo(path);
      return key(o.owner, o.repo) === k;
    } catch {
      return false;
    }
  };

  const register = async (path: string): Promise<Project> => {
    const localPath = await git.repoRoot(path);
    const origin = await git.originRepo(localPath);
    const defaultBase = await git.defaultBranch(localPath);
    return runs.upsertProject({ ...origin, localPath, defaultBase });
  };

  // Destinations being cloned right now, so two repos never race for one folder.
  const cloning = new Set<string>();

  const cloneAndRegister = async (
    canonical: { owner: string; name: string },
    k: string,
    cloneRoot: string,
  ): Promise<Project> => {
    const url = `https://github.com/${canonical.owner}/${canonical.name}.git`;
    const plain = join(cloneRoot, canonical.name);
    const dest =
      existsSync(plain) && !(await isThisRepo(plain, k))
        ? join(cloneRoot, `${canonical.owner}-${canonical.name}`)
        : plain;
    const command = `git clone ${shellQuote(url)} ${shellQuote(dest)}`;
    const label = `${canonical.owner}/${canonical.name}`;
    if (cloning.has(dest)) {
      throw new PrepareError(`${dest} is being cloned right now; try again in a moment`, 409);
    }
    cloning.add(dest);
    try {
      if (existsSync(dest)) {
        if (await isThisRepo(dest, k)) return await register(dest);
        throw new PrepareError(
          `${dest} already exists and is not a copy of ${label}; move it or clone by hand`,
          409,
          command,
        );
      }
      try {
        mkdirSync(cloneRoot, { recursive: true });
        await clone(url, dest);
        if (!(await isThisRepo(dest, k))) {
          throw new Error(`the clone at ${dest} does not point at ${label}`);
        }
      } catch (e) {
        throw new PrepareError(`could not clone ${label}: ${errorMessage(e)}`, 502, command);
      }
      try {
        const project = await register(dest);
        cache = undefined;
        return project;
      } catch (e) {
        // The clone worked; only setting it up failed, so a hand-run clone would not help.
        throw new PrepareError(`cloned ${label} but could not set it up: ${errorMessage(e)}`, 500);
      }
    } finally {
      cloning.delete(dest);
    }
  };

  const inFlight = new Map<string, Promise<Project>>();

  const prepare = async (
    owner: string,
    repo: string,
    clonePath: string | undefined,
  ): Promise<Project> => {
    const k = key(owner, repo);
    const existing = newestFirst(runs.listProjects().filter((p) => key(p.owner, p.repo) === k));
    const registered = (): Project | undefined => {
      if (existing.length === 0) return undefined;
      if (clonePath === undefined) return existing[0];
      const wanted = realOrSame(clonePath);
      return existing.find((p) => p.localPath === wanted);
    };

    // A registered project stays usable even if GitHub's list leaves its repo out (e.g. org
    // repos): constraint 4 accepts registered projects. Access is checked only to register or clone.
    const known = registered();
    if (known) return known;

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

    const copiesOf = async (): Promise<LocalClone[]> => {
      let { clones } = await locate(false);
      let mine = clones.filter((c) => key(c.owner, c.repo) === k);
      if (mine.length === 0) {
        // The cached scan may predate the clone.
        ({ clones } = await locate(true));
        mine = clones.filter((c) => key(c.owner, c.repo) === k);
      }
      return mine;
    };
    const copies = await copiesOf();
    if (clonePath !== undefined) {
      const wanted = realOrSame(clonePath);
      if (!copies.some((c) => c.path === wanted)) {
        throw new PrepareError(`${clonePath} is not a copy of ${owner}/${repo}`, 400);
      }
      return register(wanted);
    }
    if (copies.length === 1) return register(copies[0]!.path);
    if (copies.length > 1) {
      throw new PrepareError(
        `there is more than one copy of ${owner}/${repo} on this computer; choose which one to use`,
        400,
      );
    }
    // Not on this computer yet: clone it, as the person would with `git clone`.
    const lock = deps.lockProject ?? (<T>(_key: string, fn: () => Promise<T>) => fn());
    return lock(`repo:${k}`, () => cloneAndRegister(canonical, k, locateRoot()));
  };

  app.post('/api/new-run/prepare', async (c) => {
    const body = await parseBody(c, prepareSchema);
    if ('error' in body) return c.json({ error: body.error }, 400);
    const ref = parseRepoRef(`${body.data.owner}/${body.data.repo}`);
    if (!ref || ref.repo !== body.data.repo) return c.json({ error: 'invalid repository' }, 400);
    // Two picks of the same repo and copy share one piece of work.
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
