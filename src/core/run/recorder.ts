import { hostname } from 'node:os';
import type {
  DecisionAnswer,
  DecisionKind,
  DecisionOption,
  RunStore,
  StageKind,
  StageState,
} from '../store/runs.js';
import type { RunLog } from './events.js';
import type { RunState } from './run-state.js';
import { waitForAnswer } from './wait.js';

export interface RecorderOptions {
  /** Process recorded as the run's owner (default: this process). */
  pid?: number;
  host?: string;
}

/**
 * The single place the pipeline records facts about a run: events always go to
 * `run-events.jsonl` (via RunLog), and, when a store is given, everything is mirrored to the
 * run tables. A store failure never escapes: it is logged as a file-only `db.error` event and
 * the run carries on with the files as its record.
 */
export class RunRecorder {
  private created = false;
  private runId: string | null = null;
  private stageId: number | null = null;
  private permissions: number[] = [];
  private readonly pid: number;
  private readonly host: string;

  constructor(
    private readonly log: RunLog,
    private readonly store?: RunStore,
    opts: RecorderOptions = {},
  ) {
    this.pid = opts.pid ?? process.pid;
    this.host = opts.host ?? hostname();
  }

  /** Mirrors a saved `run.json`: creates the project and run rows first time, updates after. */
  state(st: RunState): void {
    this.runId = st.id;
    const fields = {
      title: st.title,
      stage: st.stage,
      stageNote: st.stageNote,
      branch: st.branch,
      worktreePath: st.worktreePath,
      baseRef: st.baseRef,
      baseSha: st.baseSha,
      headSha: st.headSha,
      prNumber: st.prNumber,
      planPath: st.planPath,
      planHash: st.planHash,
      implementer: st.implementer,
      rounds: st.rounds,
    };
    if (this.created) {
      this.db('updateRun', (s) => s.updateRun(st.id, fields));
      return;
    }
    this.db('createRun', (s) => {
      // A registered project keeps its default base: this run's base may be any branch.
      const project =
        s.listProjects().find((p) => p.localPath === st.repoPath) ??
        s.upsertProject({
          owner: st.owner,
          repo: st.repo,
          localPath: st.repoPath,
          defaultBase: st.baseRef,
        });
      s.createRun({
        id: st.id,
        projectId: project.id,
        ...fields,
        runDir: this.log.runDir,
        ownerPid: this.pid,
        ownerHost: this.host,
        createdAt: st.createdAt,
        updatedAt: st.updatedAt,
      });
      this.created = true;
    });
  }

  /** Adopts an existing run row (a continuation after rest): this process becomes its owner. */
  resume(st: RunState): void {
    this.runId = st.id;
    this.created = true;
    this.db('claimRun', (s) => s.updateRun(st.id, { ownerPid: this.pid, ownerHost: this.host }));
  }

  /** Clears the run's owner: nothing drives a run that is resting, so reconciliation skips it. */
  release(): void {
    this.withRun('releaseRun', (s, runId) =>
      s.updateRun(runId, { ownerPid: null, ownerHost: null }),
    );
  }

  /** Logs an event to the file (and terminal), then to `run_events` under the open stage. */
  event(type: string, data?: Record<string, unknown>): void {
    const ts = this.log.log(type, data);
    this.withRun('appendEvent', (s, runId) =>
      s.appendEvent({ runId, stageId: this.stageId, ts, type, payload: data }),
    );
  }

  /** Records a stage execution as running; later events belong to it until `endStage`. */
  startStage(kind: StageKind, round: number, input?: unknown): void {
    this.stageId =
      this.withRun('startStage', (s, runId) => s.startStage({ runId, kind, round, input })) ?? null;
  }

  /** Ends the open stage execution, if any. */
  endStage(state: Exclude<StageState, 'running'>, output?: unknown): void {
    const id = this.stageId;
    this.stageId = null;
    if (id !== null) this.withRun('endStage', (s) => s.endStage(id, { state, output }));
  }

  /** Opens a decision; returns its id, or null when the database is unavailable. */
  openDecision(
    kind: DecisionKind,
    title: string,
    body: string,
    attach: string | null,
    options?: DecisionOption[],
  ): number | null {
    return this.openDecisionId(kind, title, body, attach, options) ?? null;
  }

  /** Dismisses the run's open optioned decisions; call when the run has ended. */
  closeOpenQuestions(): void {
    this.withRun('closeOpenQuestions', (s, runId) => s.closeOpenQuestions(runId));
  }

  /** Waits for decision `id` to be answered and records `decision.answered`. */
  async awaitDecision(id: number, signal?: AbortSignal): Promise<DecisionAnswer> {
    const store = this.store;
    if (!store) throw new Error('Cannot await a decision without a store');
    const answer = await waitForAnswer(store, id, { signal });
    this.event('decision.answered', { id, choice: answer.choice });
    return answer;
  }

  /**
   * Opens a `permission` decision, resolved by the next `resolvePermissions`. While one is
   * open, further waits (Claude reports each prompt twice, and may prompt again) add nothing.
   */
  permissionWait(message: string, attach: string | null): void {
    if (this.permissions.length > 0) return;
    const id = this.openDecisionId('permission', 'Implementer needs approval', message, attach);
    if (id !== undefined) this.permissions.push(id);
  }

  /** Resolves every permission decision opened since the last call (the turn has ended). */
  resolvePermissions(): void {
    const ids = this.permissions;
    this.permissions = [];
    for (const id of ids) this.withRun('resolveDecision', (s) => s.resolveDecision(id));
  }

  private openDecisionId(
    kind: DecisionKind,
    title: string,
    body: string,
    attach: string | null,
    options?: DecisionOption[],
  ): number | undefined {
    return this.withRun('openDecision', (s, runId) =>
      s.openDecision({ runId, kind, title, body, attach, options }),
    );
  }

  /** Runs a write that needs the run row; skipped until that row exists. */
  private withRun<T>(op: string, fn: (s: RunStore, runId: string) => T): T | undefined {
    const runId = this.runId;
    if (!this.created || runId === null) return undefined;
    return this.db(op, (s) => fn(s, runId));
  }

  private db<T>(op: string, fn: (s: RunStore) => T): T | undefined {
    if (!this.store) return undefined;
    try {
      return fn(this.store);
    } catch (e) {
      // File only: mirroring this event to the failing store would just fail again.
      try {
        this.log.log('db.error', { op, error: e instanceof Error ? e.message : String(e) });
      } catch {
        // The file record is best effort here too; never fail the run over it.
      }
      return undefined;
    }
  }
}
