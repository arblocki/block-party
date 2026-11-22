# Phase 2: persistent runs and the app shell

## Goal

Runs become first-class, persistent objects that the local server owns and the browser shows.
I can start a run from the UI, close the browser or restart the server, come back, and see
exactly what happened and what needs me.

Exit check (ARCHITECTURE 10, Phase 2): I start a run, close the browser and even restart the
server, come back, and see exactly what happened and what needs me.

## Context

- Architecture: `docs/ARCHITECTURE.md` sections 4, 4.2, 5.1, 5.6, 6, 8, 10.
- Phase 1 pipeline: `src/core/run/pipeline.ts` (sequential async steps; state saved to
  `run.json` via `saveRunState`, events appended to `run-events.jsonl` via `RunLog`), CLI in
  `src/cli/commands/run.ts`.
- Server: `src/server/app.ts` (`createApp`, token + Host/Origin guards, per-PR sub-apps),
  `src/server/index.ts` (`startServer`), CLI entry `src/cli/commands/review.ts`.
- Store: `src/core/store/index.ts` + `schema.ts` (better-sqlite3, ordered `MIGRATIONS`,
  `PRAGMA user_version`).
- Web: `src/web/App.tsx`, routing in `src/web/lib/route.ts` (query-string routes).

## Decisions

1. **SQLite is the authority for the run list and run state; files stay.** `run.json` and
   `run-events.jsonl` keep being written (CLI users and debugging rely on them). The
   pipeline writes through one `RunRecorder` that updates both.
2. **The pipeline stays sequential code.** Stage changes go through a pure
   `transition(stage, event)` function that rejects illegal moves and is unit-tested on its
   own. Resuming a run from its saved state is Phase 4.
3. **One event path for every run.** The SSE endpoints tail `run_events` from the DB, so runs
   started from the CLI and from the server look the same in the UI.
4. **Runs started in the UI run inside the server process** via a `RunManager`. A run records
   the pid that owns it; on server start, active runs whose owner is gone become
   `interrupted` with an inbox item (basic reconciliation).
5. **Inbox items in Phase 2 are informational.** They say what happened, link to the run and
   give the attach command. Answering an item to resume a run comes later; a permission
   prompt item closes itself when the agent's turn continues.
6. **Routes stay query-string based.** New: `?home` (default with no query and no start PR),
   `?run=<id>`, `?new-run`. Existing `?repos`, `?repo=o/r`, `?repo=o/r&pr=12` keep working,
   and so does `block-party owner/repo#123`.

## Global constraints

1. TypeScript strict, ESM (`.js` suffixes), Node ≥ 22. No new runtime dependencies.
2. Unit tests never launch `claude`, `codex`, `herdr` or reach GitHub; use injected fakes.
3. Never destroy work: no force push, branch deletion, `worktree remove`, or deleting run
   directories.
4. Every new HTTP endpoint is under `/api/*` (token-guarded) and goes through the existing
   Host/Origin guard. Endpoints that start processes accept only registered project paths.
5. Don't change existing review-UI behaviour.
6. Each task is one `block-party run` and must pass `pnpm typecheck`, `pnpm lint`,
   `pnpm test`, `pnpm build`.

## Approach

Tasks are sequential; each gets its own run plan in `docs/plans/phase-2/`.

1. **Run state machine.** `src/core/run/machine.ts`: stages (adds `interrupted`,
   `cancelled`), events, and a pure `transition()`; `setStage` in the pipeline uses it.
2. **Run tables and `RunStore`.** Migration for `projects`, `runs`, `stages`, `run_events`,
   `decisions` (ARCHITECTURE 6, trimmed to what Phase 2 uses); typed store API in
   `src/core/store/runs.ts`.
3. **Pipeline records to the DB.** `RunRecorder` (files + DB); CLI `run` opens the store;
   stage rows per implementer turn, check run and review round; decision rows for blocked
   halts, permission waits (auto-closed when the turn goes on) and cap reached; owner pid.
4. **Run API and SSE.** `GET /api/runs`, `GET /api/runs/:id`, `GET /api/runs/:id/events`
   (SSE, tails `run_events` by id), `GET /api/inbox`, `POST /api/inbox/:id/dismiss`,
   `GET /api/stream` (run list + inbox changes).
5. **RunManager and reconciliation.** `POST /api/runs` (project, base, plan text, title,
   options) starts a run in-process; `POST /api/runs/:id/cancel`; `POST /api/plans/validate`;
   `GET/POST /api/projects`. On server start, mark orphaned active runs `interrupted` and
   open an inbox item.
6. **App shell home.** `block-party` with no args opens home: active and recent runs, inbox,
   link to repositories. Live updates from `/api/stream`.
7. **Run view.** Stage strip with round counts, the plan and its acceptance criteria, the
   activity feed, local CI results per SHA, review rounds with findings and resolutions,
   attach command, PR link, cancel.
8. **Start a run from the UI.** Pick or add a project, base ref, paste or upload a plan,
   validate it live, start; then land on the run view.
9. **Exit check and docs.** Run the exit check myself through the browser, then update
   ARCHITECTURE checkboxes and the decision log.

## Acceptance criteria

- [ ] A run started from the UI shows its stages, events, checks, findings and PR in the run
      view, live, without a page reload. [browser]
- [ ] Closing the browser during a run and reopening the app shows the same run with
      everything that happened in between. [browser]
- [ ] Killing and restarting the server during a run shows that run as `interrupted` with an
      inbox item; completed runs are unchanged. [browser]
- [ ] Runs started with `block-party run` in a terminal appear in the UI too. [browser]
- [ ] Blocked runs, permission waits, interrupted runs and cap-reached runs each produce an
      inbox item linking to the run. [browser]
- [ ] `block-party owner/repo#123` and the repository/PR pages still work. [browser]
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm build` pass.

## Tests

Each task plan lists its own. The state machine and store are covered by unit tests; API
endpoints by `app.test.ts`-style tests with fakes; web logic in `src/web/lib/*` by unit tests;
the end-to-end flow by the browser exit check.

## Out of scope

- Resuming interrupted or blocked runs (Phase 4).
- Answering permission prompts or blocked questions from the UI (later).
- Planning in the app, "send to implementer" from review (Phase 3).
- Parallel runs, tmux, the global roles config file.
