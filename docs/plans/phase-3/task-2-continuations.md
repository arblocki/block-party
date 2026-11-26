# Run continuations and final review

## Goal

A finished pipeline no longer ends at `complete`. It rests in `awaiting_review` with a
`final_review` inbox item. Approve completes the run. Send back starts a **continuation**:
the server rebuilds the run's context, resumes the same implementer session with my
feedback, and goes through local CI, Codex review, a push that updates the PR, and CI again,
before resting in `awaiting_review` once more (`docs/plans/phase-3.md`, decisions 2, 3
and 7).

## Context

- Task 1 added `awaiting_review` (resting), `RESTING_STAGES`, answerable decisions
  (`openDecision(..., options)` returns an id, `answerDecision`, `waitForAnswer`,
  `POST /api/inbox/:id/answer`), and the `final_review` decision kind.
- `src/core/run/pipeline.ts`: `runPipeline` = `preflight` → `provision` → `implement` →
  `verifyLoop` → `publish`/`finish`, plus the error handling at its end. `Ctx` holds
  `st` (`RunState`, persisted to `run.json`), `plan`, `briefBase`, `checks`, `rounds`
  (review rounds with resolutions), `reports`, `lastChecks`, `lastReport` and `session`.
  `fixTurn(ctx, kind, n, findingsPath, extra)` runs one fix turn through
  `adapter.send`, which resumes the Claude session if its process is gone.
- `src/core/run/publish.ts` `publishRun` pushes, creates or updates the draft PR, and
  confirms the head SHA. It is idempotent for an existing PR. `waitForCi`.
- `src/server/run-manager.ts` `createRunManager` (`start`, `cancel`, `shutdown`, in-process
  entries keyed by run id).
- `RunState` (`src/core/run/run-state.ts`) and `loadRunConfig` (`src/core/run/config.ts`).

## Approach

1. **Persist what a continuation needs.**
   - At preflight, write the resolved config to `<runDir>/inputs/config.json`.
   - Extend `RunState` with `planVersion` (number, default 1), `rounds.feedback` (int,
     default 0), and `sessionEnded` (boolean, default false). Use zod defaults so old
     `run.json` files still parse.
   - Add `loadRunState(runDir)`.
2. **Rebuild context.** Add `loadContext(runId, deps): Promise<Ctx>` in a new
   `src/core/run/context.ts`, and move the `Ctx` type and the pieces of `preflight` it
   needs there. It reads:
   - `run.json` and `inputs/config.json`;
   - the plan at `st.planPath`;
   - check definitions from the project;
   - review rounds from `reviews/round-<n>/findings.json`, paired with resolutions from
     `reports/review-fix-<n>.json`, using the same pairing as `GET /api/runs/:id/findings`;
   - the latest report.
   It sets `ctx.session` from `st.implementer`. It refuses runs whose stage is not resting.
3. **Final review.** Replace `finish` at the end of the publish path (with or without CI)
   and of the no-publish path:
   - Move the stage to `awaiting_review`.
   - Open `final_review` with options `approve` ("Approve") and `send_back` ("Send back"),
     with the PR link in the body.
   - Stop the implementer process (`adapter.stop`) and set `sessionEnded: true`. The
     conversation can still be resumed later.
   - Clear the run's owner pid, so reconciliation ignores it.

   The pipeline returns at that point.
4. **Continuation entry.** Add `continueRun(runId, entry: { kind: 'feedback'; text: string
   } | { kind: 'approve' }, deps, signal)` in `pipeline.ts`:
   - `approve` moves `awaiting_review → complete`.
   - `feedback`:
     - Writes `inputs/feedback-<n>.md` with the text.
     - Runs a fix turn of kind `feedback`. Its brief uses the fix template with that file
       as `findingsPath`; a commit is required unless every item is answered without
       changes, in which case the report says so in `summary` and no commit is needed.
     - Then `verifyLoop`, then publish again: push, confirm the head, wait for CI.
     - Then rests in `awaiting_review` with a new `final_review` decision.

   Errors go through the same handling as `runPipeline`; extract it into
   `endRun(ctx, e)`.
5. **RunManager** gains `continue(runId, entry): boolean`. It returns false if the run is
   already driven in this process or not resting. Otherwise it starts `continueRun` the same
   way `start` does (owner pid set, tracked for cancel and shutdown).
6. **Answering starts continuations.** In `runs-api.ts`, after a successful
   `answerDecision` on a `final_review` decision, call `manager.continue(...)`:
   - `approve` → `{ kind: 'approve' }`;
   - `send_back` → `{ kind: 'feedback', text: note }`, where `note` is required (400 if
     empty).

   Because `answerDecision` only answers an open decision once, a double click starts one
   continuation.
7. **CLI**: `block-party run` behaves the same up to publishing, then prints that the run is
   waiting for review in the app and exits 0.

## Acceptance criteria

- [ ] With fakes, a run ends in `awaiting_review` with an open `final_review` decision, the
      implementer stopped, and no owner pid (`pipeline.test.ts`).
- [ ] `continueRun` with `approve` completes the run; with `feedback` it runs a `feedback`
      fix turn that resumes the same session id, then checks, review, publish (the same PR
      updated) and CI, and rests in `awaiting_review` again with a new decision
      (`pipeline.test.ts`).
- [ ] `loadContext` rebuilds rounds and resolutions from the run directory and refuses a
      non-resting run (`context.test.ts`).
- [ ] Answering `final_review` twice starts one continuation; `send_back` without a note
      returns 400 (`runs-api.test.ts` with a fake manager; `run-manager.test.ts`).
- [ ] Old `run.json` files without the new fields still load (`run-state.test.ts`).
- [ ] A real run ends waiting for review. Sending it back with a note produces a new commit
      on the same PR, and Approve completes it. [browser]
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` and `pnpm build` pass.

## Tests

`pipeline.test.ts`, new `context.test.ts`, `run-state.test.ts`, `run-manager.test.ts`,
`runs-api.test.ts`.

## Out of scope

- Sending specific findings or line comments (task 7 builds on the `feedback` entry).
- Resuming `blocked` or `interrupted` runs.
