# CI parity gap

## Goal

When GitHub CI fails on a head that passed local CI, the run doesn't just stop. It records
the gap, gives the implementer the failing GitHub checks in a `ci-fix` round, and goes
through local CI and Codex review again before pushing once more. Past
`policy.maxCiFixRounds` it asks me (ARCHITECTURE 5.4 and 5.5; `docs/plans/phase-3.md`,
decision 8).

## Context

- `src/core/run/pipeline.ts` `publish`: after `waitForCi` returns `failure`, it halts
  `blocked` with "parity gap". Task 2 reworked the end of `publish` to rest in
  `awaiting_review`, and the `feedback` continuation already does fix → `verifyLoop` → push
  → wait CI.
- `waitForCi` (`src/core/run/publish.ts`) returns `{ state, checks: CiCheck[] }`, where
  `CiCheck = { name, status, conclusion, url }` (`src/core/github/types.ts`).
- The check runner's names and the project's required checks (`ctx.checks.required`), and
  `checks.drift` warnings recorded at preflight.
- Task 1: decision kind `ci_gap` with options. Task 4: `fixTurn` kinds and rulings.
- `fixTurn(ctx, kind, n, findingsPath, extra)`; `RunState.rounds`.

## Approach

1. **Policy**: add `maxCiFixRounds` (default 1) to `policy`, and `rounds.ciFix` (default 0)
   to `RunState`.
2. **Gap report** `renderCiFailures(checks, head, localChecks)` in
   `src/core/run/pipeline-helpers.ts`. It writes `inputs/ci-failures-<n>.md` listing:
   - each failed GitHub check (name, conclusion, URL);
   - the local checks that passed on the same head;
   - the hint that a GitHub check with no local equivalent is a parity gap to note in the
     report summary.

   The implementer may not have network access, so no logs are fetched; the URL is
   informational.
3. **Loop.** Restructure the end of `publish` as `publishAndWait(ctx)`. On `failure`:
   - Record `ci.failed` with the failing names.
   - Open an informational `ci_gap` item: "GitHub CI failed on abc123 after local CI passed:
     <names>".
   - If `rounds.ciFix < maxCiFixRounds`: run a `ci-fix` turn (commit required) with the gap
     report, then `verifyLoop`, then `publishAndWait` again. The push updates the same PR,
     with the head confirmed.
   - Otherwise open a `ci_gap` decision with options `retry` ("Try another fix round") and
     `stop` ("Stop"), and wait in `awaiting_decision`. `retry` runs one more round; `stop`
     halts the run `blocked`.
   - `timeout` keeps today's behaviour (blocked).
4. **UI**: `summarizeEvent` covers `ci.failed`, and the stage strip counts CI fix rounds in
   the CI cell.

## Acceptance criteria

- [ ] With a fake GitHub client that fails once then succeeds, the run makes one `ci-fix`
      turn with the failing check names in its input, re-runs local CI and review, pushes,
      and rests in `awaiting_review` (`pipeline.test.ts`).
- [ ] With CI failing every time, the second failure opens a `ci_gap` decision; `stop` blocks
      the run and `retry` makes one more round (`pipeline.test.ts`).
- [ ] `renderCiFailures` lists failed checks with conclusions and URLs, and the local checks
      that passed (`pipeline-helpers` test).
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` and `pnpm build` pass.

## Tests

`pipeline.test.ts`, `config.test.ts`, a new or extended test for `pipeline-helpers.ts`,
`runView.test.ts`.

## Out of scope

- Fetching GitHub job logs, and adding missing local checks automatically.
