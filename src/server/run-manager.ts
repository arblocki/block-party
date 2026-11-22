import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir } from '../core/paths.js';
import { loadRunConfig, type RunFlagOverrides } from '../core/run/config.js';
import { createRunDeps } from '../core/run/deps.js';
import { runPipeline, type RunInput, type RunOutcome } from '../core/run/pipeline.js';
import { ShutdownError } from '../core/run/pipeline-helpers.js';
import { parsePlan } from '../core/run/plan.js';
import type { RunStore } from '../core/store/runs.js';

export interface StartRunRequest {
  projectId: string;
  baseRef: string;
  planText: string;
  title?: string;
  flags?: RunFlagOverrides;
}

/** The plan text does not parse; nothing was started. */
export class PlanValidationError extends Error {
  constructor(readonly errors: string[]) {
    super(`Invalid plan:\n- ${errors.join('\n- ')}`);
    this.name = 'PlanValidationError';
  }
}

/** The project id is not registered; nothing was started. */
export class UnknownProjectError extends Error {
  constructor(readonly projectId: string) {
    super(`Unknown project: ${projectId}`);
    this.name = 'UnknownProjectError';
  }
}

export interface RunManager {
  /** Starts a run in this process; resolves with its id once the run row exists. */
  start(req: StartRunRequest): Promise<string>;
  /** Cancels a run this process drives; false for runs it does not own (or already cancelled). */
  cancel(runId: string): boolean;
  /** Interrupts every run this process drives and waits (bounded) for them to settle. */
  shutdown(timeoutMs?: number): Promise<void>;
}

export interface RunManagerOptions {
  runs: RunStore;
  /** Runs one pipeline to its end (default: runPipeline with createRunDeps). */
  startPipeline?: (input: RunInput) => Promise<RunOutcome>;
  /** Where submitted plan texts are written (default `<dataDir>/plans`). */
  plansDir?: string;
  /** How long `start` waits for the run row (default 30 s). */
  startTimeoutMs?: number;
  /** Errors a run throws after it started (default: printed to stderr). */
  onError?: (runId: string, err: unknown) => void;
}

interface Entry {
  ac: AbortController;
  done: Promise<unknown>;
}

const DEFAULT_SHUTDOWN_MS = 10_000;

export function createRunManager(opts: RunManagerOptions): RunManager {
  const { runs } = opts;
  const startPipeline =
    opts.startPipeline ??
    (async (input: RunInput) =>
      runPipeline(
        input,
        await createRunDeps({ store: runs, mode: input.config.implementer.mode }),
      ));
  const plansDir = opts.plansDir ?? join(dataDir(), 'plans');
  const startTimeoutMs = opts.startTimeoutMs ?? 30_000;
  const onError =
    opts.onError ??
    ((runId: string, err: unknown) =>
      console.error(`Run ${runId} stopped with an error: ${(err as Error)?.message ?? err}`));

  /** Every in-process run, including ones whose id is not known yet. */
  const live = new Set<Entry>();
  const byId = new Map<string, Entry>();
  let stopping = false;

  return {
    async start(req) {
      if (stopping) throw new Error('The server is shutting down');
      const parsed = parsePlan(req.planText);
      if (!parsed.ok) throw new PlanValidationError(parsed.errors);
      const project = runs.getProject(req.projectId);
      if (!project) throw new UnknownProjectError(req.projectId);
      const config = loadRunConfig(project.localPath, req.flags);

      await mkdir(plansDir, { recursive: true });
      const planFile = join(plansDir, `${parsed.plan.contentHash}.md`);
      await writeFile(planFile, req.planText);

      const ac = new AbortController();
      let runId: string | undefined;
      return new Promise<string>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          ac.abort();
          reject(new Error(`The run did not start within ${startTimeoutMs} ms`));
        }, startTimeoutMs);
        const settle = (fn: () => void) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          fn();
        };

        const entry: Entry = { ac, done: Promise.resolve() };
        live.add(entry);
        // Async wrapper: a synchronous throw becomes a rejection handled below.
        const pipeline = (async () =>
          startPipeline({
            repo: project.localPath,
            planFile,
            baseRef: req.baseRef,
            ...(req.title ? { title: req.title } : {}),
            config,
            signal: ac.signal,
            onStarted: (id) => {
              runId = id;
              byId.set(id, entry);
              settle(() => resolve(id));
            },
          }))();
        entry.done = pipeline.then(
          (outcome) => settle(() => resolve(outcome.runId)),
          (err: unknown) => {
            if (runId === undefined) settle(() => reject(err as Error));
            else onError(runId, err);
          },
        );
        void entry.done.finally(() => {
          live.delete(entry);
          if (runId !== undefined && byId.get(runId) === entry) byId.delete(runId);
        });
      });
    },

    cancel(runId) {
      const entry = byId.get(runId);
      if (!entry || entry.ac.signal.aborted) return false;
      entry.ac.abort();
      return true;
    },

    async shutdown(timeoutMs = DEFAULT_SHUTDOWN_MS) {
      stopping = true;
      const pending = [...live];
      for (const e of pending) {
        if (!e.ac.signal.aborted) e.ac.abort(new ShutdownError());
      }
      if (pending.length === 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(pending.map((e) => e.done)),
        new Promise((r) => (timer = setTimeout(r, timeoutMs))),
      ]);
      clearTimeout(timer);
    },
  };
}
