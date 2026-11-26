# Run tables and RunStore

## Goal

block-party's SQLite database can hold projects, runs, stage executions, run events and
inbox decisions, behind a typed `RunStore` API. Later Phase 2 tasks
(`docs/plans/phase-2.md`) make the pipeline write here and the server and UI read from here,
so this task fixes the schema and the API they will share. Nothing writes to these tables yet.

## Context

- `src/core/store/schema.ts` — `MIGRATIONS` is an ordered array of SQL strings;
  `PRAGMA user_version` counts applied ones. Append a new entry; never edit old entries.
- `src/core/store/index.ts` — `openStore(file)` opens better-sqlite3 in WAL mode, runs
  migrations, prepares statements and returns a `Store` object; `close()` closes the db.
  Tests in `src/core/store/store.test.ts` use `openStore(':memory:')`.
- `src/core/run/machine.ts` — `RUN_STAGES`, `isTerminal`, `ACTIVE_STAGES` (the run stage
  names). `src/core/run/run-state.ts` — `RunState` (what `run.json` holds today).
- `docs/ARCHITECTURE.md` section 6 — the long-term data model. This task implements a trimmed
  version.
- Both the CLI (`block-party run`) and the server will open the same DB file at the same time
  (WAL mode allows this). Writes must be short transactions.

## Approach

1. Append one migration to `MIGRATIONS` creating:
   - `projects` (id TEXT PK, owner, repo, local_path UNIQUE, default_base, created_at,
     updated_at).
   - `runs` (id TEXT PK, project_id → projects, title, stage, stage_note, branch,
     worktree_path, run_dir, base_ref, base_sha, head_sha, pr_number, plan_path, plan_hash,
     implementer_json, rounds_json, owner_pid INTEGER, owner_host TEXT, created_at,
     updated_at). Index on (stage), (updated_at).
   - `stages` (id INTEGER PK AUTOINCREMENT, run_id → runs, kind TEXT — e.g. implement,
     check-fix, review-fix, checks, review, publish, wait-ci —, round INTEGER, state TEXT
     (`running`/`succeeded`/`failed`/`blocked`/`cancelled`), input_json, output_json,
     started_at, ended_at). Index on (run_id).
   - `run_events` (id INTEGER PK AUTOINCREMENT, run_id → runs, stage_id NULL, ts, type,
     payload_json). Index on (run_id, id).
   - `decisions` (id INTEGER PK AUTOINCREMENT, run_id → runs, kind TEXT — `blocked`,
     `permission`, `interrupted`, `cap_reached`, `failed` —, status TEXT (`open`/`resolved`/
     `dismissed`), title, body, attach TEXT NULL, created_at, resolved_at NULL). Index on
     (status, created_at).
2. Create `src/core/store/runs.ts` with `createRunStore(db: Database.Database): RunStore` and
   types `Project`, `RunRow`, `StageRow`, `RunEventRow`, `Decision`. Methods:
   - `upsertProject({ owner, repo, localPath, defaultBase })` → `Project` (keyed by
     local_path; updates owner/repo/default_base), `listProjects()`, `getProject(id)`.
   - `createRun(row)`, `updateRun(id, patch)` (only the given columns, always bumps
     `updated_at`), `getRun(id)`, `listRuns({ limit?, active? })` newest first by
     `updated_at`, where `active` filters to `ACTIVE_STAGES`.
   - `startStage({ runId, kind, round, input })` → id, `endStage(id, { state, output })`,
     `listStages(runId)`.
   - `appendEvent({ runId, stageId?, ts, type, payload })` → id,
     `listEvents(runId, { afterId?, limit? })` ascending by id,
     `latestEventId()` (max id over all runs, 0 when empty).
   - `openDecision({ runId, kind, title, body, attach? })` → id; `resolveDecision(id)`,
     `dismissDecision(id)` (no-ops on non-open rows; return whether a row changed);
     `listDecisions({ status?, runId? })` newest first; `openDecisionCount()`.
   JSON columns are parsed back into objects; rows use camelCase fields.
3. Expose it from `Store`: add a `runs: RunStore` property in `openStore`. No other Store
   behaviour changes.

## Acceptance criteria

- [ ] Opening a database created by the previous migrations applies the new migration once,
      and opening it again does not re-apply it (test with a file-backed temp DB).
- [ ] `upsertProject` returns the same id for the same `localPath` and updates owner, repo
      and default base (unit test).
- [ ] `createRun`/`updateRun`/`getRun` round-trip every column, `updateRun` bumps
      `updatedAt`, and `listRuns({ active: true })` returns only runs in active stages,
      newest first (unit tests).
- [ ] `appendEvent` ids increase; `listEvents(runId, { afterId })` returns only later events
      of that run, in order, and `latestEventId()` reflects the newest event (unit tests).
- [ ] `resolveDecision` and `dismissDecision` change only open decisions and report whether
      they changed one; `listDecisions({ status: 'open' })` and `openDecisionCount()` agree
      (unit tests).
- [ ] Two `openStore` handles on the same file see each other's run writes (unit test with a
      temp file), which is how the CLI and server will share runs.
- [ ] Existing store tests pass unchanged.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm build` pass.

## Tests

`src/core/store/runs.test.ts` (new) for everything above; keep `store.test.ts` passing.

## Out of scope

- Making the pipeline, CLI or server use these tables (later tasks).
- Deleting runs or projects (no delete methods).
- Any change to existing tables or review-store behaviour.
