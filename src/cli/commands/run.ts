import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadRunConfig, type RunFlagOverrides } from '../../core/run/config.js';
import { createRunDeps } from '../../core/run/deps.js';
import { runPipeline, type RunOutcome } from '../../core/run/pipeline.js';
import { dbPath } from '../../core/paths.js';
import { openStore, type Store } from '../../core/store/index.js';

export const RUN_USAGE = `Usage: block-party run --plan <file> [--repo <path>] [--base <ref>]
                       [--mode pane|headless] [--model <m>] [--reviewer-model <m>]
                       [--no-publish] [--no-wait-ci] [--title <t>]

Runs the plan in a fresh worktree: implement, local CI, Codex review, draft PR, GitHub CI.
Exit codes: 0 complete, 3 blocked, 1 failed, 2 usage error, 130 cancelled.`;

export interface RunArgs {
  repo: string;
  plan: string;
  base: string | undefined;
  title: string | undefined;
  flags: RunFlagOverrides;
}

export type ParsedRunArgs =
  | { ok: true; help: false; args: RunArgs }
  | { ok: true; help: true }
  | { ok: false; error: string };

export function parseRunArgs(argv: string[]): ParsedRunArgs {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        repo: { type: 'string' },
        plan: { type: 'string' },
        base: { type: 'string' },
        mode: { type: 'string' },
        model: { type: 'string' },
        'reviewer-model': { type: 'string' },
        'no-publish': { type: 'boolean', default: false },
        'no-wait-ci': { type: 'boolean', default: false },
        title: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
    }));
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  if (values.help) return { ok: true, help: true };
  if (!values.plan) return { ok: false, error: '--plan <file> is required' };
  if (values.mode !== undefined && values.mode !== 'pane' && values.mode !== 'headless') {
    return { ok: false, error: `--mode must be "pane" or "headless", got "${values.mode}"` };
  }
  for (const k of ['model', 'reviewer-model', 'title', 'base', 'repo'] as const) {
    if (values[k] !== undefined && values[k]!.trim() === '') {
      return { ok: false, error: `--${k} must not be empty` };
    }
  }
  const flags: RunFlagOverrides = {};
  if (values.mode) flags.mode = values.mode;
  if (values.model) flags.model = values.model;
  if (values['reviewer-model']) flags.reviewerModel = values['reviewer-model'];
  if (values['no-publish']) flags.publish = false;
  if (values['no-wait-ci']) flags.waitForCi = false;
  return {
    ok: true,
    help: false,
    args: {
      repo: resolve(values.repo ?? '.'),
      plan: resolve(values.plan),
      base: values.base,
      title: values.title,
      flags,
    },
  };
}

/** The repo's default branch: `origin/HEAD`'s target, else `main`. */
function defaultBranch(repo: string): Promise<string> {
  return new Promise((res) => {
    execFile(
      'git',
      ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      { cwd: repo },
      (err, stdout) => {
        const name = err ? '' : stdout.trim().replace(/^origin\//, '');
        res(name || 'main');
      },
    );
  });
}

/** Process exit code for a finished run. 130 matches the shell convention for SIGINT. */
export function exitCodeFor(stage: RunOutcome['stage']): number {
  switch (stage) {
    case 'complete':
    case 'awaiting_review':
    case 'awaiting_plan_approval':
      return 0;
    case 'blocked':
      return 3;
    case 'cancelled':
    case 'interrupted':
      return 130;
    case 'failed':
      return 1;
  }
}

export async function runMain(argv: string[] = []): Promise<void> {
  const parsed = parseRunArgs(argv);
  if (!parsed.ok) {
    console.error(`${parsed.error}\n\n${RUN_USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (parsed.help) {
    console.log(RUN_USAGE);
    return;
  }
  const { args } = parsed;
  try {
    const config = loadRunConfig(args.repo, args.flags);
    const base = args.base ?? (await defaultBranch(args.repo));
    const ac = new AbortController();
    const onSigint = () => {
      if (ac.signal.aborted) process.exit(130);
      console.error('\nInterrupted: marking the run cancelled (agent session is left running).');
      ac.abort();
    };
    process.on('SIGINT', onSigint);

    // The run tables let the server show this run; without them the run files still work.
    let store: Store | undefined;
    try {
      store = openStore(dbPath());
    } catch (err) {
      console.error(
        `Warning: could not open the database (${err instanceof Error ? err.message : String(err)}); ` +
          'this run is recorded in its run directory only.',
      );
    }

    try {
      const deps = await createRunDeps({
        ...(store ? { store: store.runs } : {}),
        echo: (line) => console.log(line),
        mode: config.implementer.mode,
      });
      const outcome = await runPipeline(
        {
          repo: args.repo,
          planFile: args.plan,
          baseRef: base,
          ...(args.title ? { title: args.title } : {}),
          config,
          signal: ac.signal,
        },
        deps,
      );
      console.log(
        `\nRun ${outcome.runId}: ${outcome.stage}${outcome.note ? ` - ${outcome.note}` : ''}`,
      );
      console.log(`Run directory: ${outcome.runDir}`);
      if (outcome.stage === 'awaiting_review') {
        console.log(
          'The run is waiting for your review in the app (open it with `block-party review`).',
        );
      }
      process.exitCode = exitCodeFor(outcome.stage);
    } finally {
      process.removeListener('SIGINT', onSigint);
      try {
        store?.close();
      } catch {
        // Nothing left to record; closing is best effort.
      }
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
