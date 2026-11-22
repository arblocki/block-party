import { hostname } from 'node:os';
import type { DecisionKind, RunStore, StageKind, StageState } from '../store/runs.js';
import type { RunLog } from './events.js';
import type { RunState } from './run-state.js';

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
      const project = s.upsertProject({
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

  openDecision(kind: DecisionKind, title: string, body: string, attach: string | null): void {
    this.openDecisionId(kind, title, body, attach);
  }

  /** Opens a `permission` decision, resolved by the next `resolvePermissions`. */
  permissionWait(message: string, attach: string | null): void {
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
  ): number | undefined {
    return this.withRun('openDecision', (s, runId) =>
      s.openDecision({ runId, kind, title, body, attach }),
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
