import 'dotenv/config';
import open from 'open';
import { dbPath } from '../../core/paths.js';
import { createGitHubClient, createOctokitClients } from '../../core/github/client.js';
import { resolveToken } from '../../core/github/token.js';
import { createProvider, loadConfig } from '../../core/llm/index.js';
import { openStore } from '../../core/store/index.js';
import { formatPrRef, formatRepoRef } from '../../core/pr-ref.js';
import type { AnalysisDeps } from '../../server/analysis.js';
import { startServer } from '../../server/index.js';
import { readLimits } from '../../server/limits.js';
import { createRunManager } from '../../server/run-manager.js';
import { parseCli, UsageError, USAGE } from '../args.js';

export async function reviewMain(argv: string[]): Promise<void> {
  let opts;
  try {
    opts = parseCli(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`${err.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (opts === 'help') {
    console.log(USAGE);
    return;
  }

  // An unusable config file stops the server before anything is opened, naming the file.
  let limits;
  try {
    limits = readLimits();
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }

  const github = createGitHubClient(createOctokitClients(await resolveToken()));
  const store = openStore(dbPath());
  const config = loadConfig();
  if (opts.provider) config.provider = opts.provider;
  if (opts.model) config.models[config.provider] = opts.model;
  const analysis: AnalysisDeps = {
    config,
    createProvider: (sel) => createProvider(config, sel),
    trustPrConfig: opts.trustPrConfig,
  };
  const runManager = createRunManager({ runs: store.runs, limits });
  const server = await startServer({
    repo: opts.repo,
    initialPr: opts.pr,
    port: opts.port,
    github,
    store,
    analysis,
    runManager,
  });
  const url = `http://127.0.0.1:${server.port}/#token=${server.token}`;
  console.log(
    !opts.repo
      ? 'Opening the home page'
      : opts.pr === undefined
        ? `Listing open pull requests in ${formatRepoRef(opts.repo)}`
        : `Reviewing ${formatPrRef({ ...opts.repo, number: opts.pr })}`,
  );
  if (opts.open) {
    console.log(`Opening http://127.0.0.1:${server.port}/ (session token not shown)`);
    await open(url);
  } else {
    console.log(`Open ${url}`);
    console.log('Note: this URL contains a session token; do not share or log it.');
  }

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    // Runs this server drives are marked interrupted before the database closes.
    void runManager
      .shutdown()
      .then(() => server.close())
      .then(() => {
        store.close();
        process.exit(0);
      });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
