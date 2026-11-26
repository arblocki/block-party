# Findings as rows, with history

## Goal

Every Codex finding is stored as a row with a run-unique key, its triage class, a status that
changes as the run goes on, and a link to the earlier finding it repeats. The UI can then
show one finding's history across rounds, and the triage loop (task 4) can tell when a fixed
finding comes back (`docs/plans/phase-3.md`, decision 4).

## Context

- `src/core/reviewer/findings.ts` (`FindingSchema`, `ReviewerOutputSchema`) and
  `schema.ts` (`FINDINGS_JSON_SCHEMA`, which Codex gets as `--output-schema`). Keep the two
  in step.
- `src/core/reviewer/prompt.ts` renders prior findings and rulings for round N+1.
  Reviewer ids (`f_1`, `f_2`…) restart every round.
- `src/core/run/pipeline.ts` `verifyLoop` and `reviewFix` keep `ctx.rounds`
  (`ReviewRoundInput { round, reviewedSha, summary, findings, resolutions }`).
- `src/core/run/recorder.ts` writes stage rows and events; `src/core/store/runs.ts`.
- `GET /api/runs/:id/findings` (`src/server/runs-api.ts`) reads `findings.json` files and
  review-fix reports, and pairs each report with the closest earlier review.
- Run view evidence: `src/web/components/RunEvidence.tsx`.

## Approach

1. **Schema.**
   - Add `repeatOf: string | null` to the finding schema (both the zod and JSON schemas):
     the key of a prior finding this one raises again.
   - The prompt lists prior findings by key (`r<round>:<id>`) and tells the reviewer to set
     `repeatOf` when it re-raises one, and `null` otherwise.
   - Parsing an old findings file without the field gives `null`.
2. **Migration**: a `review_findings` table with these columns:
   - `id` INTEGER PK, `run_id`, `round` INT, `finding_id` TEXT;
   - `key` TEXT UNIQUE (`<runId>:r<round>:<finding_id>`; the API exposes `r<round>:<id>`);
   - `reviewed_sha`, `severity`, `category`, `title`, `body`, `path`, `start_line`,
     `end_line`, `confidence`, `suggested_fix`, `repeat_of`;
   - `triage` (`auto_fix` / `ask` / `record`);
   - `status` (`open` / `fixed` / `disputed` / `deferred` / `wont_fix` / `skipped`),
     `resolution_note`, `updated_at`.

   Add an index on `(run_id, round)`.
3. **Store** (`runs.ts`):
   - `insertFindings(runId, round, findings, triage: (f) => Triage)`;
   - `setFindingStatus(runId, key, status, note)`;
   - `listFindings(runId): FindingRow[]`, ordered by round then id.

   `FindingRow` uses camelCase, with `key` as `r<round>:<id>`.
4. **Recorder/pipeline**: after each review round, insert its findings. Triage is `auto_fix`
   when the severity is in `policy.autoFix`, and `record` otherwise; task 4 adds `ask`.
   After a review-fix report, set each finding's status from its resolution (`fixed`,
   `disputed`, `deferred`). An `auto_fix` finding with no resolution stays `open`.
5. **Prior findings for the reviewer** come from the rows: every finding from earlier
   rounds with its key, status and resolution note.
6. **API**: `GET /api/runs/:id/findings` returns
   `{ rounds: [{ round, reviewedSha, summary, findings: FindingRow[] }] }` from the rows when
   any exist, else the current file-based answer mapped to the same shape (status from the
   resolution, `triage` derived from severity, `repeatOf` null). Keep the path containment.
7. **History helper** `src/web/lib/findings.ts`:
   `findingHistory(rows, key): FindingRow[]` follows `repeatOf` back and forward, oldest
   first. The run view's findings table shows triage and status, and a small "history"
   toggle per finding when it has more than one entry.

## Acceptance criteria

- [ ] Codex output with and without `repeatOf` parses, and the prompt shows prior findings by
      key with their status (`findings.test.ts`).
- [ ] A two-round fake run stores both rounds' findings with distinct keys, statuses from
      the fix report, and the round-2 `repeatOf` (`pipeline.test.ts`, `runs.test.ts`).
- [ ] `/findings` returns rows for new runs and the file-based fallback for a run without
      rows (`runs-api.test.ts`).
- [ ] `findingHistory` returns the chain in order from any member, and handles a missing
      link (`findings.test.ts` in `src/web/lib`).
- [ ] The run view shows triage, status and history for a run with repeated findings.
      [browser]
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` and `pnpm build` pass.

## Tests

`src/core/reviewer/findings.test.ts`, `runs.test.ts`, `pipeline.test.ts`, `runs-api.test.ts`,
new `src/web/lib/findings.test.ts`.

## Out of scope

- Inbox triage of P2s and disputes (task 4), and findings in the review page (task 7).
