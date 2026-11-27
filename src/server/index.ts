import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import type { RepoRef } from '../core/pr-ref.js';
import type { GitHubClient } from '../core/github/types.js';
import type { Store } from '../core/store/index.js';
import type { AnalysisDeps } from './analysis.js';
import { createApp } from './app.js';
import { reconcileRuns, reopenStrandedRests, resumeOnRestart } from './reconcile.js';
import { createHerdrHost } from '../core/terminal/index.js';
import type { RunManager } from './run-manager.js';
import { generateToken, parseAllowedHosts } from './security.js';

export interface RunningServer {
  port: number;
  token: string;
  close: () => Promise<void>;
}

// src/server and dist/server are both two levels below the package root.
const WEB_DIR = resolve(fileURLToPath(import.meta.url), '../../../dist/web');

/** Starts the server on 127.0.0.1. Port 0 picks a random free port. */
export async function startServer(opts: {
  repo?: RepoRef;
  initialPr?: number;
  port?: number;
  github: GitHubClient;
  store: Store;
  analysis?: AnalysisDeps;
  runManager?: RunManager;
}): Promise<RunningServer> {
  // Runs whose driving process died while the server was down are marked interrupted, after
  // looking at what is left of them (hook events, agent terminal, report).
  const reconciled = await reconcileRuns({ runs: opts.store.runs, terminal: createHerdrHost() });
  if (reconciled.length > 0) {
    console.log(`Marked ${reconciled.length} run(s) interrupted: ${reconciled.join(', ')}`);
  }
  // A resting run whose answer was taken but never carried out gets its question back.
  const reopened = reopenStrandedRests(opts.store.runs);
  if (reopened.length > 0) {
    console.log(
      `Reopened the question for ${reopened.length} resting run(s): ${reopened.join(', ')}`,
    );
  }
  // BLOCK_PARTY_TOKEN lets `npm run dev` keep one token across tsx-watch restarts,
  // so already-open tabs don't start getting 401s.
  const token = process.env.BLOCK_PARTY_TOKEN || generateToken();
  let port = opts.port ?? 0;
  const app = createApp({
    token,
    repo: opts.repo,
    initialPr: opts.initialPr,
    github: opts.github,
    store: opts.store,
    analysis: opts.analysis,
    ...(opts.runManager ? { runManager: opts.runManager } : {}),
    port: () => port,
    allowedHosts: parseAllowedHosts(process.env.BLOCK_PARTY_ALLOWED_HOSTS),
    webDir: WEB_DIR,
  });

  const running = await new Promise<RunningServer>((resolvePromise, reject) => {
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, (info: AddressInfo) => {
      port = info.port;
      resolvePromise({
        port,
        token,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
    server.once('error', reject);
  });
  // Runs whose config asks for it are picked up again now that the server can run them.
  if (opts.runManager) {
    // Runs that were queued before the restart go first; then the resumed ones queue behind them.
    opts.runManager.pump();
    const resumed = resumeOnRestart(opts.store.runs, opts.runManager, reconciled);
    if (resumed.length > 0) console.log(`Resumed ${resumed.length} run(s): ${resumed.join(', ')}`);
  }
  return running;
}
