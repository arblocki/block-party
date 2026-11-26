# Evidence panel and acceptance criteria

## Goal

The run view answers "what is proven, on which commit, and what isn't yet" at a glance:
- each acceptance criterion with its latest status and evidence;
- which checks, review rounds and CI results apply to the current head;
- what is still unverified.

(ARCHITECTURE 8 "Run view"; `docs/plans/phase-3.md`.)

## Context

- Implementer reports (`reports/<kind>-<n>.json`, schema in `src/core/run/report.ts`)
  carry `acceptance: [{ criterion, status: 'met' | 'not_met' | 'unsure', evidence }]`.
  `ctx.reports` keeps them in order.
- Stage rows (`stages`) for `checks` (input `headSha`, output with per-check pass/fail),
  `review` (input `reviewedSha`), `publish` and `wait-ci` (input `headSha`, output `state`).
- The run's `headSha`; the approved plan's criteria (`GET /api/runs/:id/plan`).
- Web: `src/web/components/RunEvidence.tsx`, `src/web/lib/runView.ts` (`checksBySha`,
  `stageStrip`), `PlanPanel.tsx` (task 6).

## Approach

1. **API**: `GET /api/runs/:id/acceptance` → `{ criteria: [{ criterion, status, evidence,
   fromReport: '<kind>-<n>' }] }`.
   - For each plan criterion, take the newest report that mentions it. Match on normalized
     text: trimmed, whitespace-collapsed, case-insensitive; a report entry that doesn't
     match any criterion is listed with `criterion` as written and `extra: true`.
   - A criterion no report mentions gets status `unverified`.
   - Read report files only inside the run directory.
2. **Evidence model** `evidenceFor(head, stages)` in `src/web/lib/evidence.ts` returns:
   - `{ head, checks: 'passed' | 'failed' | 'none', review: { round, blocking, open } | null,
     ci: 'success' | 'failure' | 'no_ci' | 'pending' | 'none' }` for the current head;
   - `stale`, the evidence that exists only for older heads, so the panel can say "review
     round 2 was on abc123, not the current head".
3. **UI**:
   - Under the plan, an **Acceptance** list with a status chip (met / not met / unsure /
     unverified), the evidence text, and the report it came from.
   - Above Evidence, a one-line **Current head** summary: `abc1234 · local CI passed ·
     review r2 clean · GitHub CI pending`, with stale items muted underneath.
   - The stage strip's Implement and Fix cells show the count of met criteria
     (e.g. `5/7`).

## Acceptance criteria

- [ ] `/acceptance` matches report entries to plan criteria by normalized text, keeps the
      newest status, marks unmatched entries `extra`, and marks unmentioned criteria
      `unverified` (`runs-api.test.ts`).
- [ ] `evidenceFor` gives the right summary for a run whose head has checks and review, a
      run whose latest review is on an older head, and a run with no checks yet
      (`evidence.test.ts`).
- [ ] The run view of a finished run shows each criterion's status and the current-head
      line. [browser]
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` and `pnpm build` pass.

## Tests

New `src/web/lib/evidence.test.ts`; `runs-api.test.ts`.

## Out of scope

- Verify-stage results (Phase 5), and checking claims against the code automatically.
