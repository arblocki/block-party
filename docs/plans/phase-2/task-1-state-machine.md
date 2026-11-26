# Run stage state machine

## Goal

Every stage change in a run goes through one pure, unit-tested function that knows which
moves are legal. Phase 2 (`docs/plans/phase-2.md`, decision 2) persists runs in SQLite and
shows them in the UI; both need a single, explicit definition of run stages and transitions.
This task adds that definition and wires the Phase 1 pipeline through it, plus two new
terminal stages: `cancelled` (I stopped it) and `interrupted` (its process died; set by
reconciliation in a later task).

## Context

- `src/core/run/run-state.ts:18-29` — `RunStateSchema.stage` is a zod enum of the current
  stages: setup, implementing, checking, reviewing, fixing, publishing, waiting_ci, complete,
  blocked, failed.
- `src/core/run/pipeline.ts:147` — `setStage(ctx, stage, note)` writes the stage with no
  validation. Callers: lines ~182-186 (terminal handling in `runPipeline`), 375, 507, 526,
  568, 631, 657, 697.
- `src/core/run/pipeline.ts:180-183` — Ctrl-C / abort currently sets `blocked` with note
  `interrupted`.
- `src/cli/commands/run.ts:110` — `exitCodeFor`: complete → 0, blocked → 3, else 1.
- `docs/ARCHITECTURE.md` 5.1 shows the long-term state diagram; this task implements the
  subset the Phase 1 pipeline uses.

## Approach

1. Create `src/core/run/machine.ts`:
   - `export const RUN_STAGES` (readonly tuple): the existing stages plus `cancelled` and
     `interrupted`; `export type RunStage`.
   - `export const TERMINAL_STAGES` = complete, blocked, failed, cancelled, interrupted, and
     `isTerminal(stage)`. `export const ACTIVE_STAGES` = the rest.
   - `export function canTransition(from: RunStage, to: RunStage): boolean` and
     `export function assertTransition(from, to): void` which throws
     `IllegalTransitionError` (exported, with `from`/`to` fields) when not allowed.
   - Allowed moves (a table, not ad-hoc ifs):
     - setup → implementing
     - implementing → checking
     - checking → reviewing, fixing
     - fixing → checking
     - reviewing → fixing, publishing, complete (complete is used by `--no-publish`)
     - publishing → waiting_ci, complete
     - waiting_ci → complete
     - any active stage → blocked, failed, cancelled, interrupted
     - a stage to itself is allowed only for active stages (note updates)
     - terminal stages have no outgoing moves in Phase 2.
2. `src/core/run/run-state.ts`: build the `stage` enum from `RUN_STAGES` so there is one
   source of truth.
3. `src/core/run/pipeline.ts`: `setStage` calls `assertTransition(ctx.st.stage, stage)` before
   writing. On abort (`input.signal?.aborted` or `InterruptedError`), set `cancelled` with note
   `cancelled` instead of `blocked`/`interrupted`. If the pipeline itself hits an
   `IllegalTransitionError`, it must still end the run: set `failed` with the error message
   (failed is always reachable from an active stage).
4. `src/cli/commands/run.ts`: exit code 130 for `cancelled`; update the outcome type so
   `RunOutcome.stage` includes `cancelled`. Check any other place that switches on stage.

Verify, by reading the pipeline, that every existing call site follows an allowed move; if one
doesn't, the table is wrong, not the call site, unless the move is clearly a bug, in which
case say so in the report.

## Acceptance criteria

- [ ] `src/core/run/machine.ts` exports `RUN_STAGES`, `TERMINAL_STAGES`, `ACTIVE_STAGES`,
      `isTerminal`, `canTransition`, `assertTransition` and `IllegalTransitionError`, and
      `RunStateSchema`'s stage enum is derived from `RUN_STAGES`.
- [ ] Unit tests in `machine.test.ts` cover every allowed move in the table, a sample of
      illegal moves (for example setup → publishing, complete → implementing, checking →
      complete), self-moves for active and terminal stages, and that every active stage can
      reach blocked, failed, cancelled and interrupted.
- [ ] `setStage` rejects an illegal move: a pipeline test that forces one shows the run ends
      as `failed` with a message naming both stages.
- [ ] Aborting a run (signal) ends it as `cancelled`, and `block-party run` exits with code
      130 in that case; existing pipeline and CLI tests are updated to match.
- [ ] All existing pipeline tests pass with the validation in place (no call site makes an
      illegal move).
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm build` pass.

## Tests

`src/core/run/machine.test.ts` (new), plus updates to `src/core/run/pipeline.test.ts`,
`src/core/run/run-state.test.ts` and the CLI run tests for `cancelled`.

## Out of scope

- Any database, server or UI work.
- Resuming from `blocked` or `interrupted` (no outgoing moves from terminal stages yet).
- Changing what the pipeline does in each stage.
