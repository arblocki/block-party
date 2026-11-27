import { existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RepoSummary } from '../core/github/types.js';
import { fakeGitHub } from '../core/testing/fakes.testutil.js';
import { openStore, type Store } from '../core/store/index.js';
import { createApp } from './app.js';
import type { NewRunApiDeps } from './new-run-api.js';
import { TOKEN_HEADER } from './security.js';

const TOKEN = 'test-token';
const HOST = '127.0.0.1:4321';

const summary = (owner: string, name: string, over: Partial<RepoSummary> = {}): RepoSummary => ({
  owner,
  name,
  description: '',
  private: false,
  archived: false,
  fork: false,
  url: `https://github.com/${owner}/${name}`,
  pushedAt: '2026-01-01T00:00:00Z',
  ...over,
});

let store: Store;
let home: string;
let origins: Map<string, string>;
let cloned: { url: string; dest: string }[];
let cloneFails: boolean;
let wrongOrigin: string | null;
let github: ReturnType<typeof fakeGitHub>;
let app: ReturnType<typeof createApp>;

/** A fake git service: origins by directory, and a clone that just makes the directory. */
const git: NonNullable<NewRunApiDeps['git']> = {
  async repoRoot(cwd) {
    return realpathSync(cwd);
  },
  async originRepo(cwd) {
    const o = origins.get(realpathSync(cwd));
    if (!o) throw new Error('no GitHub origin');
    const [owner, repo] = o.split('/') as [string, string];
    return { owner, repo };
  },
  async defaultBranch() {
    return 'trunk';
  },
  async clone(url, dest) {
    cloned.push({ url, dest });
    if (cloneFails) throw new Error('fatal: could not read from remote');
    mkdirSync(join(dest, '.git'), { recursive: true });
    const m = /github\.com\/([^/]+\/[^/]+)\.git$/.exec(url)!;
    origins.set(realpathSync(dest), wrongOrigin ?? m[1]!);
  },
};

const defaultBranch0 = git.defaultBranch;
const clone0 = git.clone;

/** A directory under the fake home that looks like a clone of `origin`. */
function makeClone(path: string, origin: string): string {
  mkdirSync(join(path, '.git'), { recursive: true });
  const real = realpathSync(path);
  origins.set(real, origin);
  return real;
}

beforeEach(() => {
  store = openStore(':memory:');
  home = realpathSync(mkdtempSync(join(tmpdir(), 'bp-newrun-')));
  origins = new Map();
  cloned = [];
  cloneFails = false;
  wrongOrigin = null;
  git.defaultBranch = defaultBranch0;
  git.clone = clone0;
  github = fakeGitHub();
  app = createApp({
    token: TOKEN,
    port: () => 4321,
    github,
    store,
    git,
    homeDir: home,
    streamTiming: { pollMs: 5, heartbeatMs: 1000 },
  });
});
afterEach(() => store.close());

const call = (path: string, body?: unknown) =>
  app.request(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { host: HOST, [TOKEN_HEADER]: TOKEN, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

interface Row {
  owner: string;
  repo: string;
  clones: string[];
  projectId: string | null;
  defaultBranch: string | null;
  private: boolean;
}
const list = async (query = '') => {
  const res = await call(`/api/new-run/repos${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as { repos: Row[]; cloneRoot: string };
};
const prepare = (body: unknown) => call('/api/new-run/prepare', body);

describe('GET /api/new-run/repos', () => {
  it('lists GitHub repos with the clone root, marking private ones', async () => {
    github.repos = [summary('me', 'a', { private: true })];
    const r = await list();
    expect(r.cloneRoot).toBe(join(home, 'repos'));
    expect(r.repos).toEqual([
      expect.objectContaining({
        owner: 'me',
        repo: 'a',
        private: true,
        clones: [],
        projectId: null,
        defaultBranch: null,
      }),
    ]);
  });

  it('attaches clones by origin, ignoring case and clones of other repos', async () => {
    mkdirSync(join(home, 'code'));
    const path = makeClone(join(home, 'code', 'dir-name-differs'), 'Me/A');
    makeClone(join(home, 'code', 'other'), 'someone/else');
    github.repos = [summary('me', 'a'), summary('me', 'b')];
    const r = await list();
    expect(r.cloneRoot).toBe(join(home, 'code'));
    expect(r.repos.find((x) => x.repo === 'a')?.clones).toEqual([path]);
    expect(r.repos.find((x) => x.repo === 'b')?.clones).toEqual([]);
    expect(r.repos.map((x) => x.repo)).not.toContain('else');
  });

  it('puts the registered copy first among several', async () => {
    mkdirSync(join(home, 'repos'));
    makeClone(join(home, 'repos', 'a1'), 'me/a');
    const second = makeClone(join(home, 'repos', 'a2'), 'me/a');
    github.repos = [summary('me', 'a')];
    store.runs.upsertProject({ owner: 'me', repo: 'a', localPath: second, defaultBase: 'main' });
    const row = (await list()).repos[0]!;
    expect(row.clones).toHaveLength(2);
    expect(row.clones[0]).toBe(second);
  });

  it('keeps registered projects that GitHub does not list', async () => {
    github.repos = [];
    store.runs.upsertProject({ owner: 'gone', repo: 'x', localPath: '/p/x', defaultBase: 'dev' });
    const r = await list();
    expect(r.repos).toEqual([
      expect.objectContaining({
        owner: 'gone',
        repo: 'x',
        clones: ['/p/x'],
        defaultBranch: 'dev',
        pushedAt: null,
      }),
    ]);
  });

  it('sorts projects by recent use, then repos with a clone, then the rest by last push', async () => {
    mkdirSync(join(home, 'repos'));
    makeClone(join(home, 'repos', 'cloned'), 'me/cloned');
    github.repos = [
      summary('me', 'old', { pushedAt: '2025-01-01T00:00:00Z' }),
      summary('me', 'new', { pushedAt: '2026-06-01T00:00:00Z' }),
      summary('me', 'cloned'),
      summary('me', 'p1'),
      summary('me', 'p2'),
    ];
    const p1 = store.runs.upsertProject({
      owner: 'me',
      repo: 'p1',
      localPath: '/p/p1',
      defaultBase: 'main',
    });
    store.runs.upsertProject({
      owner: 'me',
      repo: 'p2',
      localPath: '/p/p2',
      defaultBase: 'main',
    });
    store.runs.createRun({
      id: 'r20260301-aaaaaa',
      projectId: p1.id,
      title: 't',
      stage: 'complete',
      stageNote: null,
      branch: 'b',
      worktreePath: '/w',
      runDir: '/r',
      baseRef: 'main',
      baseSha: 's',
      headSha: null,
      prNumber: null,
      planPath: '/r/plan.md',
      planHash: 'h',
      implementer: null,
      rounds: { checkFix: 0, reviewFix: 0, ciFix: 0, feedback: 0, checkRuns: 0 },
      ownerPid: null,
      ownerHost: null,
      createdAt: '2099-01-01T00:00:00.000Z',
      updatedAt: '2099-01-01T00:00:00.000Z',
    });
    const r = await list();
    expect(r.repos.map((x) => x.repo)).toEqual(['p1', 'p2', 'cloned', 'new', 'old']);
  });

  it('serves a cached clone scan until ?refresh=1', async () => {
    github.repos = [summary('me', 'a')];
    expect((await list()).repos[0]!.clones).toEqual([]);
    mkdirSync(join(home, 'repos'));
    makeClone(join(home, 'repos', 'a'), 'me/a');
    expect((await list()).repos[0]!.clones).toEqual([]);
    expect((await list('?refresh=1')).repos[0]!.clones).toHaveLength(1);
  });

  it('reports a GitHub failure as 502', async () => {
    github.listRepos = async () => {
      throw new Error('boom');
    };
    expect((await call('/api/new-run/repos')).status).toBe(502);
  });
});

describe('POST /api/new-run/prepare', () => {
  const asProject = async (res: Response) =>
    ((await res.json()) as { project: { id: string; localPath: string; defaultBase: string } })
      .project;

  beforeEach(() => {
    github.repos = [summary('me', 'a')];
  });

  it('returns the existing project when the viewer can access the repo', async () => {
    const p = store.runs.upsertProject({
      owner: 'Me',
      repo: 'A',
      localPath: '/p/a',
      defaultBase: 'main',
    });
    const res = await prepare({ owner: 'me', repo: 'a' });
    expect((await asProject(res)).id).toBe(p.id);
    expect(cloned).toEqual([]);
  });

  it('still returns an existing project when GitHub cannot be reached', async () => {
    const p = store.runs.upsertProject({
      owner: 'me',
      repo: 'a',
      localPath: '/p/a',
      defaultBase: 'main',
    });
    github.listRepos = async () => {
      throw new Error('offline');
    };
    expect((await asProject(await prepare({ owner: 'me', repo: 'a' }))).id).toBe(p.id);
    // Without a project there is nothing to fall back on.
    expect((await prepare({ owner: 'me', repo: 'other' })).status).toBe(502);
  });

  it('checks access before returning an existing project', async () => {
    store.runs.upsertProject({
      owner: 'gone',
      repo: 'x',
      localPath: '/p/x',
      defaultBase: 'main',
    });
    expect((await prepare({ owner: 'gone', repo: 'x' })).status).toBe(403);
  });

  it('registers the only clone on this computer', async () => {
    mkdirSync(join(home, 'repos'));
    const path = makeClone(join(home, 'repos', 'whatever'), 'me/a');
    const res = await prepare({ owner: 'me', repo: 'a' });
    expect(res.status).toBe(200);
    expect(await asProject(res)).toMatchObject({ localPath: path, defaultBase: 'trunk' });
    expect(store.runs.listProjects()).toHaveLength(1);
    expect(cloned).toEqual([]);
  });

  it('needs clonePath for several clones, and rejects one that is not listed', async () => {
    mkdirSync(join(home, 'repos'));
    const one = makeClone(join(home, 'repos', 'a1'), 'me/a');
    makeClone(join(home, 'repos', 'a2'), 'me/a');
    const other = makeClone(join(home, 'repos', 'b'), 'me/b');
    expect((await prepare({ owner: 'me', repo: 'a' })).status).toBe(400);
    expect((await prepare({ owner: 'me', repo: 'a', clonePath: other })).status).toBe(400);
    expect((await prepare({ owner: 'me', repo: 'a', clonePath: '/nowhere' })).status).toBe(400);
    const ok = await prepare({ owner: 'me', repo: 'a', clonePath: one });
    expect((await asProject(ok)).localPath).toBe(one);
  });

  it('clones into the clone root when there is no copy, and registers it', async () => {
    const res = await prepare({ owner: 'me', repo: 'a' });
    expect(res.status).toBe(200);
    expect(cloned).toEqual([
      { url: 'https://github.com/me/a.git', dest: join(home, 'repos', 'a') },
    ]);
    expect(await asProject(res)).toMatchObject({
      localPath: join(home, 'repos', 'a'),
      defaultBase: 'trunk',
    });
  });

  it('clones into <owner>-<repo> when the plain path holds another repo', async () => {
    makeClone(join(home, 'repos', 'a'), 'someone/a');
    const res = await prepare({ owner: 'me', repo: 'a' });
    expect(res.status).toBe(200);
    expect(cloned[0]!.dest).toBe(join(home, 'repos', 'me-a'));
  });

  it('refuses when both paths are taken by other repos', async () => {
    makeClone(join(home, 'repos', 'a'), 'someone/a');
    makeClone(join(home, 'repos', 'me-a'), 'another/a');
    const res = await prepare({ owner: 'me', repo: 'a' });
    expect(res.status).toBe(409);
    expect(cloned).toEqual([]);
    expect(((await res.json()) as { command: string }).command).toContain('git clone');
  });

  it('returns the error and the command to run by hand when the clone fails', async () => {
    cloneFails = true;
    const res = await prepare({ owner: 'me', repo: 'a' });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; command: string };
    expect(body.error).toContain('could not read from remote');
    expect(body.command).toBe(`git clone https://github.com/me/a.git ${join(home, 'repos', 'a')}`);
    expect(store.runs.listProjects()).toEqual([]);
  });

  it('rejects a clone whose origin is another repo, and registers nothing', async () => {
    wrongOrigin = 'someone/else';
    const res = await prepare({ owner: 'me', repo: 'a' });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain('does not point at');
    expect(store.runs.listProjects()).toEqual([]);
  });

  it('reports a setup failure after a good clone without a clone command', async () => {
    git.defaultBranch = async () => {
      throw new Error('broken repo');
    };
    const res = await prepare({ owner: 'me', repo: 'a' });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; command?: string };
    expect(body.error).toMatch(/cloned me\/a but could not set it up: broken repo/);
    expect(body.command).toBeUndefined();
  });

  it('quotes paths with spaces in the hand-run command', async () => {
    cloneFails = true;
    const spaced = join(home, 'my code');
    mkdirSync(spaced);
    app = createApp({ token: TOKEN, port: () => 4321, github, store, git, homeDir: spaced });
    const body = (await (await prepare({ owner: 'me', repo: 'a' })).json()) as { command: string };
    expect(body.command).toBe(
      `git clone https://github.com/me/a.git '${join(spaced, 'repos', 'a')}'`,
    );
  });

  it('refuses a destination that another clone is using right now', async () => {
    github.repos = [summary('me', 'a'), summary('other', 'a')];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const realClone = git.clone!;
    git.clone = async (url, dest) => {
      await gate;
      return realClone(url, dest);
    };
    app = createApp({ token: TOKEN, port: () => 4321, github, store, git, homeDir: home });
    const first = prepare({ owner: 'me', repo: 'a' });
    await new Promise((r) => setTimeout(r, 20));
    const second = await prepare({ owner: 'other', repo: 'a' });
    release();
    expect((await first).status).toBe(200);
    expect(second.status).toBe(409);
    expect(cloned).toHaveLength(1);
  });

  it('rejects a repo the viewer cannot access, without cloning', async () => {
    const res = await prepare({ owner: 'stranger', repo: 'secret' });
    expect(res.status).toBe(403);
    expect(cloned).toEqual([]);
    expect(existsSync(join(home, 'repos'))).toBe(false);
  });

  it('rejects malformed bodies and unsafe names', async () => {
    expect((await prepare({ owner: 'me' })).status).toBe(400);
    expect((await prepare({ owner: 'me', repo: 'a', extra: 1 })).status).toBe(400);
    expect((await prepare({ owner: 'me', repo: '--upload-pack=x' })).status).toBe(400);
    expect((await prepare({ owner: '..', repo: '..' })).status).toBe(400);
  });
});
