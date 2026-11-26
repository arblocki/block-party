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

## Progress (2026-11-26)

Each task runs through `block-party run` with its plan in `docs/plans/phase-2/`; I review
the PR, fix remaining Codex P2s on the branch, and squash-merge.
Tasks 6–8 were built directly on main by Sonnet subagents instead, each with a task review,
then one whole-range review and fix wave.

| Task | Status |
| --- | --- |
| 1 State machine | Merged, #17 |
| 2 Run tables and RunStore | Merged, #18 |
| 3 Pipeline records to the DB | Merged, #19 (adds a `cap_reached` inbox item when publishing with unresolved blocking findings) |
| 4 Run API and SSE | Merged, #20 (checked against the real DB: auth, 400/401/403, stream) |
| 5 RunManager and reconciliation | Merged, #21 (project, validate and start endpoints checked live) |
| 6 Home page | On main (9651575, 8dc79c6), built by Sonnet subagents with a review per task |
| 7 Run view | On main (f6168ab, 72d1e86) |
| 8 New-run form | On main (cc96376) |
| 9 Exit check and docs | Passed 2026-11-26 in a browser (see below); final-review fixes e4a2d9c..1645912 |

Fixes made outside the task plans along the way (all on main):

- Claude Code 2.1.328 asks to confirm each `--add-dir`. The pane adapter accepts it, but
  only for the run directory itself. It now watches for startup dialogs for 90 s, presses
  the keys again if a dialog is still showing 3 s later, and ends the turn (blocked, with an
  inbox item) when Claude never logs `SessionStart`, instead of hanging.
- Adapter `agent.*` events were never recorded; they now go to the run log and DB.
- Agents inherited this Claude Code session's `CLAUDE_CODE_*` markers, including its
  messaging socket and token; `scrubbedEnv` now drops them.
- `checks.fix` (here `pnpm format`) can be run by implementers without approval; a
  Prettier check is now a required check. Subagents get the same shell rules as the
  implementer; `head`/`tail`/`wc` are pre-approved.
- Each permission prompt opens one inbox item, not two.

Exit check (2026-11-26, Playwright against the real DB): a run started from the new-run form
(`r20261126-cf4879`, the CLI help fix, cherry-picked as 08f77c8) moved live in the run view;
reopening the browser showed its local CI and review stage; `kill -9` of the server and a
restart marked it `interrupted` with an inbox item, completed runs unchanged; dismiss
persisted after reload; Cancel ended a second run `cancelled`; `?repos`, the PR route and
`block-party owner/repo#123` still work. Runs started with `block-party run` (#20, #21) show
in the list.

Open items: the run stuck in task 6's second attempt (`r20261122-6993e7`) left its pane
waiting on the dialog, and every run leaves its worktree and `bp/*` branch (runs never delete
work). Coming back after closing the browser needs the URL the server printed, because the
session token lives in `sessionStorage`.

## Acceptance criteria

- [x] A run started from the UI shows its stages, events, checks, findings and PR in the run
      view, live, without a page reload. [browser]
- [x] Closing the browser during a run and reopening the app shows the same run with
      everything that happened in between. [browser]
- [x] Killing and restarting the server during a run shows that run as `interrupted` with an
      inbox item; completed runs are unchanged. [browser]
- [x] Runs started with `block-party run` in a terminal appear in the UI too. [browser]
- [x] Blocked runs, permission waits, interrupted runs and cap-reached runs each produce an
      inbox item linking to the run. [browser] (Blocked and interrupted items seen in the
      browser; permission-wait and cap-reached items are covered by pipeline tests only.)
- [x] `block-party owner/repo#123` and the repository/PR pages still work. [browser]
- [x] `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm build` pass.

## Tests

Each task plan lists its own. The state machine and store are covered by unit tests; API
endpoints by `app.test.ts`-style tests with fakes; web logic in `src/web/lib/*` by unit tests;
the end-to-end flow by the browser exit check.

## Out of scope

- Resuming interrupted or blocked runs (Phase 4).
- Answering permission prompts or blocked questions from the UI (later).
- Planning in the app, "send to implementer" from review (Phase 3).
- Parallel runs, tmux, the global roles config file.
