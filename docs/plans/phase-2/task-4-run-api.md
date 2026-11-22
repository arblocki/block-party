# Run API and live event streams

## Goal

The local server exposes runs, their stages and events, and the decision inbox over HTTP,
plus live streams so the UI can update without reloading. Everything is read from the
SQLite run tables (`docs/plans/phase-2.md`, decision 3), so runs started from a terminal and
runs started by the server look the same.

## Context

- `src/core/store/runs.ts` — `RunStore`: `listRuns`, `getRun`, `listStages`, `listEvents(runId,
  { afterId, limit })`, `latestEventId()`, `listDecisions`, `dismissDecision`,
  `openDecisionCount()`, `listProjects`. `Store.runs` from `openStore`.
- `src/server/app.ts` — `createApp(opts)`: Hono app with `hostGuard` on everything and
  `tokenGuard` on `/api/*` (token in the `x-block-party-token` header); `app.onError` maps
  errors to 502; unknown `/api/*` → 404. Tests in `src/server/app.test.ts` call
  `app.request(...)` with fakes and `openStore(':memory:')`.
- `src/web/api.ts` — the browser client sends the token header on every `fetch`. A browser
  `EventSource` cannot send headers, so live streams must be consumed with `fetch` and a
  streamed response body; the server sends standard `text/event-stream` framing.
- The CLI and the server write the same DB file concurrently; the server sees CLI writes on
  its next read.

## Approach

1. New module `src/server/runs-api.ts` exporting `registerRunsApi(app, { runs, pollMs?,
   heartbeatMs? })`, called from `createApp` (add `store.runs` use; no new `AppOptions`
   fields beyond optional timing overrides for tests).
2. JSON endpoints:
   - `GET /api/runs?active=1&limit=n` → `{ runs: RunSummary[] }` (id, title, stage, stageNote,
     owner/repo, branch, prNumber, createdAt, updatedAt, openDecisions count).
   - `GET /api/runs/:id` → `{ run, stages, decisions }`; 404 for an unknown id. The run id
     must match the run id format from `src/core/run/id.ts`; anything else is 400.
   - `GET /api/runs/:id/events?after=<id>&limit=<n>` → `{ events, lastId }` (default limit
     500, max 2000).
   - `GET /api/inbox?status=open|all` → `{ decisions }` with each decision's run title and
     stage.
   - `POST /api/inbox/:id/dismiss` → `{ changed: boolean }`.
   - `GET /api/projects` → `{ projects }`.
3. Streams (`text/event-stream`, `Cache-Control: no-cache`), implemented by polling the DB
   every `pollMs` (default 500 ms) and writing SSE frames:
   - `GET /api/runs/:id/stream?after=<id>` sends `event: run-event` frames (`id:` = event
     id, `data:` = the event JSON) for each new event of that run, then an
     `event: run` frame with the updated run summary whenever the run row's `updatedAt`
     changes. A `Last-Event-ID` request header is honoured like `after`.
   - `GET /api/stream` sends `event: runs` (the run list) and `event: inbox` (open decision
     count and latest decisions) whenever either changes, starting with one of each.
   - Both send a comment heartbeat (`: hb`) every `heartbeatMs` (default 15 s) and stop
     polling when the client disconnects (request abort signal). No timers may outlive a
     closed stream.
4. Web client helper in `src/web/lib/sse.ts`: `parseSse(chunkText, state)` that splits
   `text/event-stream` text into `{ event, id, data }` messages across chunk boundaries, and
   in `src/web/api.ts` an `openStream(path, onMessage, signal)` that uses `fetch` with the
   token header and reads the body with that parser, reconnecting with the last id after a
   dropped connection (backoff 1 s → 10 s). No UI in this task.

## Acceptance criteria

- [ ] `GET /api/runs`, `GET /api/runs/:id`, `GET /api/runs/:id/events`, `GET /api/inbox`,
      `POST /api/inbox/:id/dismiss` and `GET /api/projects` return the shapes above for data
      written through `RunStore` (app tests with an in-memory store).
- [ ] Every new endpoint returns 401 without the token header and 403 with a foreign
      `Origin` (app tests).
- [ ] Malformed run ids return 400 and unknown ones 404 (app tests).
- [ ] `GET /api/runs/:id/stream` delivers events appended after the stream opened, in id
      order and with their ids, and resumes after `Last-Event-ID` without repeating events
      (app test that reads the streamed body with short poll intervals).
- [ ] `GET /api/stream` sends an initial `runs` and `inbox` frame and a new frame after a run
      changes stage or a decision opens (app test).
- [ ] Closing a stream stops its polling: after abort, no further store reads happen
      (test with a counting fake or spy).
- [ ] `parseSse` handles frames split across chunks, multi-line `data:`, comments and `id:`
      lines (unit tests in `src/web/lib/sse.test.ts`).
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` and `pnpm build` pass.

## Tests

`src/server/runs-api.test.ts` (new), `src/web/lib/sse.test.ts` (new); existing server tests
keep passing.

## Out of scope

- Starting or cancelling runs, projects creation, reconciliation (next task).
- Any React UI.
- Changing existing review endpoints or the token mechanism.
