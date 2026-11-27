# Thorough reconciliation and safe cancel at any stage

## Goal

When the server starts, every run in an active stage is checked against reality and either
picked back up or clearly marked. Cancelling a run in any stage stops everything it started
and leaves a consistent record (ARCHITECTURE 5.6 "Reconciliation on server start", 5.2.1
"Server lifetime", Phase 4 "safe cancellation at any stage").

## Context

- `src/server/reconcile.ts`:
  - `reconcileRuns` marks active runs whose owner pid on this host is gone as `interrupted`,
    with an inbox item.
  - `reopenStrandedRests` handles resting runs. Known gap: it ignores live owners.
- Task 1: `RunManager.resume(runId)` and `resumePoint`.
- Pane sessions are herdr panes labelled `bp-<runId>-<role>-r<n>`
  (`src/core/agents/claude-pane.ts`, `src/core/terminal/herdr.ts` `list()`). Headless
  sessions are child processes of the owner.
- Check runner (`src/core/checks/run.ts`) kills its process group on abort. The reviewer
  is a `codex exec` child (`src/core/reviewer/`). The planner is a pane session.
- `RunManager.cancel(runId)` aborts the run's `AbortController`, or cancels a resting run.
  `endRun` in the pipeline records the end.
- Hook events land in `<runDir>/events.jsonl`, tailed by the recorder (`recorder.ts`).

## Approach

1. **Reconcile with evidence.** For each active run whose owner on this host is gone:
   - Replay unprocessed lines of `events.jsonl` into `run_events`. The recorder tracks a
     byte offset per run in the DB (new column or `run_state` key). Replay is idempotent.
   - Probe its agent pane through the terminal host by label. If the pane is alive and
     the agent is working, record `reconcile.pane_alive`. The run still goes `interrupted`,
     and the inbox body says "the agent is still running in its terminal; Resume will
     re-attach to it". Resume must then send to the live pane, not spawn a second session.
     Extend task 1's `turn` resume point to prefer a live pane.
   - Mark `interrupted` with a `resume` option (task 1). Its body says what was found: the
     last stage, whether a report exists, and the pane state.
   - `policy.resumeOnRestart` (default `false`): when true, the server calls
     `manager.resume` for runs interrupted by an owner-gone check at startup, at most
     `limits.maxRuns` of them (task 3 adds the limit; use 3 until then).
2. **Stranded rests.** `reopenStrandedRests` skips runs whose owner pid is alive on this
   host. This fixes the Phase 3 known gap.
3. **Safe cancel.** One cancel path for every active stage. `cancel` aborts the
   controller, and each long operation honours the signal:
   - checks: the process group is killed (exists). Verify no orphan with a test that spawns
     a sleeping child grandchild.
   - reviewer: the `codex` child process group is killed on abort.
   - implementer/planner in a pane: `adapter.stop(session)` closes the pane after
     `pane.read` captures its last screen to `logs/<label>-final.txt`. Headless: kill the
     process group.
   - waiting on CI or a decision: the poll loop exits on abort.
   - git push in progress: let it finish (bounded by its timeout), then stop. A push is not
     interrupted midway.
   - The open stage row is closed as `cancelled`, open decisions are closed, and
     `run.cancelled { stage }` is recorded. The run ends `cancelled`. Worktree and branch
     stay.
   - A cancel that arrives while a continuation is starting (resting → active) cancels
     once the continuation owns the run, instead of returning false. This fixes the parked
     Phase 3 minor where a just-finished run returned true; return the real outcome.
4. **Server shutdown** (SIGINT/SIGTERM): runs it drives end `interrupted` (exists). Make
   sure their stage row is closed `cancelled` with note "server stopped" and the pane is
   **left running** (not closed). Task 1's resume can then re-attach.

## Acceptance criteria

- [ ] Reconcile replays unprocessed hook events exactly once across two restarts
      (`reconcile.test.ts`).
- [ ] Reconcile on a run with a live pane records `pane_alive`, and resume sends to that
      pane instead of starting a new session (fake herdr; `reconcile.test.ts`,
      `pipeline.test.ts`).
- [ ] `resumeOnRestart: true` resumes owner-gone runs at startup, and `false` leaves them
      `interrupted` (`reconcile.test.ts` or `index` test).
- [ ] Cancel during checks, review, implement (pane and headless), CI wait and decision wait
      each ends `cancelled`, with the stage row closed and no live child process
      (`pipeline.test.ts`, `checks/run.test.ts`).
- [ ] `reopenStrandedRests` leaves runs with a live owner alone.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` and `pnpm build` pass.

## Out of scope

- Reconciling runs owned by another host.
