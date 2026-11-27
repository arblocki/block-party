import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  ACTIVE_STAGES,
  assertTransition,
  canResume,
  canTransition,
  isTerminal,
  RESTING_STAGES,
  type RunStage,
} from '../run/machine.js';
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
  | 'implement'
  | 'check-fix'
  | 'review-fix'
  | 'ci-fix'
  | 'feedback'
  /** A turn that settles a worktree's uncommitted changes the owner chose to keep. */
  | 'resume-commit'
  | 'checks'
  | 'review'
  | 'publish'
  | 'wait-ci'
  | 'plan';

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
  | 'ci_gap'
  | 'resume_conflict';
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

export type AnswerResult = 'answered' | 'not_open' | 'bad_choice' | 'run_ended';

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

export type PlanStatus = 'draft' | 'approved' | 'superseded';

/** One version of a run's plan. */
export interface PlanRow {
  id: number;
  runId: string;
  version: number;
  path: string;
  contentHash: string;
  title: string;
  status: PlanStatus;
  createdBy: 'agent' | 'me';
  /** The note that asked for this version; null for the first. */
  feedback: string | null;
  createdAt: string;
}

export interface PlanInput {
  runId: string;
  version: number;
  path: string;
  contentHash: string;
  title: string;
  /** Default `draft`. */
  status?: 'draft' | 'approved';
  createdBy: 'agent' | 'me';
  feedback?: string | null;
}

export type FindingTriage = 'auto_fix' | 'ask' | 'record';
export type FindingStatus = 'open' | 'fixed' | 'disputed' | 'deferred' | 'wont_fix' | 'skipped';

/** One Codex finding of a run. `key` is `r<round>:<id>`, unique within the run. */
export interface FindingRow {
  runId: string;
  round: number;
  /** The reviewer's id for it, which restarts every round. */
  id: string;
  key: string;
  reviewedSha: string;
  severity: 'P0' | 'P1' | 'P2' | 'P3';
  category: string;
  title: string;
  body: string;
  location: { path: string; startLine: number; endLine: number } | null;
  confidence: 'high' | 'medium' | 'low';
  suggestedFix: string | null;
  /** Key of the earlier finding this one raises again. */
  repeatOf: string | null;
  triage: FindingTriage;
  status: FindingStatus;
  resolutionNote: string | null;
  updatedAt: string;
}

/** What the store needs of a reviewer finding (a structural subset of `Finding`). */
export interface FindingInput {
  id: string;
  reviewedSha: string;
  severity: FindingRow['severity'];
  category: string;
  title: string;
  body: string;
  location: FindingRow['location'];
  confidence: FindingRow['confidence'];
  suggestedFix: string | null;
  repeatOf?: string | null;
}

/** A run waiting for a slot, and what it will do when it gets one. */
export interface QueuedRun {
  runId: string;
  projectId: string;
  queuedAt: string;
  /** The stage a continuation queued from; null for a run that has not started yet. */
  from: RunStage | null;
  entry: unknown;
}

export interface ClaimedRun extends QueuedRun {
  run: RunRow;
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
  /**
   * Records a run that starts later: the row is created in `queued` (no owner) with `entry`,
   * what to do once a slot is free, and when it began to wait. The row is durable when this
   * returns.
   */
  createQueuedRun(
    input: Omit<RunInput, 'stage' | 'ownerPid' | 'ownerHost'>,
    entry: unknown,
  ): RunRow;
  /**
   * Moves a resting or stopped run (in stage `from`) to `queued` with the answer it was given;
   * false (and nothing changed) when the run is not in `from` any more.
   */
  queueRun(runId: string, from: RunStage, entry: unknown): boolean;
  /** Runs waiting for a slot, oldest first (a run keeps its place across restarts). */
  listQueued(): QueuedRun[];
  /**
   * Takes the oldest queued run for which `fits(projectId)` is true, in one transaction, so two
   * claims never take the same run. A start moves to `setup` and is owned by `owner` (its entry
   * stays until `finishQueuedStart`); a continuation goes back to the stage it queued from, with
   * no owner, and its entry is cleared. Undefined when nothing fits.
   */
  claimQueued(opts: {
    fits: (projectId: string) => boolean;
    owner: { pid: number; host: string };
  }): ClaimedRun | undefined;
  /** A claimed start has created its run files: it no longer needs its stored entry. */
  finishQueuedStart(runId: string): void;
  /** Puts a claimed start that never got going back at its place in the queue; false if it can't. */
  requeueStart(runId: string): boolean;
  /**
   * Takes a run out of the queue: a queued start becomes `cancelled`; a queued continuation goes
   * back to the stage it queued from (the caller then cancels it from there). Undefined when
   * the run is not queued.
   */
  cancelQueued(runId: string): 'cancelled' | 'restored' | undefined;
  /** Changes only the given columns and bumps `updatedAt`; undefined if the run doesn't exist. */
  updateRun(id: string, patch: RunPatch): RunRow | undefined;
  getRun(id: string): RunRow | undefined;
  /**
   * The newest run (by `createdAt`) that opened PR `prNumber` of owner/repo, or undefined.
   * Owner and repo compare case-insensitively, as GitHub names do.
   */
  findRunByPr(owner: string, repo: string, prNumber: number): RunRow | undefined;
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
  /** Bytes of the run's hook events file already copied into `run_events` (0 if none). */
  getHookOffset(runId: string): number;
  /** Moves the run's hook offset forward to `offset` (never back); the live watcher calls it. */
  advanceHookOffset(runId: string, offset: number): void;
  /**
   * Appends `events` (derived ones, never raw hook lines) and moves the run's hook offset to `nextOffset` in one transaction, so a
   * crash replays a batch whole or not at all. Does nothing when `nextOffset` is not past the
   * stored offset.
   */
  replayHookEvents(
    runId: string,
    events: { ts: string; type: string; payload?: unknown }[],
    nextOffset: number,
  ): number;

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
  /**
   * Dismisses the run's open decisions that have options (nobody is left to act on an
   * answer once the run ended); returns how many it closed.
   */
  closeOpenQuestions(runId: string): number;
  /** Marks an open (or answered) decision resolved; returns whether a row changed. */
  resolveDecision(id: number): boolean;
  /** Marks an open decision dismissed; returns whether a row changed. */
  dismissDecision(id: number): boolean;
  /** Newest first. */
  listDecisions(opts?: { status?: DecisionStatus; runId?: string }): Decision[];
  openDecisionCount(): number;

  /**
   * Stores a review round's findings, all `open`. Storing a round again replaces its rows,
   * which resets their statuses and notes. A repeated finding id within the round is skipped.
   */
  insertFindings(
    runId: string,
    round: number,
    findings: FindingInput[],
    triage: (f: FindingInput) => FindingTriage,
  ): void;
  /** `key` is `r<round>:<id>`; returns whether a row changed. */
  setFindingStatus(runId: string, key: string, status: FindingStatus, note: string | null): boolean;
  /** By round, then in the reviewer's order. */
  listFindings(runId: string): FindingRow[];

  /** Stores a plan version; throws if the run already has that version. */
  addPlanVersion(input: PlanInput): PlanRow;
  /**
   * Approves `version` and supersedes the run's other versions, in one transaction; false
   * (and nothing changed) when the run has no such version.
   */
  approvePlan(runId: string, version: number): boolean;
  /** Ascending by version. */
  listPlans(runId: string): PlanRow[];
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
  queued_entry: string | null;
  queued_at: string | null;
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

interface FindingDb {
  run_id: string;
  round: number;
  finding_id: string;
  key: string;
  reviewed_sha: string;
  severity: string;
  category: string;
  title: string;
  body: string;
  path: string | null;
  start_line: number | null;
  end_line: number | null;
  confidence: string;
  suggested_fix: string | null;
  repeat_of: string | null;
  triage: string;
  status: string;
  resolution_note: string | null;
  updated_at: string;
}

interface PlanDb {
  id: number;
  run_id: string;
  version: number;
  path: string;
  content_hash: string;
  title: string;
  status: string;
  created_by: string;
  feedback: string | null;
  created_at: string;
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

function toFinding(r: FindingDb): FindingRow {
  return {
    runId: r.run_id,
    round: r.round,
    id: r.finding_id,
    key: `r${r.round}:${r.finding_id}`,
    reviewedSha: r.reviewed_sha,
    severity: r.severity as FindingRow['severity'],
    category: r.category,
    title: r.title,
    body: r.body,
    location:
      r.path !== null && r.start_line !== null && r.end_line !== null
        ? { path: r.path, startLine: r.start_line, endLine: r.end_line }
        : null,
    confidence: r.confidence as FindingRow['confidence'],
    suggestedFix: r.suggested_fix,
    repeatOf: r.repeat_of,
    triage: r.triage as FindingTriage,
    status: r.status as FindingStatus,
    resolutionNote: r.resolution_note,
    updatedAt: r.updated_at,
  };
}

function toPlan(r: PlanDb): PlanRow {
  return {
    id: r.id,
    runId: r.run_id,
    version: r.version,
    path: r.path,
    contentHash: r.content_hash,
    title: r.title,
    status: r.status as PlanStatus,
    createdBy: r.created_by as PlanRow['createdBy'],
    feedback: r.feedback,
    createdAt: r.created_at,
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
  const runByPr = db.prepare<[string, string, number], RunDb>(
    `SELECT r.* FROM runs r JOIN projects p ON p.id = r.project_id
     WHERE p.owner = ? COLLATE NOCASE AND p.repo = ? COLLATE NOCASE AND r.pr_number = ?
     ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1`,
  );
  const listRunsAll = db.prepare<[number], RunDb>(
    'SELECT * FROM runs ORDER BY updated_at DESC, rowid DESC LIMIT ?',
  );
  const listRunsActive = db.prepare<[number], RunDb>(
    `SELECT * FROM runs WHERE stage IN (${activeList})
     ORDER BY updated_at DESC, rowid DESC LIMIT ?`,
  );

  const queuedRows = db.prepare<[], RunDb>(
    `SELECT * FROM runs WHERE stage = 'queued' AND queued_entry IS NOT NULL
     ORDER BY queued_at, rowid`,
  );
  const setQueued = db.prepare(
    `UPDATE runs SET stage = 'queued', stage_note = @note, owner_pid = NULL, owner_host = NULL,
       queued_entry = @entry, queued_at = @queuedAt, updated_at = @updatedAt
     WHERE id = @id`,
  );
  const setClaimedStart = db.prepare(
    `UPDATE runs SET stage = 'setup', stage_note = NULL, owner_pid = @pid, owner_host = @host,
       updated_at = @updatedAt
     WHERE id = @id AND stage = 'queued'`,
  );
  const setClaimedContinue = db.prepare(
    `UPDATE runs SET stage = @from, stage_note = @note, owner_pid = NULL, owner_host = NULL,
       queued_entry = NULL, queued_at = NULL, updated_at = @updatedAt
     WHERE id = @id AND stage = 'queued'`,
  );
  const clearQueuedStart = db.prepare(
    'UPDATE runs SET queued_entry = NULL, queued_at = NULL WHERE id = @id',
  );
  const setCancelledQueued = db.prepare(
    `UPDATE runs SET stage = 'cancelled', stage_note = 'Cancelled while waiting for a free slot',
       queued_entry = NULL, queued_at = NULL, updated_at = @updatedAt
     WHERE id = @id AND stage = 'queued'`,
  );
  const setRequeuedStart = db.prepare(
    `UPDATE runs SET stage = 'queued', stage_note = @note, owner_pid = NULL, owner_host = NULL,
       updated_at = @updatedAt
     WHERE id = @id AND queued_entry IS NOT NULL AND stage = 'setup'`,
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
  const hookOffset = db.prepare<[string], { byte_offset: number }>(
    'SELECT byte_offset FROM run_hook_offsets WHERE run_id = ?',
  );
  const advanceOffset = db.prepare(`
    INSERT INTO run_hook_offsets (run_id, byte_offset) VALUES (?, ?)
    ON CONFLICT (run_id) DO UPDATE SET byte_offset = max(byte_offset, excluded.byte_offset)`);
  const setHookOffset = db.prepare(`
    INSERT INTO run_hook_offsets (run_id, byte_offset) VALUES (?, ?)
    ON CONFLICT (run_id) DO UPDATE SET byte_offset = excluded.byte_offset`);
  const maxEventId = db.prepare<[], { id: number | null }>('SELECT max(id) AS id FROM run_events');

  const deleteRoundFindings = db.prepare(
    'DELETE FROM review_findings WHERE run_id = ? AND round = ?',
  );
  const insertFinding = db.prepare(`
    INSERT INTO review_findings
      (run_id, round, finding_id, key, reviewed_sha, severity, category, title, body, path,
       start_line, end_line, confidence, suggested_fix, repeat_of, triage, status, updated_at)
    VALUES
      (@runId, @round, @findingId, @key, @reviewedSha, @severity, @category, @title, @body, @path,
       @startLine, @endLine, @confidence, @suggestedFix, @repeatOf, @triage, 'open', @at)`);
  const setStatusStmt = db.prepare(
    'UPDATE review_findings SET status = ?, resolution_note = ?, updated_at = ? WHERE key = ?',
  );
  const findingsByRun = db.prepare<[string], FindingDb>(
    'SELECT * FROM review_findings WHERE run_id = ? ORDER BY round, id',
  );

  const insertDecision = db.prepare(`
    INSERT INTO decisions (run_id, kind, status, title, body, attach, created_at, options_json)
    VALUES (?, ?, 'open', ?, ?, ?, ?, ?)`);
  const closeDecision = db.prepare(`
    UPDATE decisions SET status = ?, resolved_at = ? WHERE id = ? AND status = 'open'`);
  const resolveStmt = db.prepare(`
    UPDATE decisions SET status = 'resolved', resolved_at = ?
    WHERE id = ? AND status IN ('open', 'answered')`);
  const closeQuestions = db.prepare(`
    UPDATE decisions SET status = 'dismissed', resolved_at = ?
    WHERE run_id = ? AND status = 'open' AND options_json IS NOT NULL`);
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

  const insertPlan = db.prepare(`
    INSERT INTO plans
      (run_id, version, path, content_hash, title, status, created_by, feedback, created_at)
    VALUES (@runId, @version, @path, @contentHash, @title, @status, @createdBy, @feedback, @at)`);
  const planByVersion = db.prepare<[string, number], PlanDb>(
    'SELECT * FROM plans WHERE run_id = ? AND version = ?',
  );
  const supersedePlans = db.prepare(
    "UPDATE plans SET status = 'superseded' WHERE run_id = ? AND version != ?",
  );
  const approvePlanStmt = db.prepare(
    "UPDATE plans SET status = 'approved' WHERE run_id = ? AND version = ?",
  );
  const plansByRun = db.prepare<[string], PlanDb>(
    'SELECT * FROM plans WHERE run_id = ? ORDER BY version',
  );

  // SQLite treats a negative LIMIT as "no limit".
  const limitOf = (limit: number | undefined): number => limit ?? -1;

  const getRun = (id: string): RunRow | undefined => {
    const row = runById.get(id);
    return row ? toRun(row) : undefined;
  };

  const QUEUED_NOTE = 'Waiting for a free slot';
  /** A queued row's stored entry: `{ from, fromNote, entry }` for a continuation, `{ entry }` for a start. */
  type StoredEntry = { from?: RunStage; fromNote?: string | null; entry: unknown };
  const toQueued = (r: RunDb): QueuedRun => {
    const stored = JSON.parse(r.queued_entry as string) as StoredEntry;
    return {
      runId: r.id,
      projectId: r.project_id,
      queuedAt: r.queued_at as string,
      from: stored.from ?? null,
      entry: stored.entry,
    };
  };
  const stamp = (previous: string): string => later(now(), previous);

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
    createQueuedRun(input, entry) {
      const at = now();
      return db
        .transaction((): RunRow => {
          const full: RunRow = {
            ...input,
            stage: 'queued',
            stageNote: input.stageNote ?? QUEUED_NOTE,
            ownerPid: null,
            ownerHost: null,
            createdAt: input.createdAt ?? at,
            updatedAt: input.updatedAt ?? at,
          };
          const params: Record<string, unknown> = { id: full.id };
          for (const f of runFields) params[f] = columnValue(f, full[f]);
          insertRun.run(params);
          db.prepare('UPDATE runs SET queued_entry = ?, queued_at = ? WHERE id = ?').run(
            JSON.stringify({ entry } satisfies StoredEntry),
            at,
            full.id,
          );
          return getRun(full.id) as RunRow;
        })
        .immediate();
    },
    queueRun(runId, from, entry) {
      return db
        .transaction((): boolean => {
          const current = runById.get(runId);
          if (!current || current.stage !== from) return false;
          if (!canTransition(from, 'queued', { resume: canResume(from) })) return false;
          const stored: StoredEntry = { from, fromNote: current.stage_note, entry };
          setQueued.run({
            id: runId,
            note: QUEUED_NOTE,
            entry: JSON.stringify(stored),
            queuedAt: now(),
            updatedAt: stamp(current.updated_at),
          });
          return true;
        })
        .immediate();
    },
    listQueued() {
      return queuedRows.all().map(toQueued);
    },
    claimQueued({ fits, owner }) {
      return db
        .transaction((): ClaimedRun | undefined => {
          for (const row of queuedRows.all()) {
            if (!fits(row.project_id)) continue;
            const queued = toQueued(row);
            const stored = JSON.parse(row.queued_entry as string) as StoredEntry;
            const updatedAt = stamp(row.updated_at);
            const changed =
              queued.from === null
                ? (assertTransition('queued', 'setup'),
                  setClaimedStart.run({ id: row.id, pid: owner.pid, host: owner.host, updatedAt }))
                : setClaimedContinue.run({
                    id: row.id,
                    from: queued.from,
                    note: stored.fromNote ?? null,
                    updatedAt,
                  });
            if (changed.changes === 0) continue;
            return { ...queued, run: getRun(row.id) as RunRow };
          }
          return undefined;
        })
        .immediate();
    },
    finishQueuedStart(runId) {
      clearQueuedStart.run({ id: runId });
    },
    requeueStart(runId) {
      const current = runById.get(runId);
      if (!current) return false;
      return (
        setRequeuedStart.run({
          id: runId,
          note: QUEUED_NOTE,
          updatedAt: stamp(current.updated_at),
        }).changes > 0
      );
    },
    cancelQueued(runId) {
      return db
        .transaction((): 'cancelled' | 'restored' | undefined => {
          const row = runById.get(runId);
          if (!row || row.stage !== 'queued' || row.queued_entry === null) return undefined;
          const queued = toQueued(row);
          const stored = JSON.parse(row.queued_entry) as StoredEntry;
          const updatedAt = stamp(row.updated_at);
          if (queued.from === null) {
            setCancelledQueued.run({ id: runId, updatedAt });
            return 'cancelled';
          }
          setClaimedContinue.run({
            id: runId,
            from: queued.from,
            note: stored.fromNote ?? null,
            updatedAt,
          });
          return 'restored';
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
    findRunByPr(owner, repo, prNumber) {
      const row = runByPr.get(owner, repo, prNumber);
      return row && toRun(row);
    },
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
    getHookOffset(runId) {
      return hookOffset.get(runId)?.byte_offset ?? 0;
    },
    advanceHookOffset(runId, offset) {
      advanceOffset.run(runId, offset);
    },
    replayHookEvents(runId, events, nextOffset) {
      return db
        .transaction((): number => {
          if (nextOffset <= (hookOffset.get(runId)?.byte_offset ?? 0)) return 0;
          for (const e of events) insertEvent.run(runId, null, e.ts, e.type, toJson(e.payload));
          setHookOffset.run(runId, nextOffset);
          return events.length;
        })
        .immediate();
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
          const stage = runById.get(row.run_id)?.stage as RunStage | undefined;
          // A stopped run that can resume still has questions worth answering.
          if (stage && isTerminal(stage) && !canResume(stage)) return 'run_ended';
          const options = fromJson(row.options_json) as DecisionOption[] | null;
          if (!options?.some((o) => o.id === answer.choice)) return 'bad_choice';
          const stored: DecisionAnswer = { choice: answer.choice, note: answer.note ?? null };
          return answerStmt.run(JSON.stringify(stored), now(), id).changes > 0
            ? 'answered'
            : 'not_open';
        })
        .immediate();
    },
    closeOpenQuestions(runId) {
      return closeQuestions.run(now(), runId).changes;
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

    insertFindings(runId, round, findings, triage) {
      db.transaction(() => {
        deleteRoundFindings.run(runId, round);
        const at = now();
        const seen = new Set<string>();
        for (const f of findings) {
          if (seen.has(f.id)) continue;
          seen.add(f.id);
          insertFinding.run({
            runId,
            round,
            findingId: f.id,
            key: `${runId}:r${round}:${f.id}`,
            reviewedSha: f.reviewedSha,
            severity: f.severity,
            category: f.category,
            title: f.title,
            body: f.body,
            path: f.location?.path ?? null,
            startLine: f.location?.startLine ?? null,
            endLine: f.location?.endLine ?? null,
            confidence: f.confidence,
            suggestedFix: f.suggestedFix,
            repeatOf: f.repeatOf ?? null,
            triage: triage(f),
            at,
          });
        }
      })();
    },
    setFindingStatus(runId, key, status, note) {
      return setStatusStmt.run(status, note, now(), `${runId}:${key}`).changes > 0;
    },
    listFindings(runId) {
      return findingsByRun.all(runId).map(toFinding);
    },

    addPlanVersion(input) {
      return db
        .transaction((): PlanRow => {
          insertPlan.run({
            runId: input.runId,
            version: input.version,
            path: input.path,
            contentHash: input.contentHash,
            title: input.title,
            status: input.status ?? 'draft',
            createdBy: input.createdBy,
            feedback: input.feedback ?? null,
            at: now(),
          });
          return toPlan(planByVersion.get(input.runId, input.version) as PlanDb);
        })
        .immediate();
    },
    approvePlan(runId, version) {
      return db
        .transaction((): boolean => {
          if (!planByVersion.get(runId, version)) return false;
          approvePlanStmt.run(runId, version);
          supersedePlans.run(runId, version);
          return true;
        })
        .immediate();
    },
    listPlans(runId) {
      return plansByRun.all(runId).map(toPlan);
    },
  };
}
