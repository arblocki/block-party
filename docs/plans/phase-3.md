# Phase 3: planning in the app and the integrated review loop

## Goal

A run can start from a feature description instead of a finished plan. A read-only planner
writes the plan, I revise it and approve one version in the UI, and the run then implements,
checks, reviews and fixes on its own. It asks me only through inbox items I can answer (P2
triage, disputes, broad fixes, caps, CI gaps) and ends waiting for my final review. From the
review page I can send findings or my own comments back to the implementer.

Exit check (ARCHITECTURE 10, Phase 3): I start from a feature description and finish with a
reviewed PR, and the only things I did were approve a plan, answer inbox items, and do the
final review.

## Context

- Spec: `docs/ARCHITECTURE.md` sections 3.1–3.3, 5.1, 5.2, 5.5, 6, 7 and 8.
- Phase 2 (done): runs in SQLite (`src/core/store/runs.ts`, `schema.ts`), state machine
  (`src/core/run/machine.ts`), sequential pipeline (`src/core/run/pipeline.ts`) writing
  through `RunRecorder`, the run API and SSE (`src/server/runs-api.ts`), `RunManager`
  (`src/server/run-manager.ts`), reconciliation (`src/server/reconcile.ts`), and the web pages
  Home, RunView and NewRun (`src/web/components/`).
- The review loop today (`pipeline.ts` `verifyLoop`, `reviewFix`) auto-fixes
  `policy.autoFix` severities for up to `policy.maxReviewFixRounds` rounds, passes prior
  findings to Codex, and writes an empty `inputs/rulings.json`. Nothing else is triaged,
  and the run ends `complete` after publishing.
- Inbox items (`decisions`) are informational: they can only be dismissed.
- `ImplementerAdapter.send` resumes the Claude session when its process is gone
  (`src/core/agents/types.ts`), so a later turn can reuse the implementer's conversation.

## Decisions

1. **Answerable decisions.** A decision row can carry options (`[{ id, label }]`) and gets
   an answer (`{ choice, note }`). Informational kinds stay as they are. One endpoint answers
   any decision; the UI renders options as buttons plus an optional note.
2. **Two ways to wait.** Short waits inside the review loop (P2 triage, disputes, broad
   fixes) keep the pipeline running in stage `awaiting_decision` and poll the DB for the
   answer, so CLI runs can be answered from the UI too. Long waits (plan approval, final
   review) are **resting stages**, `awaiting_plan_approval` and `awaiting_review`. No process
   owns the run then, reconciliation leaves it alone, and the answer starts a
   **continuation** in the server.
3. **Continuations** rebuild the pipeline context from `run.json` and the DB, and enter at
   a named point: `implement` (after plan approval) or `feedback` (sent back from review).
   Resuming interrupted or blocked runs stays Phase 4.
4. **Findings become rows** (`review_findings`) with a run-unique key `r<round>:<id>`, a
   triage class (`auto_fix` / `ask` / `record`), a status, and `repeatOf` (the key of the
   earlier finding the reviewer says this one repeats). History is followed through
   `repeatOf`.
5. **Triage policy** (per project, `.block-party.yaml`): `autoFix` (default P0, P1), `ask`
   (default P2), everything else recorded. Rulings (dispute and triage answers) go to
   `inputs/rulings.json`, which both the implementer and the next reviewer see.
6. **The planner is a Claude pane session with a read-only tool profile.** It may write only
   its plan file and `report.json` in the run directory. Plan versions are rows in a `plans`
   table and immutable files `plans/v<n>.md`. A pasted plan is still approved v1.
7. **Publishing ends in `awaiting_review`** with a `final_review` decision: Approve (→
   `complete`) or Send back (→ `feedback` continuation). The review page's "Send to
   implementer" answers that decision with the chosen findings and comments.
8. **CI parity gap:** red GitHub CI after a green local CI becomes a `ci-fix` turn with the
   failing GitHub checks, then the usual loop and a new push, up to `policy.maxCiFixRounds`
   (default 1). Past the cap it becomes a `ci_gap` decision.

## Global constraints

1. TypeScript strict, ESM (`.js` suffixes in node code), Node ≥ 22. No new runtime
   dependencies.
2. Unit tests never launch `claude`, `codex`, `herdr` or reach GitHub; use injected fakes.
3. Never destroy work: no force push, branch deletion, `worktree remove`, or deleting run
   directories.
4. Every new HTTP endpoint is under `/api/*` (token-guarded) and goes through the existing
   Host/Origin guard. Endpoints that start processes accept only registered project paths
   and existing run ids.
5. Agent output is data: reports, plans and findings are schema-validated; their text is
   displayed, never executed.
6. Don't change existing review-UI behaviour except where a task adds to it.
7. Migrations append to `MIGRATIONS` in `src/core/store/schema.ts`; never edit an old one.
8. Each task passes `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` and
   `pnpm build`.

## Tasks

Sequential; each has a plan in `docs/plans/phase-3/`.

1. **Answerable decisions and waiting stages** (`task-1-decisions.md`).
2. **Run continuations and final review** (`task-2-continuations.md`).
3. **Findings as rows, with history** (`task-3-findings.md`).
4. **Triage, disputes and stop conditions** (`task-4-triage.md`).
5. **Planning stage** (`task-5-planning.md`).
6. **Planning in the UI** (`task-6-planning-ui.md`).
7. **Findings and "Send to implementer" in the review page** (`task-7-review-ui.md`).
8. **Evidence panel and acceptance criteria** (`task-8-evidence.md`).
9. **CI parity gap** (`task-9-ci-gap.md`).
10. **Exit check and docs**: run the exit check in a browser, then update the ARCHITECTURE
    checkboxes and decision log.

## Progress (2026-11-27)

All tasks built on main by Sonnet subagents, each with a task review (Opus for tasks 2, 4, 5
and 7) and fix rounds, then a whole-phase Opus review and one fix wave (`d4b6fae`).

| Task | Commits |
| --- | --- |
| 1 Answerable decisions | c0e4706, c2af54d |
| 2 Continuations and final review | 1b85e24, df4c030, add6513 |
| 3 Findings as rows | 8e8fe79, a1c9b43 |
| 4 Triage, disputes, stop conditions | 569820f, d284e7c, 021e473 |
| 5 Planning stage | 7f5e17b, 43cf67f |
| 6 Planning UI | 2149a30, 1c2f7fe |
| 7 Review page findings and send-back | d16a361 |
| 8 Evidence and acceptance | 34de6fa, f837a7b |
| 9 CI parity gap | 0155712 |
| Final review fixes | d3eb8b2..d4b6fae |
| 10 Exit check | Passed with PR #23; three bugs it found fixed in 0ed59c3 |

Known gaps, left for later: resting-run reopen at startup ignores live owners (only matters
with two servers on one DB); `rulings.json` is agent-writable; the review page's send tray is
desktop-only; P2 triage, disputes, broad fixes and the CI gap are covered by tests, not yet
seen in a live run.

## Review focus

1. A decision answered twice, or answered after its run ended, must not start two
   continuations or move a finished run.
2. A server restart while a run rests in `awaiting_plan_approval` or `awaiting_review`
   leaves the run resting, not `interrupted`.
3. A run waiting in `awaiting_decision` under the CLI is answered from the UI and goes on.
4. Old runs with no `review_findings` rows or `plans` rows still render (the file fallback
   stays).
5. A planner that writes outside its plan file, or exits without a plan, blocks the run
   with an inbox item instead of producing an empty plan.

## Acceptance criteria

- [x] Starting a run from a description produces a plan I can revise and approve in the UI;
      the approved version is what the implementer and reviewer read. [browser]
- [ ] P2 findings, disputed findings, broad fixes and the review cap each produce an inbox
      item with answer buttons, and the run continues according to my answer. [browser]
      (Pipeline tests only: the exit-check run had no such findings.)
- [x] A published run waits in `awaiting_review`; Approve completes it, and Send back from
      the review page starts a fix round that updates the PR. [browser]
- [x] The review page shows Codex findings on the lines they touch, with their history
      across rounds. [browser]
- [x] The run view shows acceptance criteria with their status and the evidence per SHA.
      [browser]
- [x] Red GitHub CI after green local CI starts a CI fix round, or an inbox item past the
      cap. (Unit tests with a fake GitHub client; browser if it happens naturally.)
- [x] `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` and `pnpm build` pass.

## Out of scope

- Resuming interrupted or blocked runs, parallel runs, embedded terminals (Phase 4).
- The verify stage (Phase 5); `e2e` findings are already in the schema but unused.
- Posting findings to GitHub, and merging.
- A global roles config file (`~/.config/block-party/config.yaml`).
