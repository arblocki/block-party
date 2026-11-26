# Findings and "Send to implementer" in the review page

## Goal

When the PR I'm reviewing belongs to a run, the existing review page also shows:
- that run's Codex findings on the groups and lines they touch, with each finding's history
  across rounds;
- the plan's acceptance criteria;
- the latest check results.

From any finding, or from my own draft comment, **Send to implementer** sends it back as a
fix round, with no copying (ARCHITECTURE 8 "Review"; `docs/plans/phase-3.md`, decision 7).

## Context

- Task 2: runs rest in `awaiting_review` with a `final_review` decision. Answering
  `send_back` with a note starts a `feedback` continuation (fix turn → checks → review →
  push to the same PR → CI → `awaiting_review`).
- Task 3: `GET /api/runs/:id/findings` returns `FindingRow`s (key `r<round>:<id>`, path,
  lines, severity, status, `repeatOf`). `src/web/lib/findings.ts` has `findingHistory`.
- Review page: `src/web/App.tsx` (route `pr`), `Layout.tsx`, `GroupCard.tsx`,
  `HunkList.tsx`, `FileDiff.tsx`, `ThreadWidget.tsx`, `DraftComposer.tsx`,
  `src/web/lib/threadPlacement.ts` (`placeThreads` puts review threads on lines or at file
  level), `diffModel.ts`. Draft comments are synced through `draftSync.ts`.
- Runs know their PR: `runs.pr_number` with the project's owner/repo.

## Approach

1. **Find the run for a PR.**
   - Add `GET /api/runs?owner=&repo=&pr=` filtering, or a small `GET /api/pr-run?owner=&
     repo=&pr=`, returning the newest run for that PR.
   - Add a store query `findRunByPr(owner, repo, prNumber)`.
2. **Send-back endpoint.** `POST /api/runs/:id/send-back { findingKeys: string[], comments:
   Array<{ path: string; line: number | null; body: string }>, note?: string }`:
   - 409 unless the run is in `awaiting_review` with an open `final_review` decision.
   - 400 when everything is empty, or when a key is not one of the run's findings.
   - It builds the feedback text: each finding (key, severity, title, location, body,
     suggested fix), each comment (path:line and body), then the note.
   - It answers the decision with `send_back` and that text. That reuses task 2's
     continuation, so a double submit still starts one round.
3. **Findings on the diff**: `placeFindings(findings, shown, hidden)` in
   `src/web/lib/findingPlacement.ts`, placing each finding like `placeThreads` (by
   `path` + `endLine` on the new side), plus a `fileLevel` and an `unplaced` list.
   - Show only findings reviewed on the PR's current head, or still open from earlier rounds
     when their file is in the diff.
   - `FindingWidget.tsx` renders inline under the line:
     - severity badge, title, status, body, suggested fix;
     - a "History (n)" toggle using `findingHistory`;
     - a "Send to implementer" checkbox that adds the finding to a tray.
4. **Run panel** in the review page's side rail, only for run-linked PRs
   (`RunReviewPanel.tsx`):
   - run stage and link;
   - acceptance criteria (from the approved plan);
   - the latest local CI per head;
   - counts of open / fixed / disputed findings;
   - unplaced findings;
   - the **send tray**: selected findings, plus my draft comments with "Include" toggles,
     a note field, and a **Send to implementer** button (enabled when the run is in
     `awaiting_review` and something is selected). The button posts `send-back`, then shows
     "Sent — fix round started" and a link to the run view.
5. **From my own comment**: each pending draft comment in `DraftComposer`/`ThreadWidget`
   gets a small "Send to implementer" action that adds it to the tray. It never posts it to
   GitHub, and drafts keep working as they do today.
6. **Approve**: the panel also has "Approve run", which answers the `final_review` decision
   with `approve`. It is separate from submitting a GitHub review.

## Acceptance criteria

- [ ] `placeFindings` places findings on shown lines, at file level for files in the diff
      with no matching line, and in `unplaced` otherwise (`findingPlacement.test.ts`).
- [ ] `send-back` returns 409 outside `awaiting_review`, 400 for empty input or unknown keys,
      and on success answers the decision with a note containing every selected item
      (`runs-api.test.ts`).
- [ ] A PR not linked to any run shows the review page exactly as before. [browser]
- [ ] On a run-linked PR, Codex findings appear on their lines with history, and the run
      panel shows criteria and checks. [browser]
- [ ] Selecting a finding and one of my comments and pressing Send to implementer starts a
      fix round; after it finishes, the PR has a new commit and the run waits for review
      again. [browser]
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` and `pnpm build` pass.

## Tests

New `src/web/lib/findingPlacement.test.ts`; `runs-api.test.ts`; `runs.test.ts`
(`findRunByPr`).

## Out of scope

- Posting findings to GitHub; changing how drafts are submitted.
- Showing findings for PRs whose run lives in a different block-party data directory.
