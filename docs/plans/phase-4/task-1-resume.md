# Resume interrupted and blocked runs

## Goal

An `interrupted` run (its process died, or the server restarted) or a `blocked` run (it
needed me, and I've now dealt with it) can be resumed from the inbox or the run view. It
picks up where the evidence says it got to, reusing the agent's conversation when there is
one (ARCHITECTURE 5.1: "`blocked` and `interrupted` can resume into the state they left";
5.6; Phase 3 out-of-scope note).

## Context

- `src/core/run/machine.ts`: terminal stages have no outgoing moves ("no resume yet").
- `src/core/run/pipeline.ts`:
  - `continueRun(runId, entry, deps, signal)` rebuilds a `Ctx` from `run.json` and the DB
    (`context.ts` `loadContext`) and enters at a named point. Its entries are
    `ContinueEntry` (approve, feedback, plan_approve, plan_revise, cancel).
  - Stage helpers: `implement`, `checksGreen`, `verifyLoop`, `publishAndWait`,
    `restForReview`, `planStep`.
- `RunState` (`run-state.ts`) has `stage`, `rounds`, `headSha` and the implementer session
  (`sessionId`, mode). `ImplementerAdapter.send` resumes a Claude session whose process is
  gone (`claude --resume <id>` in a new pane, or headless `--resume`).
- Stage rows (`stages`) record kind, round, inputs (head SHA) and state. Reports live at
  `reports/<kind>-<n>.json`.
- `RunManager.continue(runId, entry)` currently refuses runs that aren't resting.
- Reconciliation opens an `interrupted` decision (informational) with the attach command.

## Approach

1. **Machine.**
   - Add `canResume(stage)`: true for `interrupted` and `blocked`.
   - Allow `interrupted|blocked → setup|planning|implementing|checking|reviewing|fixing|
     publishing|waiting_ci`, and only through a `resume` transition
     (`assertTransition(from, to, { resume: true })`). Ordinary moves out of terminal stages
     stay illegal.
   - `failed`, `cancelled` and `complete` never resume.
2. **Resume point** `resumePoint(ctx): ResumePoint` in `src/core/run/resume.ts`, a pure
   function of the run row, stage rows, report files present, and the current worktree
   `HEAD` and dirty state:
   - `{ kind: 'ask', reason }` when the worktree has uncommitted changes, or `HEAD` differs
     from the run's recorded `headSha` and the new commits aren't explained by a turn in
     progress. The resume opens a `resume_conflict` decision with options "Keep the changes
     and continue" (`keep`) and "Cancel" instead of guessing. `keep` re-records `headSha` and
     proceeds from the step below.
   - `{ kind: 'plan' }` when the run never got an approved plan: re-run `planStep` with the
     last feedback.
   - `{ kind: 'turn', turnKind, n }` when the last agent turn (implement or fix) has no
     valid report: resume the implementer session with "You were interrupted. Continue the
     task in <brief>; write the report when done." Then judge it as usual.
   - `{ kind: 'checks' }` when the head has no passing checks stage.
   - `{ kind: 'review' }` when checks passed on the head but no review round finished on it.
   - `{ kind: 'publish' }` when review is clean on the head but it wasn't pushed, or the PR
     head differs.
   - `{ kind: 'wait_ci' }` when it was pushed and no CI result was recorded.
   - `{ kind: 'rest_review' }` when everything is done: rest in `awaiting_review`.
   - Round counters keep their values. A resume does not get a fresh budget, unlike a
     send-back.
3. **Entry.**
   - `ContinueEntry` gains `{ kind: 'resume' }`. In `continueRun` it closes the run's open
     `interrupted`/`blocked` decisions, records `run.resumed { from, point }`, and runs the
     loop from the resume point. The tail is the same as a fresh run: ends in
     `awaiting_review`, `blocked`, etc.
   - A blocked run whose block was a cap-reached or "stopped without report" decision
     resumes the same way. The resume message mentions what blocked it.
4. **Server.**
   - `RunManager.resume(runId): 'started' | 'busy' | 'not_resumable'` uses the same
     single-owner guard as `continue`: one continuation per run, and a double click starts
     one.
   - `POST /api/runs/:id/resume` returns 202, 409 (`busy` or `not_resumable`) or 404.
   - `interrupted` and `blocked` decisions get options `resume` ("Resume") and `dismiss`.
     Answering `resume` calls the manager.
5. **UI.**
   - The run view shows a **Resume** button for resumable runs, next to Cancel.
   - `DecisionItem` already renders options.
   - The `resume_conflict` decision shows its reason, which lists the dirty files and the
     unexpected commits.

## Acceptance criteria

- [ ] `resumePoint` returns each kind above for a hand-built stage history, including dirty
      worktree → `ask` and moved HEAD → `ask` (`resume.test.ts`).
- [ ] A pipeline interrupted mid-implement (fake adapter) resumes the same session, judges
      the report, and rests in `awaiting_review` (`pipeline.test.ts`).
- [ ] A run interrupted after a clean review on its head resumes at publish without another
      review (`pipeline.test.ts`).
- [ ] `canTransition` still rejects ordinary moves out of terminal stages, and `failed`,
      `cancelled` and `complete` are never resumable (`machine.test.ts`).
- [ ] A double resume starts one continuation. Resuming a `complete` run returns 409
      (`run-manager.test.ts`, `runs-api.test.ts`).
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` and `pnpm build` pass.

## Out of scope

- Resuming automatically on server start (task 2 decides when that's safe).
