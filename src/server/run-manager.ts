import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { dataDir } from '../core/paths.js';
import { loadRunConfig, RunConfigSchema, type RunFlagOverrides } from '../core/run/config.js';
import { createRunDeps } from '../core/run/deps.js';
import { reopenRestDecision } from '../core/run/rest-decision.js';
import { newRunId } from '../core/run/id.js';
import { canResume, isResting, type RunStage } from '../core/run/machine.js';
import { runDir as defaultRunDir } from '../core/run/paths.js';
import {
  continueRun,
  runPipeline,
  type ContinueEntry,
  type RunInput,
  type RunSource,
  type RunOutcome,
  type SlotHooks,
} from '../core/run/pipeline.js';
import {
  ShutdownError,
  throwIfAborted,
  titleFromDescription,
} from '../core/run/pipeline-helpers.js';
import { parsePlan } from '../core/run/plan.js';
import type { ClaimedRun, RunStore } from '../core/store/runs.js';
import { DEFAULT_LIMITS, type Limits } from './limits.js';

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

/** What a cancel found out: done, not possible, or still stopping. */
export type CancelResult = boolean | 'pending';

/** How many run slots are taken, for the "waiting for a free slot" text. */
export interface SlotStatus {
  /** Runs being driven now (runs waiting for an answer or at rest hold no slot). */
  inUse: number;
  maxRuns: number;
  maxRunsPerProject: number;
  /** Slots in use by project id (only projects with a run being driven). */
  perProject: Record<string, number>;
}

/** What the manager gives a pipeline so it can share the run slots and the project lock. */
export interface PipelineHooks {
  slots: SlotHooks;
  /** Serializes git work on the project's main clone with other runs of the same project. */
  lockProject: <T>(fn: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
}

export interface RunManager {
  /** The limits this manager enforces. */
  readonly limits: Limits;
  /** Slots in use right now. */
  status(): SlotStatus;
  /**
   * Runs `fn` once no other `fn` holds `key`'s lock (FIFO), however the earlier ones ended.
   * Keys are project ids (or any string naming a main clone).
   */
  withProjectLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
  /**
   * Starts every queued run for which a slot is free (and re-checks waiting runs). The manager
   * does this by itself whenever a slot frees; the server calls it once after reconciliation.
   */
  pump(): void;
  /**
   * Starts a run in this process and resolves with its id once the run row exists. Over the
   * limit the run is recorded as `queued` (durably, before this resolves) and starts later.
   */
  start(req: StartRunRequest): Promise<string>;
  /**
   * Continues a run resting for review (approve it, or send it back with feedback). False when
   * this process already drives the run, or it is not resting; nothing is started then. With no
   * free slot the answer is kept and the run waits in the queue (true).
   */
  continue(runId: string, entry: ContinueEntry): boolean;
  /**
   * Resumes an `interrupted` or `blocked` run. One continuation per run: `busy` when this
   * process already drives it or it waits in the queue (a double click starts one),
   * `not_resumable` when it is in any other stage (or unknown). `keep` accepts the worktree as
   * it is, after the owner was asked. With no free slot the run waits in the queue.
   */
  resume(runId: string, opts?: { keep?: boolean }): 'started' | 'busy' | 'not_resumable';
  /**
   * Cancels a run: one that this process drives (aborted at any stage; a continuation that is
   * still leaving rest is cancelled once it owns the run), one resting for a person, one
   * waiting in the queue, or one that stopped (`interrupted`, `blocked`). Resolves with the
   * real outcome: true when the run is cancelled, false when it ended some other way, was
   * already over, was never aborted, or is not a run this can cancel, and `'pending'` when it
   * was told to stop but had not settled within the wait (a push in progress finishes first).
   * Worktree, branch and run directory stay.
   */
  cancel(runId: string): Promise<CancelResult>;
  /**
   * Interrupts every run this process drives and waits (bounded) for them to settle. Queued
   * runs stay queued: they start after the next server start.
   */
  shutdown(timeoutMs?: number): Promise<void>;
}

export interface RunManagerOptions {
  runs: RunStore;
  /** How many runs may be driven at once (default: 3 in all, 2 per project). */
  limits?: Limits;
  /** Runs one pipeline to its end (default: runPipeline with createRunDeps). */
  startPipeline?: (input: RunInput, hooks: PipelineHooks) => Promise<RunOutcome>;
  /** Continues one resting run to its next rest or end (default: continueRun with createRunDeps). */
  continuePipeline?: (
    runId: string,
    entry: ContinueEntry,
    signal: AbortSignal,
    hooks: PipelineHooks,
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
  /** The project the run belongs to; unset until a start's project is known (it always is). */
  projectId: string | undefined;
  /** Whether this entry takes up a run slot right now. */
  held: boolean;
  /** The run this entry drives, once known (a start learns it in `onStarted`). */
  runId?: string;
  /** The entry starts waiting for the project lock / was granted it (a start's timeout pauses between). */
  onLockBegin?: () => void;
  onLockEnd?: () => void;
}

/** What a queued start keeps: the pipeline's input without the parts that only live in memory. */
type StoredStart = { repo: string; baseRef: string; title?: string; config: RunInput['config'] } & (
  { planFile: string } | { description: string }
);

interface Waiter {
  entry: Entry;
  resolve: () => void;
}

const WAITING_NOTE = 'Waiting for a free slot';

const MAX_DESCRIPTION = 20_000;
const DEFAULT_SHUTDOWN_MS = 10_000;
const DEFAULT_CANCEL_WAIT_MS = 30_000;

/** Answers that only finish a run (no agent work), so they never wait for a slot. */
const needsNoSlot = (entry: ContinueEntry): boolean =>
  entry.kind === 'cancel' || entry.kind === 'approve';

export function createRunManager(opts: RunManagerOptions): RunManager {
  const { runs } = opts;
  const limits: Limits = opts.limits ?? { ...DEFAULT_LIMITS };
  const startPipeline =
    opts.startPipeline ??
    (async (input: RunInput, hooks: PipelineHooks) => {
      const deps = await createRunDeps({ store: runs, mode: input.config.implementer.mode });
      throwIfAborted(input.signal);
      return runPipeline(input, { ...deps, ...hooks });
    });
  const continuePipeline =
    opts.continuePipeline ??
    (async (runId: string, entry: ContinueEntry, signal: AbortSignal, hooks: PipelineHooks) => {
      // The adapter depends on how the run was started, which its saved config says.
      const run = runs.getRun(runId);
      if (!run) throw new Error(`Unknown run: ${runId}`);
      const config = RunConfigSchema.parse(
        JSON.parse(await readFile(join(run.runDir, 'inputs', 'config.json'), 'utf8')),
      );
      const deps = await createRunDeps({ store: runs, mode: config.implementer.mode });
      throwIfAborted(signal);
      return continueRun(runId, entry, { ...deps, ...hooks }, signal);
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
  const waiters: Waiter[] = [];
  const locks = new Map<string, Promise<unknown>>();
  let stopping = false;

  // ---- Slots ----------------------------------------------------------------------------

  const held = (projectId?: string): number => {
    let n = 0;
    for (const e of live) if (e.held && (projectId === undefined || e.projectId === projectId)) n++;
    return n;
  };
  const hasRoom = (projectId: string | undefined): boolean =>
    held() < limits.maxRuns &&
    (projectId === undefined || held(projectId) < limits.maxRunsPerProject);

  const eventAt = (runId: string, type: string, payload?: unknown): void => {
    try {
      runs.appendEvent({ runId, ts: new Date().toISOString(), type, payload });
    } catch {
      // An event is a note; the queue itself is in the run's row.
    }
  };

  /** Records `run.queued { position }` for a run that was just put in the queue. */
  const noteQueued = (runId: string): number => {
    let position = 0;
    try {
      position = runs.listQueued().findIndex((q) => q.runId === runId) + 1;
    } catch {
      // The position is informational.
    }
    eventAt(runId, 'run.queued', { position });
    return position;
  };

  /** Gives waiting runs, then queued ones, the slots that are free. */
  const pump = (): void => {
    if (stopping) return;
    // A run that already started and waits to carry on goes before one that has not begun.
    // That can keep queued starts waiting while answered runs keep coming back, but each of
    // those only comes back when a person answers a question, so a human bounds it.
    for (const w of [...waiters]) {
      if (!hasRoom(w.entry.projectId)) continue;
      waiters.splice(waiters.indexOf(w), 1);
      w.entry.held = true;
      w.resolve();
    }
    while (held() < limits.maxRuns) {
      let claimed: ClaimedRun | undefined;
      try {
        claimed = runs.claimQueued({
          fits: (projectId) => hasRoom(projectId),
          owner: { pid: process.pid, host: hostname() },
        });
      } catch (err) {
        onError('queue', err);
        return;
      }
      if (!claimed) return;
      launchClaimed(claimed);
    }
  };

  const hooksFor = (entry: Entry): PipelineHooks => ({
    slots: {
      release() {
        if (!entry.held) return;
        entry.held = false;
        pump();
      },
      acquire(signal) {
        return new Promise<void>((resolve, reject) => {
          if (signal?.aborted) return reject(signal.reason);
          if (entry.held) return resolve();
          if (hasRoom(entry.projectId)) {
            entry.held = true;
            return resolve();
          }
          // Said where people look: the run was answered, and now waits for a slot.
          const restore = noteWaiting(entry);
          const waiter: Waiter = {
            entry,
            resolve: () => {
              signal?.removeEventListener('abort', onAbort);
              restore();
              resolve();
            },
          };
          const onAbort = (): void => {
            const at = waiters.indexOf(waiter);
            if (at >= 0) waiters.splice(at, 1);
            reject(signal?.reason);
          };
          signal?.addEventListener('abort', onAbort, { once: true });
          waiters.push(waiter);
        });
      },
    },
    lockProject: (fn, signal) => {
      entry.onLockBegin?.();
      return withProjectLock(entry.projectId ?? '', () => {
        entry.onLockEnd?.();
        // Stopped while it waited for its turn: do not touch the clone.
        if (signal?.aborted) throw signal.reason;
        return fn();
      });
    },
  });

  /** Puts "Waiting for a free slot" on the run's note; the returned function puts the old one back. */
  function noteWaiting(entry: Entry): () => void {
    const id = entry.runId;
    if (id === undefined) return () => undefined;
    try {
      const previous = runs.getRun(id)?.stageNote ?? null;
      runs.updateRun(id, { stageNote: WAITING_NOTE });
      return () => {
        try {
          if (runs.getRun(id)?.stageNote === WAITING_NOTE)
            runs.updateRun(id, { stageNote: previous });
        } catch {
          // The note is informational.
        }
      };
    } catch {
      return () => undefined;
    }
  }

  function withProjectLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    // Whatever the earlier holder did, this one runs next.
    const run = previous.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    locks.set(key, tail);
    void tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key);
    });
    return run;
  }

  // ---- Continuations --------------------------------------------------------------------

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

  /** Runs a continuation of `runId` in this process; the caller has checked everything. */
  const launch = (
    runId: string,
    entry: ContinueEntry,
    projectId: string | undefined,
    takesSlot: boolean,
    /** A continuation taken from the queue: its answer goes back if shutdown stops it at rest. */
    fromQueue?: RunStage,
  ): Entry => {
    const ac = new AbortController();
    const entryRec: Entry = { ac, done: Promise.resolve(), projectId, held: takesSlot, runId };
    live.add(entryRec);
    byId.set(runId, entryRec);
    // Where the run's events stood at the claim: a `stage` event after it means it moved.
    const baseline = fromQueue === undefined ? 0 : (runs.listEvents(runId).at(-1)?.id ?? 0);
    const moved = (): boolean =>
      runs.listEvents(runId, { afterId: baseline }).some((e) => e.type === 'stage');
    /**
     * Shutdown came before the continuation moved the run out of its stage: keep the answer for
     * the next start. A run that moved and came back to the same stage (a resumed run that was
     * interrupted again) has acted on the answer, so it is not queued.
     */
    const requeue = (): boolean => {
      if (fromQueue === undefined || !(ac.signal.reason instanceof ShutdownError)) return false;
      try {
        return !moved() && stageNow(runId) === fromQueue && runs.queueRun(runId, fromQueue, entry);
      } catch {
        return false;
      }
    };
    entryRec.done = (async () => {
      try {
        await continuePipeline(runId, entry, ac.signal, hooksFor(entryRec));
        requeue();
      } catch (err) {
        // The answer that started this could not be carried out: offer the review again
        // (a no-op when the pipeline already did, or the run is no longer resting).
        if (!requeue()) {
          reopenRestDecision(runs, runId, err instanceof Error ? err.message : String(err));
        }
        onError(runId, err);
      } finally {
        live.delete(entryRec);
        if (byId.get(runId) === entryRec) byId.delete(runId);
        entryRec.held = false;
        pump();
      }
    })();
    return entryRec;
  };

  /**
   * Starts (or queues) a continuation for a run that is resting (or stopped, per `startsFrom`).
   * An Entry when it started; 'queued' when no slot was free and the answer was stored in the
   * run's row; undefined when nothing was started.
   */
  const continueEntry = (
    runId: string,
    entry: ContinueEntry,
    startsFrom: (stage: RunStage) => boolean = isResting,
  ): Entry | 'queued' | undefined => {
    if (stopping || byId.has(runId)) return undefined;
    // Checked again here: the caller's view of the run may be stale.
    let run;
    try {
      run = runs.getRun(runId);
    } catch {
      return undefined;
    }
    // A queued run waits for its slot; its stored answer is the one that will be carried out.
    if (!run || run.stage === 'queued' || !startsFrom(run.stage)) return undefined;
    if (needsNoSlot(entry) || hasRoom(run.projectId)) {
      return launch(runId, entry, run.projectId, !needsNoSlot(entry));
    }
    try {
      if (!runs.queueRun(runId, run.stage, entry)) return undefined;
    } catch {
      return undefined;
    }
    noteQueued(runId);
    return 'queued';
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
  const resultOf = async (id: string, e: Entry): Promise<CancelResult> => {
    // The cancel may take a while (a push in progress finishes first): answer once the run has
    // settled; past the wait the abort was delivered but the run has not settled: pending.
    if ((await settleWait(e, cancelWaitMs)) === 'timeout') return 'pending';
    return stageNow(id) === 'cancelled';
  };

  /**
   * Not driven here: a resting or stopped run is cancelled by a continuation that holds it,
   * so it cannot race another one starting.
   */
  const cancelIdle = async (runId: string): Promise<CancelResult> => {
    const started = continueEntry(
      runId,
      { kind: 'cancel' },
      (stage) => isResting(stage) || canResume(stage),
    );
    return started && started !== 'queued' ? resultOf(runId, started) : false;
  };

  /** A run that waits in the queue leaves it: a start ends as cancelled, a continuation goes back to rest first. */
  const cancelQueued = async (runId: string): Promise<CancelResult | undefined> => {
    let taken;
    try {
      taken = runs.cancelQueued(runId);
    } catch {
      return undefined;
    }
    if (taken === undefined) return undefined;
    if (taken === 'cancelled') {
      eventAt(runId, 'run.cancelled', { stage: 'queued' });
      try {
        runs.closeOpenQuestions(runId);
      } catch {
        // Nothing waits on the questions of a run that never started.
      }
      return true;
    }
    // Back where it rested, with its answer dropped: cancel it from there.
    return cancelIdle(runId);
  };

  // ---- Queued starts --------------------------------------------------------------------

  /** Runs a start that was taken from the queue (its row is `setup`, owned by this process). */
  const launchClaimed = (claimed: ClaimedRun): void => {
    const { runId, projectId } = claimed;
    if (claimed.from !== null) {
      launch(runId, claimed.entry as ContinueEntry, projectId, true, claimed.from);
      return;
    }
    const stored = claimed.entry as StoredStart;
    const ac = new AbortController();
    const entry: Entry = { ac, done: Promise.resolve(), projectId, held: true, runId };
    live.add(entry);
    byId.set(runId, entry);
    let started = false;
    entry.done = (async () => {
      try {
        await startPipeline(
          {
            ...stored,
            runId,
            signal: ac.signal,
            onStarted: (id) => {
              started = true;
              runs.finishQueuedStart(id);
            },
          } as RunInput,
          hooksFor(entry),
        );
      } catch (err) {
        if (started) onError(runId, err);
        else failQueuedStart(runId, ac, err);
      } finally {
        live.delete(entry);
        if (byId.get(runId) === entry) byId.delete(runId);
        entry.held = false;
        pump();
      }
    })();
  };

  /** A queued start stopped before its run files existed: nothing was lost, say what happened. */
  const failQueuedStart = (runId: string, ac: AbortController, err: unknown): void => {
    try {
      if (ac.signal.reason instanceof ShutdownError) {
        // The server is stopping: the run keeps its place and starts after the next start.
        runs.requeueStart(runId);
        return;
      }
      runs.finishQueuedStart(runId);
      if (ac.signal.aborted) {
        runs.updateRun(runId, { stage: 'cancelled', stageNote: 'Cancelled before it started' });
        eventAt(runId, 'run.cancelled', { stage: 'setup' });
        return;
      }
      const reason = err instanceof Error ? err.message : String(err);
      runs.updateRun(runId, { stage: 'failed', stageNote: `Could not start: ${reason}` });
      eventAt(runId, 'run.failed', { stage: 'setup', error: reason });
      onError(runId, err);
    } catch (e) {
      onError(runId, e);
    }
  };

  /** Writes a plan to its content-addressed file: a temp file renamed into place. */
  const writePlan = async (planFile: string, text: string): Promise<void> => {
    await mkdir(plansDir, { recursive: true });
    // Same text means same path: write a temp file and rename it into place, so a
    // concurrent start reading this plan never sees it truncated or half-written.
    const tmp = `${planFile}.${randomUUID()}.tmp`;
    await writeFile(tmp, text);
    await rename(tmp, planFile);
  };

  return {
    limits,
    status: () => {
      const perProject: Record<string, number> = {};
      for (const e of live) {
        if (e.held && e.projectId !== undefined) {
          perProject[e.projectId] = (perProject[e.projectId] ?? 0) + 1;
        }
      }
      return {
        inUse: held(),
        maxRuns: limits.maxRuns,
        maxRunsPerProject: limits.maxRunsPerProject,
        perProject,
      };
    },
    withProjectLock,
    pump,

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
      const source: RunSource =
        planFile !== undefined ? { planFile } : { description: description! };

      // Tracked from here, so a shutdown that starts meanwhile aborts this start and waits for
      // its plan file. The plan is written before the slot check: a start that has to queue is
      // then never overtaken by a later one while its file is being written (first in, first out).
      const ac = new AbortController();
      const planWritten =
        planFile !== undefined ? writePlan(planFile, req.planText!) : Promise.resolve();
      const entry: Entry = {
        ac,
        done: planWritten.then(
          () => undefined,
          () => undefined,
        ),
        projectId: project.id,
        held: false,
      };
      live.add(entry);
      try {
        await planWritten;
      } catch (err) {
        live.delete(entry);
        throw err;
      }
      const stoppedError = () =>
        ac.signal.reason instanceof ShutdownError
          ? new Error('The server is shutting down')
          : new Error('The run was cancelled before it started');
      if (ac.signal.aborted) {
        live.delete(entry);
        throw stoppedError();
      }

      // No `await` may come between this check and taking the slot (`entry.held = true` below,
      // or the queue row): other starts, continuations and resumes run in the gaps between
      // awaits, and each of them decides with this same check. An await here would let two of
      // them both see the last free slot and go over the limit.
      if (!hasRoom(project.id)) {
        live.delete(entry);
        if (stopping) throw new Error('The server is shutting down');
        const now = new Date();
        const id = newRunId(now);
        const title =
          req.title ?? (parsed?.ok ? parsed.plan.title : titleFromDescription(description!));
        const stored: StoredStart = {
          repo: project.localPath,
          ...source,
          baseRef: req.baseRef,
          ...(req.title ? { title: req.title } : {}),
          config,
        };
        // The row, with what to do later, is saved before anything answers.
        runs.createQueuedRun(
          {
            id,
            projectId: project.id,
            title,
            stageNote: null,
            branch: '',
            worktreePath: '',
            runDir: defaultRunDir(id),
            baseRef: req.baseRef,
            baseSha: '',
            headSha: null,
            prNumber: null,
            planPath: planFile ?? '',
            planHash: parsed?.ok ? parsed.plan.contentHash : '',
            implementer: null,
            rounds: { checkFix: 0, reviewFix: 0, ciFix: 0, feedback: 0, checkRuns: 0 },
          },
          stored,
        );
        noteQueued(id);
        // A slot may have freed while the row was being written.
        pump();
        return id;
      }

      entry.held = true;
      let runId: string | undefined;
      return new Promise<string>((resolve, reject) => {
        let settled = false;
        const settle = (fn: () => void) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          fn();
        };
        const onTimeout = (): void => {
          // Aborting also stops a preflight that has not created the run yet.
          ac.abort();
          settle(() => reject(new Error(`The run did not start within ${startTimeoutMs} ms`)));
        };
        let timer = setTimeout(onTimeout, startTimeoutMs);
        // Time spent waiting for another run's git work on the project is not the run's own
        // slowness: the timeout pauses while it waits and starts over once it holds the lock.
        entry.onLockBegin = () => clearTimeout(timer);
        entry.onLockEnd = () => {
          if (settled) return;
          clearTimeout(timer);
          timer = setTimeout(onTimeout, startTimeoutMs);
        };

        entry.done = (async () => {
          try {
            if (ac.signal.aborted) throw stoppedError();
            const outcome = await startPipeline(
              {
                repo: project.localPath,
                ...source,
                baseRef: req.baseRef,
                ...(req.title ? { title: req.title } : {}),
                config,
                signal: ac.signal,
                onStarted: (id) => {
                  runId = id;
                  entry.runId = id;
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
              },
              hooksFor(entry),
            );
            settle(() => resolve(outcome.runId));
          } catch (err) {
            if (runId === undefined) settle(() => reject(err as Error));
            else onError(runId, err);
          } finally {
            live.delete(entry);
            if (runId !== undefined && byId.get(runId) === entry) byId.delete(runId);
            entry.held = false;
            pump();
          }
        })();
      });
    },

    continue: (runId, entry) => continueEntry(runId, entry) !== undefined,

    resume(runId, opts = {}) {
      if (stopping || byId.has(runId) || stageNow(runId) === 'queued') return 'busy';
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
        // Never aborted: the continuation still holds the run at rest, nothing was cancelled.
        if (!finished && stageOf(runId) === 'resting') return false;
        if (finished) {
          // It ended (or came to rest, or stopped): cancel what is left, if anything is.
          if (stageNow(runId) === 'cancelled') return true;
          return cancelIdle(runId);
        }
        if (!entry.ac.signal.aborted) entry.ac.abort();
        return resultOf(runId, entry);
      }
      if (stageNow(runId) === 'queued') {
        const result = await cancelQueued(runId);
        if (result !== undefined) return result;
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
