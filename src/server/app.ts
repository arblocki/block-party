import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { serveStatic } from '@hono/node-server/serve-static';
import {
  formatPrRef,
  formatRepoRef,
  parseRepoRef,
  type PrRef,
  type RepoRef,
} from '../core/pr-ref.js';
import type { GitHubClient } from '../core/github/types.js';
import type { Store } from '../core/store/index.js';
import type { AnalysisDeps } from './analysis.js';
import { registerApi, upstreamError } from './api.js';
import type { RunManager } from './run-manager.js';
import { registerNewRunApi, type NewRunApiDeps } from './new-run-api.js';
import { registerRunsApi } from './runs-api.js';
import { hostGuard, SESSION_COOKIE, tokenGuard, tokensMatch } from './security.js';

export interface AppOptions {
  token: string;
  /** Repository the UI opens on; without one it starts on the repository list. */
  repo?: RepoRef;
  /** PR in `repo` the UI opens first; without one it starts on the repo's open-PR list. */
  initialPr?: number;
  github: GitHubClient;
  store: Store;
  analysis?: AnalysisDeps;
  /** Port the server listens on; used for Host/Origin checks. May be set after listen(). */
  port: () => number;
  /** Extra `host[:port]` values accepted besides localhost (served as `https://<host>`). */
  allowedHosts?: string[];
  /** How many PRs keep their in-memory caches (default 20); older ones are rebuilt on demand. */
  maxCachedPrs?: number;
  /** Directory containing the built UI. Omit to skip static serving. */
  webDir?: string;
  /** Live-stream timing overrides, for tests. */
  streamTiming?: { pollMs?: number; heartbeatMs?: number };
  /** Starts and cancels runs; without one the server cannot start runs. */
  runManager?: RunManager;
  /** Git service for registering projects (default: the real one). */
  git?: NewRunApiDeps['git'];
  /** Home directory searched for existing clones (default: the user's). */
  homeDir?: string;
}

export function createApp(opts: AppOptions): Hono {
  const app = new Hono();
  const maxPrApps = Math.max(1, opts.maxCachedPrs ?? 20);

  app.use('*', hostGuard(opts.port, opts.allowedHosts ?? []));

  // Browser login: trade a pasted token for a session cookie. Outside /api/* (no token yet),
  // but behind hostGuard, which also rejects foreign Origins.
  app.post('/auth/login', async (c) => {
    const body = await c.req.json<{ token?: unknown }>().catch(() => ({}) as { token?: unknown });
    const given = typeof body?.token === 'string' ? body.token.trim() : undefined;
    if (!tokensMatch(opts.token, given)) return c.json({ error: 'unauthorized' }, 401);
    setCookie(c, SESSION_COOKIE, opts.token, {
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
    });
    return c.body(null, 204);
  });
  app.post('/auth/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
    return c.body(null, 204);
  });

  app.use('/api/*', tokenGuard(opts.token));

  app.get('/api/health', (c) => c.json({ ok: true }));
  app.get('/api/session', (c) => {
    const repo = opts.repo ?? null;
    const pr: PrRef | null =
      repo && opts.initialPr !== undefined ? { ...repo, number: opts.initialPr } : null;
    return c.json({
      repo,
      pr,
      label: pr ? formatPrRef(pr) : repo ? formatRepoRef(repo) : 'block-party',
    });
  });
  app.get('/api/repos', async (c) => c.json({ repos: await opts.github.listRepos() }));
  registerRunsApi(app, {
    runs: opts.store.runs,
    ...opts.streamTiming,
    ...(opts.runManager ? { manager: opts.runManager } : {}),
    ...(opts.git ? { git: opts.git } : {}),
  });
  registerNewRunApi(app, {
    runs: opts.store.runs,
    github: opts.github,
    ...(opts.git ? { git: opts.git } : {}),
    ...(opts.homeDir ? { homeDir: opts.homeDir } : {}),
    ...(opts.runManager ? { lockProject: opts.runManager.withProjectLock } : {}),
  });

  // Repository routes; `:owner/:repo` must be a valid GitHub name pair.
  const repoOf = (c: { req: { param(name: string): string } }): RepoRef | null =>
    parseRepoRef(`${c.req.param('owner')}/${c.req.param('repo')}`);
  app.get('/api/repos/:owner/:repo/pulls', async (c) => {
    const repo = repoOf(c);
    if (!repo) return c.json({ error: 'invalid repository' }, 400);
    return c.json({ pulls: await opts.github.listOpenPrs(repo) });
  });

  // Each PR gets its own sub-app (with its own PR-data and analysis caches), created on first
  // use. `/api/repos/:owner/:repo/pulls/:number/<route>` is served by that app's `/api/<route>`.
  // Only the most recently used ones are kept: drafts and reviewed state live in the store, so
  // dropping one only drops caches. Keys are lowercase, as GitHub names are case-insensitive.
  const prApps = new Map<string, Hono>();
  const prApp = (pr: PrRef): Hono => {
    const key = formatPrRef(pr).toLowerCase();
    let sub = prApps.get(key);
    if (sub) {
      prApps.delete(key); // re-inserted below as the most recently used
    } else {
      sub = new Hono();
      registerApi(sub, {
        pr,
        github: opts.github,
        store: opts.store,
        analysis: opts.analysis,
      });
      sub.all('/api/*', (c) => c.json({ error: 'not found' }, 404));
    }
    prApps.set(key, sub);
    // Maps iterate in insertion order, so the first key is the least recently used.
    if (prApps.size > maxPrApps) prApps.delete(prApps.keys().next().value!);
    return sub;
  };
  app.all('/api/repos/:owner/:repo/pulls/:number/*', (c) => {
    const repo = repoOf(c);
    if (!repo) return c.json({ error: 'invalid repository' }, 400);
    const raw = c.req.param('number');
    const number = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(number) || number < 1) {
      return c.json({ error: 'invalid pull request number' }, 400);
    }
    const url = new URL(c.req.url);
    url.pathname = url.pathname.replace(/^\/api\/repos\/[^/]+\/[^/]+\/pulls\/\d+/, '/api');
    // Copy the fields rather than pass c.req.raw as the init: under @hono/node-server it's a
    // lightweight Request subclass, and Node 26's undici brand-checks the init's `duplex`
    // getter on it ("Illegal invocation"). A streamed body needs duplex: 'half'.
    const req = c.req.raw;
    const init: RequestInit & { duplex?: 'half' } = {
      method: req.method,
      headers: req.headers,
      signal: req.signal,
    };
    if (req.body) {
      init.body = req.body;
      init.duplex = 'half';
    }
    return prApp({ ...repo, number }).fetch(new Request(url, init));
  });
  app.onError((err, c) => c.json(upstreamError(err), 502));
  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

  const { webDir } = opts;
  if (webDir) {
    // Mounted even if webDir does not exist yet (`vite build --watch` race); index.html is
    // read per request so rebuilds are picked up without a restart.
    app.use('*', serveStatic({ root: webDir }));
    app.get('*', (c) => {
      try {
        return c.html(readFileSync(`${webDir}/index.html`, 'utf8'));
      } catch {
        return c.text(
          'UI not built yet — run `pnpm build` (or wait for `pnpm dev` to finish building)',
          503,
        );
      }
    });
  }

  return app;
}
