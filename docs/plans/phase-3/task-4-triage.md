# Triage, disputes and stop conditions

## Goal

The review loop follows the spec's triage policy (ARCHITECTURE 3.3):
- P0/P1 go back to the implementer automatically.
- P2s ask me "fix / skip / defer" in the inbox.
- Everything else is recorded.

Disputes are never dropped silently; I rule on them. The loop stops and asks me when a fixed
finding comes back, when a fix is much broader than its findings, or when the review cap is
hit (`docs/plans/phase-3.md`, decisions 2 and 5).

## Context

- Task 1: `awaiting_decision` stage, decision kinds `finding_triage`, `dispute`,
  `broad_fix`, options and answers, and `ctx.rec.awaitDecision(id, signal)`.
- Task 3: `review_findings` rows (`insertFindings`, `setFindingStatus`, `listFindings`),
  keys `r<round>:<id>`, `repeatOf`, triage `auto_fix` / `ask` / `record`.
- `src/core/run/pipeline.ts` `verifyLoop`, `reviewFix`, `fixTurn`, `writeRulingsOnce`
  (writes `inputs/rulings.json` as `[]` today). The fix brief template
  (`src/core/agents/brief.ts`) already points the implementer at the rulings file.
- `src/core/run/config.ts` `policy` (`autoFix`, `maxReviewFixRounds`).
- `src/core/git` (`commitsBetween`, diff helpers). Check what exists before adding a diff-stat
  helper.

## Approach

1. **Policy**:
   - Add `ask: Severity[]` (default `['P2']`), `maxFixLinesPerFinding` (default 200) and
     `broadFixFiles` (default 10) to `policy`.
   - Triage of a finding: `auto_fix` if its severity is in `autoFix`, else `ask` if it is in
     `ask`, else `record`.
2. **Rulings file**: `inputs/rulings.json` becomes a list of
   `{ key, ruling: 'fix' | 'skip' | 'defer' | 'uphold' | 'accept_dispute', note }`,
   rewritten after every answer.
   - The fix brief already references it.
   - The reviewer prompt (task 3's prior-findings section) shows each ruling next to its
     finding and tells the reviewer not to re-raise findings I skipped, deferred, or whose
     dispute I accepted.
3. **Ask step.** After each review round, if any `ask` findings are `open`:
   - Open one `finding_triage` decision per finding, with options `fix` ("Fix it"),
     `skip` ("Skip"), and `defer` ("Defer"). The body holds the severity, title,
     location, body and suggested fix.
   - Move to `awaiting_decision` and wait for every answer.
   - `skip` sets the finding to `skipped`, `defer` to `deferred`, and `fix` makes it part of
     this round's fix set.
4. **Fix set** = open `auto_fix` findings + `ask` findings answered `fix`. If it is empty, the
   loop ends; otherwise run `reviewFix` with it (the existing cap applies).
5. **Disputes.** After a fix report, every finding resolved `disputed` opens a `dispute`
   decision:
   - The body holds the finding and the implementer's note.
   - Options are `accept_dispute` ("Agree, leave it") and `uphold` ("Fix it anyway").
   - Wait for all answers. `accept_dispute` sets `wont_fix`. `uphold` keeps the finding
     `open` and puts it in the next fix set, with the ruling in `rulings.json`.
   - An upheld finding that comes back `disputed` again opens the decision again; it is
     never dropped.
6. **Stop conditions** (each opens a decision and waits, or halts as described):
   - **Repeat after fixed:** a new finding whose `repeatOf` points at a finding with status
     `fixed` halts the run `blocked`, with a `blocked` decision naming both keys.
   - **Broad fix:** after a fix turn, if the lines changed exceed
     `maxFixLinesPerFinding × fix-set size`, or the turn deleted files, or it touched more
     than `broadFixFiles` files outside the fix set's paths, open a `broad_fix` decision.
     Its body holds the stats and file list; options are `accept` ("Keep the fix") and
     `stop` ("Stop the run"). `stop` halts the run `blocked`.
   - **Cap:** when the fix set is non-empty and `maxReviewFixRounds` is reached, keep the
     current behaviour (publish with the unresolved section and open `cap_reached`).
     `cap_reached` stays informational.
7. **Stage notes and events:**
   - While waiting, the stage note says what for, e.g. `2 P2 findings to triage`.
   - Record `triage.asked`, `triage.answered`, `dispute.opened`, `dispute.answered` and
     `fix.broad` events.
   - Add one-line summaries for them to `src/web/lib/runView.ts` `summarizeEvent`.

## Acceptance criteria

- [ ] With fakes, a round with one P1 and one P2 fixes the P1 automatically and asks about
      the P2; answering `fix` adds it to the fix round, and `skip` marks it `skipped`
      without a fix turn (`pipeline.test.ts`).
- [ ] A disputed finding opens a `dispute` decision. `accept_dispute` sets `wont_fix`, and
      `uphold` sends it back with the ruling in `rulings.json` (`pipeline.test.ts`).
- [ ] A round-2 finding with `repeatOf` pointing at a fixed finding blocks the run with both
      keys in the note (`pipeline.test.ts`).
- [ ] A fix turn over the line budget, or one that deletes a file, opens `broad_fix`; `stop`
      blocks the run (`pipeline.test.ts`, with a fake git diff stat).
- [ ] The reviewer prompt shows rulings and asks the reviewer not to re-raise
      skipped, deferred or accepted-dispute findings (`findings.test.ts`).
- [ ] A real run with a P2 finding shows the triage item, and answering it from the inbox
      moves the run on. [browser]
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` and `pnpm build` pass.

## Tests

`pipeline.test.ts`, `config.test.ts`, `src/core/reviewer/findings.test.ts`,
`src/web/lib/runView.test.ts`.

## Out of scope

- Configurable stop conditions beyond the three policy values above.
- Triage in the review page (task 7).
