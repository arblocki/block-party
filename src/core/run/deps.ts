import { hookArgv } from '../agents/claude-config.js';
import { createHeadlessClaude } from '../agents/claude-headless.js';
import { createPaneClaude } from '../agents/claude-pane.js';
import { HookWatcher } from '../agents/hook-events.js';
import type { ImplementerAdapter } from '../agents/types.js';
import { loadProjectChecks } from '../checks/load.js';
import { runChecks } from '../checks/run.js';
import { createGit } from '../git/index.js';
import { createGitHubClient, createOctokitClients } from '../github/client.js';
import { resolveToken } from '../github/token.js';
import { runShell } from '../process/run-shell.js';
import { reviewWithCodex } from '../reviewer/codex-reviewer.js';
import { ensureReviewerCodexHome } from '../reviewer/codex-home.js';
import type { RunStore } from '../store/runs.js';
import { createHerdrHost } from '../terminal/index.js';
import type { RunConfig } from './config.js';
import { RunLog } from './events.js';
import type { PipelineDeps } from './pipeline.js';
import { publishRun, waitForCi } from './publish.js';

export interface CreateRunDepsOptions {
  /** Run tables to mirror the run into. */
  store?: RunStore;
  /** Where run log lines are echoed (the CLI prints them; the server drops them). */
  echo?: (line: string) => void;
  mode: RunConfig['implementer']['mode'];
}

/** The real pipeline dependencies, shared by `block-party run` and the server. */
export async function createRunDeps(opts: CreateRunDepsOptions): Promise<PipelineDeps> {
  const codexHome = await ensureReviewerCodexHome();
  const adapter: ImplementerAdapter =
    opts.mode === 'pane'
      ? createPaneClaude({
          host: createHerdrHost(),
          claudeBin: 'claude',
          watcherFactory: (p, off) => new HookWatcher(p, { startOffset: off }),
        })
      : createHeadlessClaude();
  const { echo } = opts;
  return {
    git: createGit(),
    runShell,
    runChecks,
    loadProjectChecks,
    adapter,
    reviewWithCodex: (o) => reviewWithCodex({ ...o, codexHome }),
    publishRun,
    waitForCi,
    github: async () => createGitHubClient(createOctokitClients(await resolveToken())),
    createLog: (dir) => new RunLog(dir, echo ? { echo } : {}),
    hookArgv: hookArgv(),
    ...(opts.store ? { store: opts.store } : {}),
  };
}
