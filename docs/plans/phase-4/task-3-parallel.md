# Concurrency limits and parallel runs

## Goal

Several runs, in the same project or different ones, proceed at once without corrupting
each other. A start over the limit waits its turn instead of failing or overloading the
machine (ARCHITECTURE 10 Phase 4; `docs/plans/phase-4.md` decisions 3 and 4).

## Context

- `RunManager` (`src/server/run-manager.ts`) starts runs and continuations in-process
  with no limit. Its `entries` map tracks the runs it drives.
- Task 1 added `resume`, and task 2 added `resumeOnRestart`.
- Shared state between runs:
  - the project's main clone: `git fetch`, `git worktree add` (`src/core/git/`), which can
    race on `.git/index.lock`, `packed-refs` and `worktrees/`;
  - SQLite: one connection per server, WAL. Check `busy_timeout`; the CLI may open its own;
  - the herdr session `block-party`: labels are per run;
  - the codex home (`src/core/reviewer/codex-home.ts`): check whether it's per run;
  - `<dataDir>/plans` and the run dirs are per run.
- The machine has `RESTING_STAGES` (`awaiting_plan_approval`, `awaiting_review`).

## Approach

1. **Limits** in a server-level config, read from `~/.config/block-party/config.yaml`
   `limits` if present (this is the first use of that file; read only the `limits` key) and
   otherwise from defaults: `{ maxRuns: 3, maxRunsPerProject: 2 }`. Values must be integers
   ≥ 1.
2. **Slot accounting.**
   - A slot is held while a process drives a run: a pipeline start, a continuation
     (including resume and send-back), or a planner.
   - Resting runs and runs in `awaiting_decision` hold no slot. Implement that in the
     manager by releasing the slot when the pipeline enters `awaiting_decision` and
     re-acquiring it when the answer arrives (the pipeline already polls). The re-acquire
     waits for a free slot.
   - Answers that start continuations (approve the plan, send back, resume) also need a slot.
3. **Queue.**
   - New resting stage `queued` (machine: `queued → setup | planning | implementing |
     fixing | checking | reviewing | publishing | waiting_ci | cancelled`, and `→ queued`
     only from the start path and from rest when no slot is free).
   - A start over the limit creates the run row in `queued`. The row stores the pending
     entry (`queued_entry` JSON: start input, or a continue entry) so it can start later.
     It records `run.queued { position }`.
   - When a slot frees, the manager takes the oldest queued run that fits the per-project
     limit, FIFO within that rule. It does this in one DB transaction (`claimQueued`) so
     two releases can't start the same run.
   - At server start, queued runs stay queued and are pumped after reconciliation.
   - Cancelling a queued run moves it to `cancelled`.
4. **Serialize the main clone.** Add `withProjectLock(projectId, fn)` in the manager (an
   in-process async mutex keyed by project). Use it for `git fetch` of the base and
   `git worktree add` during setup, and for `POST /api/new-run/prepare` clones. Pass it
   into the pipeline deps as `lockProject`. Work inside a run's own worktree is not
   locked.
5. **SQLite**: ensure `journal_mode=WAL` and `busy_timeout=5000` on every connection the
   server and CLI open. Add a test that two store instances on one file can write
   interleaved.
6. **UI.**
   - Home shows queued runs with "Waiting for a free slot (2 of 3 in use)".
   - The run view shows the queue position.
   - `stageLabel('queued')` is "Queued".

## Acceptance criteria

- [ ] With `maxRuns: 2`, a third start is `queued` and starts when one of the first two
      finishes. With `maxRunsPerProject: 1`, a second run in the same project waits while one
      in another project starts (`run-manager.test.ts` with fake pipelines).
- [ ] Two slots freeing at once start each queued run exactly once (`claimQueued` test).
- [ ] A run waiting in `awaiting_decision` frees its slot, and its answer waits for one
      (`run-manager.test.ts`).
- [ ] Queued runs survive a server restart and start afterwards (`reconcile`/`index` test).
- [ ] Two setups in one project never run `git worktree add` at the same time
      (`withProjectLock` test).
- [ ] Two store instances on one DB file write interleaved without `SQLITE_BUSY`.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` and `pnpm build` pass.

## Out of scope

- Priorities, and reordering the queue from the UI.
