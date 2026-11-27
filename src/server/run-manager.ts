import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir } from '../core/paths.js';
import { loadRunConfig, RunConfigSchema, type RunFlagOverrides } from '../core/run/config.js';
import { createRunDeps } from '../core/run/deps.js';
import { reopenRestDecision } from '../core/run/rest-decision.js';
import { canResume, isResting, type RunStage } from '../core/run/machine.js';
import {
  continueRun,
  runPipeline,
  type ContinueEntry,
  type RunInput,
  type RunSource,
  type RunOutcome,
} from '../core/run/pipeline.js';
import { ShutdownError, throwIfAborted } from '../core/run/pipeline-helpers.js';
import { parsePlan } from '../core/run/plan.js';
import type { RunStore } from '../core/store/runs.js';

export interface StartRunRequest {
  projectId: string;
  baseRef: string;
  /** A plan to implement; exactly one of `planText` and `description` is given. */
  planText?: string;
  /** What to build; a planner writes the plan, and the run rests for its approval. */
  description?: string;
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

/** The request does not name what to build; nothing was started. */
export class InvalidStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStartError';
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
  /**
   * Continues a run resting for review (approve it, or send it back with feedback). False when
   * this process already drives the run, or it is not resting; nothing is started then.
   */
  continue(runId: string, entry: ContinueEntry): boolean;
  /**
   * Resumes an `interrupted` or `blocked` run. One continuation per run: `busy` when this
   * process already drives it (a double click starts one), `not_resumable` when it is in any
   * other stage (or unknown). `keep` accepts the worktree as it is, after the owner was asked.
   */
  resume(runId: string, opts?: { keep?: boolean }): 'started' | 'busy' | 'not_resumable';
  /**
   * Cancels a run: one that this process drives (aborted at any stage; a continuation that is
   * still leaving rest is cancelled once it owns the run), one resting for a person, or one
   * that stopped (`interrupted`, `blocked`). Resolves with the real outcome: true when the run
   * is (or, past the wait, is being) cancelled, false when it ended some other way, was
   * already over, or is not a run this can cancel. Worktree, branch and run directory stay.
   */
  cancel(runId: string): Promise<boolean>;
  /** Interrupts every run this process drives and waits (bounded) for them to settle. */
  shutdown(timeoutMs?: number): Promise<void>;
}

export interface RunManagerOptions {
  runs: RunStore;
  /** Runs one pipeline to its end (default: runPipeline with createRunDeps). */
  startPipeline?: (input: RunInput) => Promise<RunOutcome>;
  /** Continues one resting run to its next rest or end (default: continueRun with createRunDeps). */
  continuePipeline?: (
    runId: string,
    entry: ContinueEntry,
    signal: AbortSignal,
  ) => Promise<RunOutcome>;
  /** Where submitted plan texts are written (default `<dataDir>/plans`). */
  plansDir?: string;
  /** How long `start` waits for the run row (default 30 s). */
  startTimeoutMs?: number;
  /** How long `cancel` waits for the run to settle before answering (default 30 s). */
  cancelWaitMs?: number;
  /** Errors a run throws after it started (default: printed to stderr). */
  onError?: (runId: string, err: unknown) => void;
}

interface Entry {
  ac: AbortController;
  done: Promise<unknown>;
}

const MAX_DESCRIPTION = 20_000;
const DEFAULT_SHUTDOWN_MS = 10_000;
const DEFAULT_CANCEL_WAIT_MS = 30_000;

export function createRunManager(opts: RunManagerOptions): RunManager {
  const { runs } = opts;
  const startPipeline =
    opts.startPipeline ??
    (async (input: RunInput) => {
      const deps = await createRunDeps({ store: runs, mode: input.config.implementer.mode });
      throwIfAborted(input.signal);
      return runPipeline(input, deps);
    });
  const continuePipeline =
    opts.continuePipeline ??
    (async (runId: string, entry: ContinueEntry, signal: AbortSignal) => {
      // The adapter depends on how the run was started, which its saved config says.
      const run = runs.getRun(runId);
      if (!run) throw new Error(`Unknown run: ${runId}`);
      const config = RunConfigSchema.parse(
        JSON.parse(await readFile(join(run.runDir, 'inputs', 'config.json'), 'utf8')),
      );
      const deps = await createRunDeps({ store: runs, mode: config.implementer.mode });
      throwIfAborted(signal);
      return continueRun(runId, entry, deps, signal);
    });
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

  const rowExists = (id: string): boolean => {
    try {
      return runs.getRun(id) !== undefined;
    } catch {
      return false;
    }
  };

  const stageOf = (id: string): 'resting' | 'other' => {
    try {
      const stage = runs.getRun(id)?.stage;
      return stage !== undefined && isResting(stage as Parameters<typeof isResting>[0])
        ? 'resting'
        : 'other';
    } catch {
      return 'other';
    }
  };

  const continueEntry = (
    runId: string,
    entry: ContinueEntry,
    startsFrom: (stage: RunStage) => boolean = isResting,
  ): Entry | undefined => {
    if (stopping || byId.has(runId)) return undefined;
    // Checked again here: the caller's view of the run may be stale.
    let stage: string | undefined;
    try {
      stage = runs.getRun(runId)?.stage;
    } catch {
      return undefined;
    }
    if (stage === undefined || !startsFrom(stage as RunStage)) return undefined;
    const ac = new AbortController();
    const entryRec: Entry = { ac, done: Promise.resolve() };
    live.add(entryRec);
    byId.set(runId, entryRec);
    entryRec.done = (async () => {
      try {
        await continuePipeline(runId, entry, ac.signal);
      } catch (err) {
        // The answer that started this could not be carried out: offer the review again
        // (a no-op when the pipeline already did, or the run is no longer resting).
        reopenRestDecision(runs, runId, err instanceof Error ? err.message : String(err));
        onError(runId, err);
      } finally {
        live.delete(entryRec);
        if (byId.get(runId) === entryRec) byId.delete(runId);
      }
    })();
    return entryRec;
  };

  const stageNow = (id: string): string | undefined => {
    try {
      return runs.getRun(id)?.stage;
    } catch {
      return undefined;
    }
  };
  const settleWait = (e: Entry, ms: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      e.done.then(() => 'done' as const),
      new Promise<'timeout'>((r) => (timer = setTimeout(() => r('timeout'), ms))),
    ]).finally(() => clearTimeout(timer));
  };
  const cancelWaitMs = opts.cancelWaitMs ?? DEFAULT_CANCEL_WAIT_MS;
  const resultOf = async (id: string, e: Entry): Promise<boolean> => {
    // The cancel may take a while (a push in progress finishes first): answer once the run has
    // settled; past the wait, an abort that was delivered counts as a cancel in progress.
    if ((await settleWait(e, cancelWaitMs)) === 'timeout') return true;
    return stageNow(id) === 'cancelled';
  };

  /**
   * Not driven here: a resting or stopped run is cancelled by a continuation that holds it,
   * so it cannot race another one starting.
   */
  const cancelIdle = async (runId: string): Promise<boolean> => {
    const started = continueEntry(
      runId,
      { kind: 'cancel' },
      (stage) => isResting(stage) || canResume(stage),
    );
    return started ? resultOf(runId, started) : false;
  };

  return {
    async start(req) {
      if (stopping) throw new Error('The server is shutting down');
      if ((req.planText === undefined) === (req.description === undefined)) {
        throw new InvalidStartError('Give either planText or description');
      }
      const description = req.description?.trim();
      if (
        description !== undefined &&
        (description === '' || description.length > MAX_DESCRIPTION)
      ) {
        throw new InvalidStartError(`The description must be 1-${MAX_DESCRIPTION} characters`);
      }
      const parsed = req.planText !== undefined ? parsePlan(req.planText) : undefined;
      if (parsed && !parsed.ok) throw new PlanValidationError(parsed.errors);
      const project = runs.getProject(req.projectId);
      if (!project) throw new UnknownProjectError(req.projectId);
      const config = loadRunConfig(project.localPath, req.flags);
      const planFile = parsed?.ok ? join(plansDir, `${parsed.plan.contentHash}.md`) : undefined;

      const ac = new AbortController();
      let runId: string | undefined;
      return new Promise<string>((resolve, reject) => {
        let settled = false;
        const settle = (fn: () => void) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          fn();
        };
        const timer = setTimeout(() => {
          // Aborting also stops a preflight that has not created the run yet.
          ac.abort();
          settle(() => reject(new Error(`The run did not start within ${startTimeoutMs} ms`)));
        }, startTimeoutMs);

        // Tracked before the first await, so a shutdown that starts meanwhile aborts and
        // waits for this start too.
        const entry: Entry = { ac, done: Promise.resolve() };
        live.add(entry);
        const stoppedError = () =>
          ac.signal.reason instanceof ShutdownError
            ? new Error('The server is shutting down')
            : new Error('The run was cancelled before it started');

        entry.done = (async () => {
          try {
            if (planFile !== undefined) {
              await mkdir(plansDir, { recursive: true });
              // Same text means same path: write a temp file and rename it into place, so a
              // concurrent start reading this plan never sees it truncated or half-written.
              const tmp = `${planFile}.${randomUUID()}.tmp`;
              await writeFile(tmp, req.planText!);
              await rename(tmp, planFile);
            }
            if (ac.signal.aborted) throw stoppedError();
            const source: RunSource =
              planFile !== undefined ? { planFile } : { description: description! };
            const outcome = await startPipeline({
              repo: project.localPath,
              ...source,
              baseRef: req.baseRef,
              ...(req.title ? { title: req.title } : {}),
              config,
              signal: ac.signal,
              onStarted: (id) => {
                runId = id;
                byId.set(id, entry);
                if (!rowExists(id)) {
                  // The pipeline keeps its files but the server could not show the run:
                  // stop it before it does any work, and report the failure.
                  ac.abort();
                  settle(() =>
                    reject(new Error(`Run ${id} could not be recorded in the database`)),
                  );
                  return;
                }
                settle(() => resolve(id));
              },
            });
            settle(() => resolve(outcome.runId));
          } catch (err) {
            if (runId === undefined) settle(() => reject(err as Error));
            else onError(runId, err);
          } finally {
            live.delete(entry);
            if (runId !== undefined && byId.get(runId) === entry) byId.delete(runId);
          }
        })();
      });
    },

    continue: (runId, entry) => continueEntry(runId, entry) !== undefined,

    resume(runId, opts = {}) {
      if (stopping || byId.has(runId)) return 'busy';
      const started = continueEntry(
        runId,
        { kind: 'resume', ...(opts.keep ? { keep: true } : {}) },
        canResume,
      );
      return started ? 'started' : 'not_resumable';
    },

    async cancel(runId) {
      const entry = byId.get(runId);
      if (entry) {
        // A continuation that has not left rest yet is starting: it is cancelled once it owns
        // the run (out of rest), or this settles with whatever it ended as (an approval that
        // completed the run is not a cancel).
        const deadline = Date.now() + cancelWaitMs;
        let finished = false;
        entry.done.then(
          () => (finished = true),
          () => (finished = true),
        );
        while (!finished && stageOf(runId) === 'resting' && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 20));
        }
        if (!finished && stageOf(runId) === 'resting') return true;
        if (finished) {
          // It ended (or came to rest, or stopped): cancel what is left, if anything is.
          if (stageNow(runId) === 'cancelled') return true;
          return cancelIdle(runId);
        }
        if (!entry.ac.signal.aborted) entry.ac.abort();
        return resultOf(runId, entry);
      }
      return cancelIdle(runId);
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
