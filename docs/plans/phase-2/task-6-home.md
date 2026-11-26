# App shell home: runs and inbox

## Goal

Opening block-party with no PR shows a home page: active and recent runs with their stage,
and the decision inbox, updating live. The repository and PR pages stay reachable from it,
and `block-party owner/repo#123` still opens the review directly. This is the first UI of
Phase 2 (`docs/plans/phase-2.md`, decision 6).

## Context

- `src/web/App.tsx` — `App` loads `/api/session` and picks a page with
  `routeFromSearch(location.search, session)` (`src/web/lib/route.ts`): `repos`, `pulls`, or
  `pr`. Navigation between pages is a full page load via `location.search`.
- `src/web/components/PickerShell.tsx`, `RepoPicker.tsx` — existing page frame, list styles
  (`listClass`, `rowClass`), and `relativeTime`. Reuse these styles and the CSS tokens in
  `src/web/index.css`; no new styling system.
- `src/web/api.ts` — `api<T>(path, init)` adds the token header; `openStream(path,
  onMessage, signal)` reads an SSE stream with `fetch` and reconnects.
  `src/web/lib/sse.ts` parses frames.
- Server endpoints (`src/server/runs-api.ts`): `GET /api/runs`, `GET /api/inbox`,
  `POST /api/inbox/:id/dismiss`, `GET /api/stream` (frames `runs` and `inbox`).
- Run stages: `src/core/run/machine.ts` (`ACTIVE_STAGES`, `TERMINAL_STAGES`).
- `src/server/app.ts` `/api/session` returns `{ repo, pr, label }` from how the server was
  started.

## Approach

1. Routing (`src/web/lib/route.ts`): add `{ kind: 'home' }`, `{ kind: 'run'; id }` and
   `{ kind: 'new-run' }`. `?home` → home, `?run=<id>` → run (invalid id → home),
   `?new-run` → new-run. With no query: the start PR or repo if the server was started with
   one (unchanged), otherwise **home** instead of the repository list. `?repos` still shows
   the repository list. Export `HOME_HREF`, `runHref(id)`, `NEW_RUN_HREF`.
2. `src/web/components/Home.tsx`: top bar with "block-party", links "New run" (to
   `?new-run`) and "Repositories" (to `?repos`). Two sections:
   - **Needs you**: open decisions, newest first: kind badge, title, run title, relative
     time, the body (first lines), the attach command in a copyable `<code>` with a Copy
     button when present, a link to the run, and Dismiss (calls the dismiss endpoint and
     removes the item). Empty state: "Nothing needs you."
   - **Runs**: active runs first, then the 20 most recent others; each row shows title,
     `owner/repo`, a stage badge (distinct styles for active, complete, blocked/failed,
     cancelled/interrupted), stage note, PR link when there is one, open-decision count, and
     relative updated time; the row links to `?run=<id>`. Empty state explains how to start a
     run.
   - Data: initial load from the JSON endpoints, then live updates from `/api/stream`; the
     document title shows the open decision count, e.g. `(2) block-party`.
3. Pure helpers in `src/web/lib/home.ts` (unit-tested): `orderRuns(runs)` (active first by
   updatedAt desc, then the rest, capped), `stageTone(stage)` →
   `'active' | 'done' | 'attention' | 'stopped'`, `decisionLabel(kind)`.
4. Add `src/web/types.ts` types for the run summary and decision shapes the API returns.
5. Wire `App`: `home` → `<Home />`; `run` and `new-run` render a placeholder ("coming
   soon") with a link home; later tasks replace them.

## Acceptance criteria

- [ ] `routeFromSearch` returns home for an empty query when the server has no start repo or
      PR, keeps returning the start PR or repo when it has one, and parses `?home`,
      `?run=<id>`, `?new-run` and `?repos` (unit tests in `route.test.ts`).
- [ ] `orderRuns`, `stageTone` and `decisionLabel` behave as described for every stage and
      decision kind (unit tests in `home.test.ts`).
- [ ] With the server started without a PR (`block-party`), the home page lists runs from the
      database with their stages and links to each run, and lists open decisions with their
      attach commands. [browser]
- [ ] A run changing stage, or a decision opening, appears on the home page within a couple
      of seconds without reloading. [browser]
- [ ] Dismissing a decision removes it, and it stays gone after reload. [browser]
- [ ] `block-party owner/repo#123` and `?repos` still show the review and repository pages.
      [browser]
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` and `pnpm build` pass.

## Tests

`src/web/lib/route.test.ts` (extend), `src/web/lib/home.test.ts` (new). The [browser]
criteria are checked by hand after the run; make sure they hold by running `pnpm build` and
`node dist/cli/index.js --no-open` against a DB with runs if you can.

## Out of scope

- The run view and the new-run form (next tasks; placeholders only).
- Any server change except what the UI strictly needs; if an endpoint is missing a field,
  add it to `src/server/runs-api.ts` with a test.
