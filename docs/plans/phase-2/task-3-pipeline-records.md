# Pipeline records runs to the database

## Goal

Every `block-party run` writes its state, events, stage executions and inbox decisions to
the SQLite run tables, as well as to the files it writes today. After this task the server
(next tasks) can show any run, including ones started from a terminal, by reading the
database alone. See `docs/plans/phase-2.md`, decisions 1, 3 and 5.

## Context

- `src/core/store/runs.ts` — `RunStore` (projects, runs, stages, run_events, decisions) and
  `Store.runs` from `openStore`.
- `src/core/run/pipeline.ts`:
  - `preflight` builds the initial `RunState` and calls `saveRunState`; `setStage` and
    `patchState` save `run.json` on every change.
  - `ctx.log.log(type, data)` (`RunLog`, `src/core/run/events.ts`) appends
    `run-events.jsonl` and echoes to the terminal.
  - Implementer turns (`implement`, `check-fix`, `review-fix`) go through `judgeTurn`; checks
    run in `verifyLoop` (`checks.result`); review rounds log `review.result`; publish and CI
    wait are in `publish`.
  - Halts: `throw new Halt('blocked' | 'failed', note)`; the check-fix cap is at
    `ctx.st.rounds.checkFix >= policy.maxCheckFixRounds`, and the review-fix cap similarly.
  - Permission waits: the `onPermission` callback passed to the adapter logs
    `implementer.waiting_for_human`.
  - Stages and legal moves come from `src/core/run/machine.ts`.
- `src/cli/commands/run.ts` — builds `PipelineDeps`; `dbPath()` is in `src/core/paths.ts`.
- The server will open the same DB file concurrently (WAL).

## Approach

1. Add an optional `store?: RunStore` to `PipelineDeps`. All DB writes go through one small
   module, `src/core/run/recorder.ts`, so the pipeline calls one method per fact, e.g.
   `recorder.state(st)`, `recorder.event(type, data)`, `recorder.startStage(...)`,
   `recorder.endStage(...)`, `recorder.openDecision(...)`, `recorder.resolveDecision(id)`.
   With no store, the recorder does only what the pipeline does today (files).
2. A DB write failure must never fail or block a run: catch it, append a `db.error` event to
   `run-events.jsonl` (file only), and continue. Files remain the fallback record.
3. In `preflight`: upsert the project (owner, repo, repo path, base ref) and create the run row
   with every `RunState` field, `run_dir`, `owner_pid = process.pid` and
   `owner_host = os.hostname()`. Every later `run.json` save also updates the run row.
4. Every event logged through `ctx.log` is also appended to `run_events` with the same `ts`,
   `type` and data, and the id of the stage row it belongs to, if any.
5. Stage rows: one per implementer turn (kind `implement`/`check-fix`/`review-fix`, round n,
   input = brief path and model, output = report path or the outcome), one per local CI run
   (`checks`, input head SHA, output pass/fail per check and log paths), one per review round
   (`review`, input reviewed SHA, output finding counts and findings path), one for `publish`
   (output PR number and URL) and one for `wait-ci` (output state). End each with
   `succeeded`, `failed`, `blocked` or `cancelled` as appropriate, including when a halt or
   abort interrupts it.
6. Decisions:
   - Permission wait → open `permission` (title "Implementer needs approval", body the
     message, attach the attach command). Resolve it as soon as the turn ends, whatever the
     outcome.
   - Run ends `blocked` → open `blocked` with the halt note as body and the attach command when
     there is a session; when the halt is because a fix-round cap was reached, use kind
     `cap_reached` instead.
   - Run ends `failed` → open `failed` with the error as body.
   - `complete` and `cancelled` open nothing.
7. `src/cli/commands/run.ts`: open the store at `dbPath()`, pass `store.runs`, close it after
   the pipeline returns. A store that fails to open prints a warning and the run continues
   without one.

## Acceptance criteria

- [ ] A pipeline test with an in-memory store runs a full fake run (implement, checks, one
      review with a P1, review-fix, checks, clean review, publish) and the DB then has: the
      run row matching the final `run.json`; every event from `run-events.jsonl` in
      `run_events` in the same order; stage rows for each turn, checks run, review round,
      publish and wait-ci with the right kinds, rounds and end states; no open decisions.
- [ ] A permission wait during a turn opens a `permission` decision that is resolved once the
      turn ends (pipeline test).
- [ ] A run that halts `blocked` opens one `blocked` decision with the note; a run that
      reaches the check-fix cap opens `cap_reached`; a run that fails opens `failed`; a
      cancelled run opens none (pipeline tests).
- [ ] When every store method throws, the run still completes exactly as without a store, and
      `run-events.jsonl` contains `db.error` events (pipeline test).
- [ ] Without a store, behaviour and files are unchanged (existing tests pass).
- [ ] The run row records `owner_pid` and `owner_host` of the running process.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm build` pass.

## Tests

`src/core/run/recorder.test.ts` (new) and additions to `src/core/run/pipeline.test.ts` using
`openStore(':memory:').runs`.

## Out of scope

- Server endpoints, SSE, the UI and reconciliation (later tasks).
- Reading run state back from the DB to resume runs.
- Changing the content or format of `run.json` or `run-events.jsonl`.
