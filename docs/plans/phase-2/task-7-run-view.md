# Run view

## Goal

`?run=<id>` shows one run in full and live: where it is, what happened, what evidence exists
for which commit, and what needs me. It is the page I return to after closing the browser
or restarting the server (`docs/plans/phase-2.md`; ARCHITECTURE 8 "Run view").

## Context

- Routing: `src/web/lib/route.ts` `{ kind: 'run'; id }`, `runHref`, `HOME_HREF`;
  `src/web/App.tsx` currently renders a placeholder for it.
- Server: `GET /api/runs/:id` → `{ run, stages, decisions }`, `GET /api/runs/:id/events`
  (`after`, `limit`), `GET /api/runs/:id/stream` (frames `run-event` with ids and `run`),
  `POST /api/runs/:id/cancel`, `POST /api/inbox/:id/dismiss` (`src/server/runs-api.ts`).
- Events written by the pipeline (`src/core/run/pipeline.ts`, `run-events.jsonl` types):
  `run.started`, `stage`, `implementer.session`, `implementer.waiting_for_human`,
  `agent.*`, `checks.result`, `checks.warning`, `drift.*`, `review.result`, `question`,
  `pr`, `publish.stopped`, `db.error`, `run.interrupted`. Stage rows (kinds `implement`,
  `check-fix`, `review-fix`, `checks`, `review`, `publish`, `wait-ci`) carry input/output
  JSON with paths, SHAs, pass/fail per check and finding counts.
- The run directory holds the plan (`plans/v1.md`), review findings
  (`reviews/round-<n>/findings.json`), and check logs; their paths are in run/stage rows.
- Styles: reuse `PickerShell`/`index.css` tokens and the badge styles from `Home.tsx`
  (`stageTone`).

## Approach

1. Server additions in `src/server/runs-api.ts` (with tests): `GET /api/runs/:id/plan` →
   `{ text, title, acceptanceCriteria }` read from the run's plan path, and
   `GET /api/runs/:id/findings` → `{ rounds: [{ round, reviewedSha, summary, findings }] }`
   read from the review stage outputs / findings files. Both read only files inside that
   run's `run_dir` (resolve real paths and refuse anything outside it).
2. `src/web/components/RunView.tsx`:
   - Header: title, `owner/repo`, branch, stage badge and note, PR link, created/updated
     times, link home. **Cancel** button while the run is active and owned by the server
     (the endpoint returns `cancelled: false` otherwise; show that as a note).
   - **Stage strip**: Implement → Local CI → Codex → Fix → Publish → CI, each with its state
     (pending, running, done, failed/blocked) and round counts, derived from stage rows.
   - **Needs you**: this run's open decisions, as on the home page (attach command, Dismiss).
   - **Plan**: title and acceptance criteria, with the plan text collapsible.
   - **Evidence**: local CI runs by head SHA (each check pass/fail with its log path), review
     rounds with reviewed SHA, summary and a findings table (severity, title, location,
     resolution when known).
   - **Activity**: the event feed, newest at the bottom, condensed one line per event (time,
     type, short summary), with noisy `agent.*` events collapsible.
   - Live: load once, then follow `/api/runs/:id/stream` from the last event id; new stage
     rows and decisions are refetched when a `run` frame arrives.
3. Pure helpers in `src/web/lib/runView.ts` (unit-tested): `stageStrip(stages, run)`,
   `summarizeEvent(event)` → one-line text for each event type above (unknown types fall
   back to the type name), `checksBySha(stages)`.
4. Wire `App` for `{ kind: 'run' }`.

## Acceptance criteria

- [ ] `stageStrip`, `summarizeEvent` and `checksBySha` produce the expected output for a
      representative completed run, a blocked run and a run in progress (unit tests).
- [ ] `GET /api/runs/:id/plan` and `/findings` return the run's plan and findings and refuse
      paths outside the run directory (app tests).
- [ ] The run view of a completed run shows its stages, plan and criteria, local CI per SHA,
      review rounds with findings, PR link and the full activity feed. [browser]
- [ ] While a run is in progress, new events and stage changes appear without reloading, and
      reloading the page shows the same state. [browser]
- [ ] Cancel on an in-process active run ends it `cancelled` and the view updates. [browser]
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` and `pnpm build` pass.

## Tests

`src/web/lib/runView.test.ts` (new), additions to `src/server/runs-api.test.ts`.

## Out of scope

- The new-run form (next task), embedded terminals, sending messages to the implementer.
- Showing diffs (the review route does that) or log file contents inline.
