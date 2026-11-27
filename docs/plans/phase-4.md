# Phase 4: a usable front door, reliability and parallel runs

## Goal

Someone who has never seen block-party opens the home page and starts a run on one of their
own repos without needing to know what a "project", a "base ref" or a "pane" is. After that
first run, runs survive crashes and restarts: they can be resumed and cancelled at any stage.
Several runs work in parallel without corrupting each other, agents get tighter permissions,
stuck sessions are noticed and nudged, and I can watch or steer a live agent from the run
view.

Exit check (ARCHITECTURE 10, Phase 4): three independent runs proceed in parallel for an
afternoon without corrupting each other or needing me except via the inbox.

## Context

- Spec: `docs/ARCHITECTURE.md` sections 5.1, 5.2, 5.2.1, 5.3, 5.6, 7, 8, 9 and 13.
- Phases 2–3 (done): runs in SQLite (`src/core/store/runs.ts`), state machine
  (`src/core/run/machine.ts`), pipeline and continuations (`src/core/run/pipeline.ts`
  `runPipeline`, `continueRun`, `ContinueEntry`), `RunManager`
  (`src/server/run-manager.ts`), reconciliation (`src/server/reconcile.ts`), the run API
  (`src/server/runs-api.ts`), the web pages Home, NewRun and RunView.
- Terminal stages have no outgoing moves yet ("no resume yet" in `canTransition`).
- The new-run form asks for a "Project" (a registered local clone, added by typing a path),
  a "Base ref", and "Mode: pane/headless". `/api/repos` already lists the viewer's GitHub
  repos for the review side (`RepoPicker.tsx`).

## Decisions

1. **Task 0 comes first** and is a prerequisite for everything else: it's the screen every
   other feature is reached through. Users pick a repo, not a project. A project is created
   on the fly from a local clone found on disk, or from a clone block-party makes.
2. **Resume is a continuation.** `interrupted` and `blocked` runs resume through
   `continueRun` with a new entry `resume`. It works out where to re-enter from the stage
   rows, `headSha` and report files. It never redoes work that has evidence on the current
   head.
3. **Queued runs rest.** A run started over the concurrency limit sits in a new resting stage
   `queued`, which no process owns. The manager starts it when a slot frees. Resting stages
   that wait on me don't take a slot.
4. **Git operations on a project's main clone are serialized** per project (fetch, worktree
   add). Work inside a run's own worktree is not.
5. **Permissions get narrower by default.** No `Bash(node:*)`, `find` or other
   prefix rules that allow arbitrary execution. Projects can add exact commands in
   `.block-party.yaml`. Claude Code's sandbox is opt-in (`policy.sandbox`).
6. **Rulings live in the DB.** `inputs/rulings.json` is regenerated from the DB before every
   turn, so an agent editing it changes nothing.
7. **Stalls are timers, not LLM calls.** No events for `policy.stallAfterMinutes` →
   one nudge typed into the pane, then an inbox item.
8. **The embedded terminal runs the run's own attach command** in a server-side pty,
   streamed over a token-guarded WebSocket. The client never chooses the command.

## Global constraints

1. TypeScript strict, ESM (`.js` suffixes in node code), Node ≥ 22. New runtime
   dependencies are allowed only where a task names them (task 6: `node-pty`,
   `@xterm/xterm`, `@xterm/addon-fit`, and `ws` or `@hono/node-ws`).
2. Unit tests never launch `claude`, `codex`, `herdr`, `git clone` against the network, or
   reach GitHub. Use injected fakes.
3. Never destroy work: no force push, branch deletion, `worktree remove`, or deleting run
   directories. Cancel and resume leave worktrees and branches as they are.
4. Every new HTTP or WebSocket endpoint is under `/api/*` (token-guarded) and goes through
   the existing Host/Origin guard. Endpoints that start processes accept only registered
   project ids, repos the viewer can access, and existing run ids.
5. Agent output is data: reports, plans and findings are schema-validated, displayed, never
   executed.
6. Migrations append to `MIGRATIONS` in `src/core/store/schema.ts`; never edit an old one.
7. UI text is plain English for someone new to block-party. Internal words (project, base
   ref, pane, headless, stage ids like `awaiting_decision`) don't appear as labels. Where a
   concept matters, one short sentence explains it.
8. Each task passes `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` and
   `pnpm build`.

## Tasks

Sequential; each has a brief in `docs/plans/phase-4/`.

0. **First-run experience** (`task-0-first-run.md`), the prerequisite.
1. **Resume interrupted and blocked runs** (`task-1-resume.md`).
2. **Thorough reconciliation and safe cancel at any stage** (`task-2-reconcile-cancel.md`).
3. **Concurrency limits and parallel runs** (`task-3-parallel.md`).
4. **Stronger permission profiles and optional sandbox** (`task-4-permissions.md`).
5. **Stall detection and auto-nudges** (`task-5-stalls.md`).
6. **Embedded terminal in the run view** (`task-6-terminal.md`).
7. **Exit check and docs**:
   - Start from an empty data directory and walk the first-run flow in a browser.
   - Run three runs in parallel on small real changes. Kill the server mid-run and resume.
   - Update the ARCHITECTURE checkboxes and decision log.

## Review focus

1. Two starts, or a start and a resume, racing for the last free slot must not both run, and
   a queued run must never be lost (a restart leaves it queued).
2. Resuming a run whose worktree has uncommitted changes, or whose HEAD moved since it was
   interrupted, must not discard or double-apply work. It asks instead.
3. Cancelling while a check process, the reviewer or a planner is running leaves no orphaned
   child processes and no half-written stage row.
4. A repo picked in the new-run form that is cloned twice on disk, or whose clone has a
   different origin, must not be registered against the wrong path.
5. The terminal WebSocket rejects a missing token, a foreign Origin and a run id that
   doesn't exist, and never spawns anything derived from client input.

## Acceptance criteria

- [ ] From an empty data directory, the new-run form lists my GitHub repos, marks the ones
      already on disk, and starts a run on one without my typing a path or a branch name.
      [browser]
- [ ] An `interrupted` run (server killed mid-implement) resumes from the inbox and finishes.
      [browser]
- [ ] Cancel works in every active stage and leaves no running child processes (tests).
- [ ] With the limit at 2, a third start waits in `queued` and starts when one finishes
      (tests; browser in the exit check).
- [ ] The implementer profile has no rule that allows arbitrary execution, and edits to
      `inputs/rulings.json` by an agent have no effect (tests).
- [ ] A session silent past the stall limit gets one nudge, then an inbox item (tests).
- [ ] The run view's terminal shows the live implementer pane, and typing reaches it.
      [browser]
- [ ] Three runs proceed in parallel without interfering. [browser]
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` and `pnpm build` pass.

## Out of scope

- The verify stage (Phase 5).
- Containers or VMs for agents. The sandbox here is Claude Code's own.
- Multiple servers sharing one DB.
- Run templates, auto-merge.
