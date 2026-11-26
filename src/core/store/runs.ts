import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { ACTIVE_STAGES, RESTING_STAGES, type RunStage } from '../run/machine.js';
import type { RunState } from '../run/run-state.js';

/** A local checkout block-party runs against. Keyed by `localPath`. */
export interface Project {
  id: string;
  owner: string;
  repo: string;
  localPath: string;
  defaultBase: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunRow {
  id: string;
  projectId: string;
  title: string;
  stage: RunStage;
  stageNote: string | null;
  branch: string;
  worktreePath: string;
  runDir: string;
  baseRef: string;
  baseSha: string;
  headSha: string | null;
  prNumber: number | null;
  planPath: string;
  planHash: string;
  implementer: RunState['implementer'];
  rounds: RunState['rounds'];
  /** Process that currently drives the run, so others can tell whether it is still alive. */
  ownerPid: number | null;
  ownerHost: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `createdAt`/`updatedAt` default to now. */
export type RunInput = Omit<RunRow, 'createdAt' | 'updatedAt'> & {
  createdAt?: string;
  updatedAt?: string;
};

/** Columns `updateRun` may change; `updatedAt` is always set to now. */
export type RunPatch = Partial<Omit<RunRow, 'id' | 'createdAt' | 'updatedAt'>>;

export type StageKind =
  'implement' | 'check-fix' | 'review-fix' | 'checks' | 'review' | 'publish' | 'wait-ci';

export type StageState = 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled';

export interface StageRow {
  id: number;
  runId: string;
  kind: StageKind;
  round: number;
  state: StageState;
  input: unknown;
  output: unknown;
  startedAt: string;
  endedAt: string | null;
}

export interface RunEventRow {
  id: number;
  runId: string;
  stageId: number | null;
  ts: string;
  type: string;
  payload: unknown;
}

export type DecisionKind =
  | 'blocked'
  | 'permission'
  | 'interrupted'
  | 'cap_reached'
  | 'failed'
  | 'plan_approval'
  | 'finding_triage'
  | 'dispute'
  | 'broad_fix'
  | 'final_review'
  | 'ci_gap';
export type DecisionStatus = 'open' | 'answered' | 'resolved' | 'dismissed';

/** One choice a decision offers. */
export interface DecisionOption {
  id: string;
  label: string;
}

/** The person's answer: one of the option ids, and an optional note. */
export interface DecisionAnswer {
  choice: string;
  note: string | null;
}

export type AnswerResult = 'answered' | 'not_open' | 'bad_choice';

/** An inbox item: something a run needs a human for. */
export interface Decision {
  id: number;
  runId: string;
  kind: DecisionKind;
  status: DecisionStatus;
  title: string;
  body: string;
  attach: string | null;
  createdAt: string;
  /** When it left `open` (resolved or dismissed). */
  resolvedAt: string | null;
  /** The fixed choices, or null for an item that can only be dismissed. */
  options: DecisionOption[] | null;
  answer: DecisionAnswer | null;
  answeredAt: string | null;
}

export interface RunStore {
  /** Inserts the project for `localPath`, or updates owner, repo and default base if it exists. */
  upsertProject(input: {
    owner: string;
    repo: string;
    localPath: string;
    defaultBase: string;
  }): Project;
  listProjects(): Project[];
  getProject(id: string): Project | undefined;

  createRun(input: RunInput): RunRow;
  /** Changes only the given columns and bumps `updatedAt`; undefined if the run doesn't exist. */
  updateRun(id: string, patch: RunPatch): RunRow | undefined;
  getRun(id: string): RunRow | undefined;
  /**
   * Newest first by `updatedAt`. `active` keeps only runs in an active stage, `resting` only
   * runs waiting at rest for a person.
   */
  listRuns(opts?: { limit?: number; active?: boolean; resting?: boolean }): RunRow[];

  /** Records a stage execution as `running`; returns its id. */
  startStage(input: { runId: string; kind: StageKind; round: number; input?: unknown }): number;
  /** Ends a running stage execution; false if it doesn't exist or already ended. */
  endStage(
    id: number,
    result: { state: Exclude<StageState, 'running'>; output?: unknown },
  ): boolean;
  /** In start order. */
  listStages(runId: string): StageRow[];

  appendEvent(input: {
    runId: string;
    stageId?: number | null;
    ts: string;
    type: string;
    payload?: unknown;
  }): number;
  /** Ascending by id; `afterId` keeps only later events. */
  listEvents(runId: string, opts?: { afterId?: number; limit?: number }): RunEventRow[];
  /** Highest event id over all runs; 0 when there are none. */
  latestEventId(): number;

  openDecision(input: {
    runId: string;
    kind: DecisionKind;
    title: string;
    body: string;
    attach?: string | null;
    options?: DecisionOption[] | null;
  }): number;
  getDecision(id: number): Decision | undefined;
  /**
   * Records the answer to an open decision whose options include `answer.choice`, atomically:
   * a second answer gets `not_open`.
   */
  answerDecision(id: number, answer: DecisionAnswer): AnswerResult;
  /** Marks an open (or answered) decision resolved; returns whether a row changed. */
  resolveDecision(id: number): boolean;
  /** Marks an open decision dismissed; returns whether a row changed. */
  dismissDecision(id: number): boolean;
  /** Newest first. */
  listDecisions(opts?: { status?: DecisionStatus; runId?: string }): Decision[];
  openDecisionCount(): number;
}

interface ProjectDb {
  id: string;
  owner: string;
  repo: string;
  local_path: string;
  default_base: string;
  created_at: string;
  updated_at: string;
}

interface RunDb {
  id: string;
  project_id: string;
  title: string;
  stage: string;
  stage_note: string | null;
  branch: string;
  worktree_path: string;
  run_dir: string;
  base_ref: string;
  base_sha: string;
  head_sha: string | null;
  pr_number: number | null;
  plan_path: string;
  plan_hash: string;
  implementer_json: string | null;
  rounds_json: string;
  owner_pid: number | null;
  owner_host: string | null;
  created_at: string;
  updated_at: string;
}

interface StageDb {
  id: number;
  run_id: string;
  kind: string;
  round: number;
  state: string;
  input_json: string | null;
  output_json: string | null;
  started_at: string;
  ended_at: string | null;
}

interface EventDb {
  id: number;
  run_id: string;
  stage_id: number | null;
  ts: string;
  type: string;
  payload_json: string | null;
}

interface DecisionDb {
  id: number;
  run_id: string;
  kind: string;
  status: string;
  title: string;
  body: string;
  attach: string | null;
  created_at: string;
  resolved_at: string | null;
  options_json: string | null;
  answer_json: string | null;
  answered_at: string | null;
}

/** RunRow field → column. Drives inserts and patches; the only SQL built from field names. */
const RUN_COLUMNS: Record<keyof Omit<RunRow, 'id'>, string> = {
  projectId: 'project_id',
  title: 'title',
  stage: 'stage',
  stageNote: 'stage_note',
  branch: 'branch',
  worktreePath: 'worktree_path',
  runDir: 'run_dir',
  baseRef: 'base_ref',
  baseSha: 'base_sha',
  headSha: 'head_sha',
  prNumber: 'pr_number',
  planPath: 'plan_path',
  planHash: 'plan_hash',
  implementer: 'implementer_json',
  rounds: 'rounds_json',
  ownerPid: 'owner_pid',
  ownerHost: 'owner_host',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const JSON_FIELDS = new Set<string>(['implementer', 'rounds']);

function toJson(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function fromJson(text: string | null): unknown {
  return text === null ? null : JSON.parse(text);
}

function columnValue(field: string, value: unknown): unknown {
  return JSON_FIELDS.has(field) ? toJson(value) : value;
}

function toProject(r: ProjectDb): Project {
  return {
    id: r.id,
    owner: r.owner,
    repo: r.repo,
    localPath: r.local_path,
    defaultBase: r.default_base,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toRun(r: RunDb): RunRow {
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    stage: r.stage as RunStage,
    stageNote: r.stage_note,
    branch: r.branch,
    worktreePath: r.worktree_path,
    runDir: r.run_dir,
    baseRef: r.base_ref,
    baseSha: r.base_sha,
    headSha: r.head_sha,
    prNumber: r.pr_number,
    planPath: r.plan_path,
    planHash: r.plan_hash,
    implementer: fromJson(r.implementer_json) as RunRow['implementer'],
    rounds: fromJson(r.rounds_json) as RunRow['rounds'],
    ownerPid: r.owner_pid,
    ownerHost: r.owner_host,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toStage(r: StageDb): StageRow {
  return {
    id: r.id,
    runId: r.run_id,
    kind: r.kind as StageKind,
    round: r.round,
    state: r.state as StageState,
    input: fromJson(r.input_json),
    output: fromJson(r.output_json),
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

function toEvent(r: EventDb): RunEventRow {
  return {
    id: r.id,
    runId: r.run_id,
    stageId: r.stage_id,
    ts: r.ts,
    type: r.type,
    payload: fromJson(r.payload_json),
  };
}

function toDecision(r: DecisionDb): Decision {
  return {
    id: r.id,
    runId: r.run_id,
    kind: r.kind as DecisionKind,
    status: r.status as DecisionStatus,
    title: r.title,
    body: r.body,
    attach: r.attach,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    options: fromJson(r.options_json) as DecisionOption[] | null,
    answer: fromJson(r.answer_json) as DecisionAnswer | null,
    answeredAt: r.answered_at,
  };
}

const now = (): string => new Date().toISOString();

/**
 * `at`, or 1 ms after `previous` when the clock hasn't moved past it: `updatedAt` must
 * strictly increase, because readers detect run changes by comparing it.
 */
function later(at: string, previous: string): string {
  const prev = Date.parse(previous);
  return Number.isNaN(prev) || Date.parse(at) > prev ? at : new Date(prev + 1).toISOString();
}

/**
 * Typed access to the run tables. Every write is a single statement (or one short
 * transaction), since the CLI and the server share the database file.
 */
export function createRunStore(db: Database.Database): RunStore {
  const upsertProjectStmt = db.prepare(`
    INSERT INTO projects (id, owner, repo, local_path, default_base, created_at, updated_at)
    VALUES (@id, @owner, @repo, @localPath, @defaultBase, @at, @at)
    ON CONFLICT (local_path) DO UPDATE SET
      owner = excluded.owner, repo = excluded.repo, default_base = excluded.default_base,
      updated_at = excluded.updated_at`);
  const projectByPath = db.prepare<[string], ProjectDb>(
    'SELECT * FROM projects WHERE local_path = ?',
  );
  const projectById = db.prepare<[string], ProjectDb>('SELECT * FROM projects WHERE id = ?');
  const allProjects = db.prepare<[], ProjectDb>(
    'SELECT * FROM projects ORDER BY owner, repo, local_path',
  );

  const runFields = Object.keys(RUN_COLUMNS) as (keyof typeof RUN_COLUMNS)[];
  const insertRun = db.prepare(
    `INSERT INTO runs (id, ${runFields.map((f) => RUN_COLUMNS[f]).join(', ')})
     VALUES (@id, ${runFields.map((f) => `@${f}`).join(', ')})`,
  );
  const runById = db.prepare<[string], RunDb>('SELECT * FROM runs WHERE id = ?');
  const activeList = ACTIVE_STAGES.map((s) => `'${s}'`).join(', ');
  const restingList = RESTING_STAGES.map((s) => `'${s}'`).join(', ');
  const listRunsResting = db.prepare<[number], RunDb>(
    `SELECT * FROM runs WHERE stage IN (${restingList})
     ORDER BY updated_at DESC, rowid DESC LIMIT ?`,
  );
  const listRunsAll = db.prepare<[number], RunDb>(
    'SELECT * FROM runs ORDER BY updated_at DESC, rowid DESC LIMIT ?',
  );
  const listRunsActive = db.prepare<[number], RunDb>(
    `SELECT * FROM runs WHERE stage IN (${activeList})
     ORDER BY updated_at DESC, rowid DESC LIMIT ?`,
  );

  const insertStage = db.prepare(`
    INSERT INTO stages (run_id, kind, round, state, input_json, started_at)
    VALUES (?, ?, ?, 'running', ?, ?)`);
  const finishStage = db.prepare(`
    UPDATE stages SET state = ?, output_json = ?, ended_at = ?
    WHERE id = ? AND state = 'running'`);
  const stagesByRun = db.prepare<[string], StageDb>(
    'SELECT * FROM stages WHERE run_id = ? ORDER BY id',
  );

  const insertEvent = db.prepare(`
    INSERT INTO run_events (run_id, stage_id, ts, type, payload_json) VALUES (?, ?, ?, ?, ?)`);
  const eventsByRun = db.prepare<[string, number, number], EventDb>(
    'SELECT * FROM run_events WHERE run_id = ? AND id > ? ORDER BY id LIMIT ?',
  );
  const maxEventId = db.prepare<[], { id: number | null }>('SELECT max(id) AS id FROM run_events');

  const insertDecision = db.prepare(`
    INSERT INTO decisions (run_id, kind, status, title, body, attach, created_at, options_json)
    VALUES (?, ?, 'open', ?, ?, ?, ?, ?)`);
  const closeDecision = db.prepare(`
    UPDATE decisions SET status = ?, resolved_at = ? WHERE id = ? AND status = 'open'`);
  const resolveStmt = db.prepare(`
    UPDATE decisions SET status = 'resolved', resolved_at = ?
    WHERE id = ? AND status IN ('open', 'answered')`);
  const decisionById = db.prepare<[number], DecisionDb>('SELECT * FROM decisions WHERE id = ?');
  const answerStmt = db.prepare(`
    UPDATE decisions SET status = 'answered', answer_json = ?, answered_at = ?
    WHERE id = ? AND status = 'open'`);
  const listDecisionsStmt = db.prepare<
    { status: string | null; runId: string | null },
    DecisionDb
  >(`
    SELECT * FROM decisions
    WHERE (@status IS NULL OR status = @status) AND (@runId IS NULL OR run_id = @runId)
    ORDER BY created_at DESC, id DESC`);
  const openCount = db.prepare<[], { n: number }>(
    "SELECT count(*) AS n FROM decisions WHERE status = 'open'",
  );

  // SQLite treats a negative LIMIT as "no limit".
  const limitOf = (limit: number | undefined): number => limit ?? -1;

  const getRun = (id: string): RunRow | undefined => {
    const row = runById.get(id);
    return row ? toRun(row) : undefined;
  };

  return {
    upsertProject(input) {
      return db
        .transaction((): Project => {
          upsertProjectStmt.run({ id: randomUUID(), ...input, at: now() });
          return toProject(projectByPath.get(input.localPath) as ProjectDb);
        })
        .immediate();
    },
    listProjects() {
      return allProjects.all().map(toProject);
    },
    getProject(id) {
      const row = projectById.get(id);
      return row ? toProject(row) : undefined;
    },

    createRun(input) {
      const at = now();
      const full: RunRow = {
        ...input,
        createdAt: input.createdAt ?? at,
        updatedAt: input.updatedAt ?? at,
      };
      const params: Record<string, unknown> = { id: full.id };
      for (const f of runFields) params[f] = columnValue(f, full[f]);
      return db
        .transaction((): RunRow => {
          insertRun.run(params);
          return getRun(full.id) as RunRow;
        })
        .immediate();
    },
    updateRun(id, patch) {
      // Keys are checked at runtime too: a caller may pass a wider object than RunPatch.
      const fields = Object.keys(patch).filter(
        (f): f is keyof RunPatch =>
          f in RUN_COLUMNS &&
          f !== 'createdAt' &&
          f !== 'updatedAt' &&
          patch[f as keyof RunPatch] !== undefined,
      );
      const sets = ['updated_at = @updatedAt'];
      const params: Record<string, unknown> = { id };
      for (const f of fields) {
        sets.push(`${RUN_COLUMNS[f]} = @${f}`);
        params[f] = columnValue(f, patch[f]);
      }
      const stmt = db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = @id`);
      // One transaction, so the returned row is the one this call wrote even when another
      // handle (the CLI or the server) writes the same run concurrently.
      return db
        .transaction((): RunRow | undefined => {
          const current = runById.get(id);
          if (!current) return undefined;
          params.updatedAt = later(now(), current.updated_at);
          stmt.run(params);
          return getRun(id);
        })
        .immediate();
    },
    getRun,
    listRuns(opts = {}) {
      const stmt = opts.active ? listRunsActive : opts.resting ? listRunsResting : listRunsAll;
      return stmt.all(limitOf(opts.limit)).map(toRun);
    },

    startStage({ runId, kind, round, input }) {
      return Number(insertStage.run(runId, kind, round, toJson(input), now()).lastInsertRowid);
    },
    endStage(id, { state, output }) {
      return finishStage.run(state, toJson(output), now(), id).changes > 0;
    },
    listStages(runId) {
      return stagesByRun.all(runId).map(toStage);
    },

    appendEvent({ runId, stageId, ts, type, payload }) {
      return Number(
        insertEvent.run(runId, stageId ?? null, ts, type, toJson(payload)).lastInsertRowid,
      );
    },
    listEvents(runId, opts = {}) {
      return eventsByRun.all(runId, opts.afterId ?? 0, limitOf(opts.limit)).map(toEvent);
    },
    latestEventId() {
      return maxEventId.get()?.id ?? 0;
    },

    openDecision({ runId, kind, title, body, attach, options }) {
      return Number(
        insertDecision.run(runId, kind, title, body, attach ?? null, now(), toJson(options))
          .lastInsertRowid,
      );
    },
    getDecision(id) {
      const row = decisionById.get(id);
      return row ? toDecision(row) : undefined;
    },
    answerDecision(id, answer) {
      return db
        .transaction((): AnswerResult => {
          const row = decisionById.get(id);
          if (!row || row.status !== 'open') return 'not_open';
          const options = fromJson(row.options_json) as DecisionOption[] | null;
          if (!options?.some((o) => o.id === answer.choice)) return 'bad_choice';
          const stored: DecisionAnswer = { choice: answer.choice, note: answer.note ?? null };
          return answerStmt.run(JSON.stringify(stored), now(), id).changes > 0
            ? 'answered'
            : 'not_open';
        })
        .immediate();
    },
    resolveDecision(id) {
      return resolveStmt.run(now(), id).changes > 0;
    },
    dismissDecision(id) {
      return closeDecision.run('dismissed', now(), id).changes > 0;
    },
    listDecisions(opts = {}) {
      return listDecisionsStmt
        .all({ status: opts.status ?? null, runId: opts.runId ?? null })
        .map(toDecision);
    },
    openDecisionCount() {
      return openCount.get()?.n ?? 0;
    },
  };
}
