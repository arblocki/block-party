# Answerable decisions and waiting stages

## Goal

Inbox items can ask me a question with fixed choices, and I can answer them from the UI. A
run can wait for an answer, either while its pipeline keeps running (`awaiting_decision`) or
at rest with no process owning it (`awaiting_plan_approval`, `awaiting_review`). This is the
foundation for the rest of Phase 3 (`docs/plans/phase-3.md`, decisions 1 and 2).

## Context

- `src/core/run/machine.ts`: `ACTIVE_STAGES`, `TERMINAL_STAGES`, `RUN_STAGES`, `FORWARD`,
  `canTransition`.
- `src/core/store/schema.ts` (`MIGRATIONS`, `decisions` table), `src/core/store/runs.ts`
  (`DecisionKind`, `Decision`, `openDecision`, `resolveDecision`, `dismissDecision`,
  `listDecisions`, `listRuns({ active })`).
- `src/core/run/recorder.ts` (`openDecision`, `openDecisionId`), used by `pipeline.ts`.
- `src/server/reconcile.ts` marks runs in active stages with a dead owner as `interrupted`.
- `src/server/runs-api.ts` (`/api/inbox`, `/api/inbox/:id/dismiss`, stream frames),
  `src/web/components/DecisionItem.tsx`, `src/web/lib/home.ts` (`stageTone`,
  `decisionLabel`), `src/web/types.ts`.

## Approach

1. **Stages.** In `machine.ts` add `planning` and `awaiting_decision` to `ACTIVE_STAGES`, and
   a new `RESTING_STAGES = ['awaiting_plan_approval', 'awaiting_review'] as const` that is
   neither active nor terminal. `RUN_STAGES` = active + resting + terminal. Export
   `isResting(stage)`. Moves:
   - `setup → planning`, `planning → awaiting_plan_approval`,
     `awaiting_plan_approval → planning | implementing | cancelled`;
   - every active stage `→ awaiting_decision`, and `awaiting_decision →` any active stage it
     can return to (`fixing`, `checking`, `reviewing`, `publishing`), `blocked`, `failed`,
     `cancelled`, `interrupted`;
   - `waiting_ci → awaiting_review`, `publishing → awaiting_review` (no-CI path),
     `reviewing → awaiting_review` (no-publish path),
     `awaiting_review → fixing | complete | cancelled`.
   Keep the existing moves (`waiting_ci → complete` etc.) so old behaviour still works until
   task 2 switches publishing over.
2. **Migration** (append to `MIGRATIONS`): add `options_json TEXT`, `answer_json TEXT`,
   `answered_at TEXT` to `decisions`. SQLite can't change a CHECK constraint in place, so
   rebuild the table (create `decisions_new` with status in
   `('open','answered','resolved','dismissed')`, copy, drop, rename, recreate the index) in
   the same migration.
3. **Store** (`runs.ts`): extend `DecisionKind` with `plan_approval`, `finding_triage`,
   `dispute`, `broad_fix`, `final_review`, `ci_gap`. Add `DecisionOption { id: string;
   label: string }` and `DecisionAnswer { choice: string; note: string | null }`; `Decision`
   gains `options: DecisionOption[] | null`, `answer: DecisionAnswer | null`,
   `answeredAt: string | null`. `openDecision` takes optional `options` and returns the id.
   New `answerDecision(id, answer): 'answered' | 'not_open' | 'bad_choice'`. It answers only
   an open decision whose options include `answer.choice`, in one transaction, so a second
   answer gets `not_open`. `listRuns({ active: true })` keeps returning only active stages;
   add `listRuns({ resting: true })`.
4. **Waiting helper** `src/core/run/wait.ts`:
   `waitForAnswer(store: Pick<RunStore,'getDecision'>, id: number, opts: { signal?:
   AbortSignal; intervalMs?: number }): Promise<DecisionAnswer>`. It polls every
   `intervalMs` (default 1000) and rejects with the signal's reason when aborted. If the
   decision is dismissed, it rejects with `DecisionDismissedError`. Add `getDecision(id)` to
   the store.
5. **Recorder**: `openDecision(kind, title, body, attach, options?)` returns the id (or
   `null` when the DB is unavailable, which is the existing `db.error` path). Add
   `awaitDecision(id, signal)`, which wraps `waitForAnswer` and records `decision.answered`
   with `{ id, choice }`.
6. **Reconciliation**: resting stages are never touched; `awaiting_decision` with a dead
   owner becomes `interrupted` like any active stage. Add a test for each case.
7. **API**: `POST /api/inbox/:id/answer { choice, note? }` → 200 `{ decision }`, 404 unknown
   id, 409 when not open, 400 for a choice not in the options or a note over 4000 chars.
   `GET /api/inbox` and the stream include `options` and `answer`. Dismissing a decision
   that has options is refused with 409, because an unanswered question would strand a
   waiting run.
8. **UI**:
   - `DecisionItem` shows one button per option, plus a note textarea that is collapsed by
     default ("Add a note"). It posts the answer, then shows the chosen label and disables
     the buttons. Items without options keep Dismiss.
   - `decisionLabel` covers the new kinds. `stageTone` maps `planning` and
     `awaiting_decision` to `active`, and the resting stages to a new `waiting` tone with
     its own badge style.
   - `orderRuns` puts resting runs right after active runs.

## Acceptance criteria

- [ ] `canTransition` allows exactly the moves listed above and still rejects moves out of
      terminal stages (`machine.test.ts`).
- [ ] The migration upgrades a DB that has old decision rows. The rows keep their data and
      get `options = null` (`store.test.ts` / `runs.test.ts`).
- [ ] `answerDecision` answers once. A second answer returns `not_open`, and a choice not in
      the options returns `bad_choice` (`runs.test.ts`).
- [ ] `waitForAnswer` resolves when another writer answers, rejects on abort, and rejects
      with `DecisionDismissedError` on dismiss (`wait.test.ts`, with fake timers).
- [ ] Reconciliation leaves `awaiting_plan_approval` and `awaiting_review` runs alone and
      marks a dead-owner `awaiting_decision` run `interrupted` (`reconcile.test.ts`).
- [ ] `POST /api/inbox/:id/answer` returns 200, 400, 404 and 409 as described, sits behind
      the token and Origin guards, and dismissing an optioned decision returns 409
      (`runs-api.test.ts`).
- [ ] An inbox item with options shows its buttons on Home and in the run view. Answering
      one shows the choice and survives a reload. [browser]
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` and `pnpm build` pass.

## Tests

`machine.test.ts`, `runs.test.ts`, `store.test.ts` (migration), new `wait.test.ts`,
`recorder.test.ts`, `reconcile.test.ts`, `runs-api.test.ts`, `home.test.ts`.

## Out of scope

- Opening any of the new decision kinds from the pipeline (tasks 2, 4, 5 and 9 do that).
- Continuations (task 2).
