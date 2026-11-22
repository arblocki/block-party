# Start and cancel runs from the server; reconcile on restart

## Goal

The local server can start a run from a project, base ref and plan text, cancel it, and,
when it starts up, notice runs whose owning process is gone and mark them `interrupted` with
an inbox item. This is the server half of "start a run from the UI" and "basic
reconciliation on server restart" (`docs/plans/phase-2.md`, decisions 4 and 5).

## Context

- `src/cli/commands/run.ts` — `runMain` builds `PipelineDeps` (git, runShell, runChecks,
  loadProjectChecks, pane or headless Claude adapter, Codex reviewer with
  `ensureReviewerCodexHome`, publishRun, waitForCi, GitHub client, `RunLog`, `hookArgv`,
  `store`) and calls `runPipeline` with an `AbortController` signal.
- `src/core/run/pipeline.ts` — `runPipeline(input, deps)`; `RunInput` has `repo` (path),
  `planFile`, `baseRef`, `title?`, `config`, `signal`. Aborting ends the run `cancelled`.
  `parsePlan` in `src/core/run/plan.ts` validates plans.
- `src/core/run/config.ts` — `loadRunConfig(repoDir, flags)`, `RunFlagOverrides` (mode,
  model, reviewerModel, publish, waitForCi).
- `src/core/run/machine.ts` — stages and `assertTransition`; `ACTIVE_STAGES`.
- `src/core/store/runs.ts` — `RunStore` (projects, runs with `ownerPid`/`ownerHost`,
  events, decisions).
- `src/server/runs-api.ts` — `registerRunsApi` (read endpoints and streams);
  `src/server/app.ts` `createApp`; `src/server/index.ts` `startServer`;
  `src/cli/commands/review.ts` starts the server and handles SIGINT/SIGTERM.
- `src/core/paths.ts` — `dataDir()`.

## Approach

1. Move the `PipelineDeps` construction out of `runMain` into
   `src/core/run/deps.ts#createRunDeps({ store, echo?, mode })` so the CLI and the server
   build identical deps. `runMain` uses it; CLI behaviour is unchanged.
2. Shutdown is not cancellation: when the signal's abort reason is a `ShutdownError`
   (new, exported from `src/core/run/pipeline-helpers.ts`), the pipeline ends the run
   `interrupted` (note `server stopped`) instead of `cancelled`, and opens an `interrupted`
   decision.
3. `src/server/run-manager.ts#createRunManager({ runs, startPipeline, now? })` where
   `startPipeline(input) => Promise<RunOutcome>` defaults to `runPipeline` with
   `createRunDeps`. It keeps a map of in-process runs (run id → AbortController and promise):
   - `start({ projectId, baseRef, planText, title?, flags? })`: validates the plan with
     `parsePlan` (errors → a typed validation error), writes the plan text to
     `<dataDir>/plans/<sha256>.md`, starts the pipeline without awaiting it and resolves with
     the new run id as soon as the run row exists (poll `listRuns`/a callback; at most a few
     seconds) or with the error that stopped it before that.
   - `cancel(runId)`: aborts an in-process run (normal abort → `cancelled`); returns false for
     runs it does not own.
   - `shutdown()`: aborts every in-process run with a `ShutdownError` and waits for them to
     settle (bounded, e.g. 10 s).
4. Reconciliation, `reconcileRuns({ runs, isAlive?, hostname?, now? })` in
   `src/server/reconcile.ts`, called once by `startServer` before listening: for each run in
   an active stage, if `ownerHost` is this host and `ownerPid` is not alive
   (`process.kill(pid, 0)` throws `ESRCH`), move it to `interrupted` with note `owner process <pid> is gone`, append a
   `run.interrupted` event and open an `interrupted` decision (title "Run interrupted", body
   with the last stage and note, attach command if the implementer session had a pane).
   Runs owned by another host or a live pid are left alone. Returns the ids it changed.
5. Endpoints in `registerRunsApi` (pass the manager in):
   - `POST /api/projects` `{ path }` → resolves the git root and origin owner/repo with the
     existing git service, rejects paths that aren't git repos with an origin on GitHub
     (400), and upserts the project.
   - `POST /api/plans/validate` `{ text }` → `{ ok, title?, acceptanceCriteria?, errors? }`.
   - `POST /api/runs` `{ projectId, baseRef, planText, title?, mode?, model?, publish? }` →
     201 `{ runId }`, 400 with plan errors, 404 for an unknown project. Only registered
     projects can be run.
   - `POST /api/runs/:id/cancel` → `{ cancelled: boolean }`.
   Request bodies are validated with zod; unknown fields are rejected.
6. `src/cli/commands/review.ts`: create the manager with the opened store, run reconciliation
   at startup (via `startServer`), and call `manager.shutdown()` before closing on
   SIGINT/SIGTERM.

## Acceptance criteria

- [ ] `block-party run` behaves as before, building its deps through `createRunDeps`
      (existing CLI and pipeline tests pass).
- [ ] Aborting a run with a `ShutdownError` reason ends it `interrupted` with an
      `interrupted` decision; a plain abort still ends it `cancelled` (pipeline tests).
- [ ] `RunManager.start` with a fake `startPipeline` resolves with the run id, rejects an
      invalid plan with its errors without starting anything, and `cancel` aborts the
      in-process run (unit tests).
- [ ] `reconcileRuns` marks an active run with a dead local owner pid `interrupted` with an
      event and an open decision, and leaves runs that are terminal, owned by a live pid, or
      owned by another host unchanged (unit tests with a fake `isAlive`).
- [ ] `POST /api/runs` returns 201 with a run id for a registered project, 400 with plan
      errors for an invalid plan, 404 for an unknown project, and 401/403 without the token or
      with a foreign Origin (app tests with a fake manager).
- [ ] `POST /api/projects` registers a real temporary git repo with a GitHub origin and
      rejects a directory that is not a git repo (app test).
- [ ] `POST /api/plans/validate` returns the title and criteria of a valid plan and the
      errors of an invalid one (app test).
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` and `pnpm build`
      pass.

## Tests

`src/server/run-manager.test.ts`, `src/server/reconcile.test.ts` (new); additions to
`src/server/runs-api.test.ts`, `src/core/run/pipeline.test.ts`.

## Out of scope

- Any React UI (next tasks).
- Resuming interrupted runs; killing an implementer's pane on cancel (sessions are left
  running, as today).
- Running more than one run per project at a time is allowed but not specially handled.
