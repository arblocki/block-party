# Planning stage

## Goal

A run can start from a feature description. block-party provisions the worktree, starts a
read-only planner (an Opus Claude session in a pane) that explores the repo and writes a plan
in the plan format, validates it, and stores it as version 1. The run then rests in
`awaiting_plan_approval` with a `plan_approval` inbox item:
- **Request changes** (with a note) resumes the planner, which writes the next version.
- **Approve** starts implementation from that exact version.

(ARCHITECTURE 3.1; `docs/plans/phase-3.md`, decision 6.)

## Context

- Task 1: stages `planning` and `awaiting_plan_approval` (resting), decision kind
  `plan_approval`, `answerDecision`, `POST /api/inbox/:id/answer`.
- Task 2: `loadContext`, `continueRun(runId, entry, deps, signal)`, `RunManager.continue`,
  answer handling in `runs-api.ts` that maps a decision answer to a continuation, and the
  `endRun` error handling.
- `src/core/run/pipeline.ts` `preflight` (reads and validates the plan file, sets
  `planPath`/`planHash`), `provision`, `implement` (starts the implementer with
  `implementerPermissions`).
- `src/core/agents/claude-config.ts` (`implementerPermissions`, settings and hooks),
  `src/core/agents/brief.ts` (brief templates), `src/core/run/plan.ts` (`parsePlan`),
  `docs/templates/plan.md` (format and validation rules).
- `src/server/run-manager.ts` `start` (validates `planText`), and `POST /api/runs` in
  `runs-api.ts`.

## Approach

1. **Plans table** (migration): `plans`, with `id`, `run_id`, `version` INT, `path`,
   `content_hash`, `title`, `status` (`draft` / `approved` / `superseded`), `created_by`
   (`agent` / `me`), `feedback` (the note that asked for this version; null for v1), and
   `created_at`. `UNIQUE(run_id, version)`.

   Store methods:
   - `addPlanVersion(...)`;
   - `approvePlan(runId, version)`, which sets that version to approved and the others to
     superseded in one transaction;
   - `listPlans(runId)`.

   A pasted plan is inserted as v1 `approved`, `created_by: 'me'`, at preflight.
2. **Run input.**
   - `RunInput` takes either `planFile` or `description` (exactly one).
   - `StartRunRequest` and `POST /api/runs` take either `planText` or `description` (1–20000
     chars); both or neither returns 400.
   - With a description, the title is `title` if given, else the description's first line
     cut to 72 chars.
   - The run's `planPath` stays empty until approval.
3. **Planner permissions**: `plannerPermissions(planPath, reportPath)` in
   `claude-config.ts`:
   - allowed: `Read`, `Glob`, `Grep`, the read-only git and shell commands from
     `implementerPermissions`, and `Write`/`Edit` for exactly the plan file and the report
     path (absolute-path rules);
   - disallowed: everything `implementerPermissions` disallows, plus `Bash(git add:*)` and
     `Bash(git commit:*)`;
   - permission mode `default`, so any other write prompts and becomes a `permission` inbox
     item.
4. **Planner brief**: `renderPlannerBrief({ description, planPath, templatePath,
   feedback, previousPlanPath })` in `brief.ts`.
   - It tells the planner:
     - to explore the repo read-only;
     - to write the plan in the template's format to `planPath`;
     - to follow the validation rules;
     - to write `report.json` with `status: 'done'` (or `blocked` with questions);
     - not to change any repo file.
   - On revisions, it points at the previous version and the feedback.
5. **Planning step** (`plan(ctx)` in `pipeline.ts`, after `provision`):
   - Set stage `planning`.
   - Start a planner session (a new session id, not the implementer's).
   - Judge the turn like `judgeTurn`, but with no commit required, and the worktree must
     still be clean. A dirty worktree blocks the run.
   - Read the plan and validate it with `parsePlan`. An invalid plan gets one automatic
     retry turn listing the errors; a second failure blocks the run with the errors.
   - Store the plan as `plans/v<n>.md` and add the version row.
   - Open `plan_approval` with options `approve` ("Approve") and `revise` ("Request
     changes").
   - Stop the planner process, keeping its session id in `RunState.planner`.
   - Rest in `awaiting_plan_approval`.
6. **Continuations** (extend `continueRun`'s entry):
   - `{ kind: 'plan_revise'; note }` resumes the planner session with the revision brief
     and repeats step 5 for the next version.
   - `{ kind: 'plan_approve' }` does the following:
     - approves the latest version;
     - sets `planPath`/`planHash`/`planVersion` and the run title from the plan;
     - writes the task brief;
     - runs `implement` → `verifyLoop` → publish → `awaiting_review`.

   The answer handler in `runs-api.ts` maps `plan_approval` answers to these entries;
   `revise` requires a note.
7. **API**: `GET /api/runs/:id/plans` → `{ plans: [{ version, title, status, createdBy,
   feedback, createdAt, text }] }`. It reads files only inside the run directory (reuse
   `readInsideRunDir`). `GET /api/runs/:id/plan` returns the approved version, else the
   latest.

## Acceptance criteria

- [ ] `POST /api/runs` with a description starts a run that rests in
      `awaiting_plan_approval` with a v1 plan and a `plan_approval` decision (fakes:
      `pipeline.test.ts`, `runs-api.test.ts`).
- [ ] Requesting changes resumes the same planner session with the note and produces v2.
      Approving v2 implements from v2, and v1 is `superseded` (`pipeline.test.ts`).
- [ ] An invalid plan gets one retry, then blocks the run with the validation errors. A
      planner that leaves the worktree dirty blocks the run (`pipeline.test.ts`).
- [ ] `plannerPermissions` allows writes only to the plan and report paths and disallows
      commits (`claude-config.test.ts`).
- [ ] A pasted plan is recorded as approved v1 by `me` (`pipeline.test.ts`).
- [ ] `/plans` returns all versions with their text and refuses paths outside the run
      directory (`runs-api.test.ts`).
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` and `pnpm build` pass.

## Tests

`runs.test.ts`, `claude-config.test.ts`, `brief.test.ts`, `pipeline.test.ts`,
`runs-api.test.ts`, `run-manager.test.ts`.

## Out of scope

- The planning UI (task 6); editing a plan by hand in the app.
- A planner on another model or headless mode (it uses the implementer's mode setting).
