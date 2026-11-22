# Start a run from the UI

## Goal

From the home page I can start a run without a terminal: pick or add a project, choose a
base ref, paste or upload a plan, see it validated, start it, and land on its run view.

## Context

- Routing: `src/web/lib/route.ts` `{ kind: 'new-run' }`, `NEW_RUN_HREF`, `runHref(id)`;
  `src/web/App.tsx` renders a placeholder for it; `Home.tsx` links to it.
- Server (`src/server/runs-api.ts`): `GET /api/projects`, `POST /api/projects { path }`,
  `POST /api/plans/validate { text }` → `{ ok, title?, acceptanceCriteria?, errors? }`,
  `POST /api/runs { projectId, baseRef, planText, title?, mode?, model?, publish? }` →
  `{ runId }` or 400 with errors / 404.
- Plan format and validation rules: `docs/templates/plan.md`.
- Styles: `PickerShell`, `index.css` tokens.

## Approach

1. `src/web/components/NewRun.tsx`, a single form:
   - **Project**: select from `GET /api/projects` (label `owner/repo — path`), or "Add a
     project…" with a local path field that calls `POST /api/projects` and selects the
     result; show its error inline.
   - **Base**: text field defaulting to the project's default base.
   - **Plan**: a textarea plus a file input (`.md`) that loads the file's text into it.
     Validate with `POST /api/plans/validate` debounced (~400 ms) as the text changes; show
     the plan title and acceptance criteria when valid, or the error list when not.
   - **Options**: title override, mode (pane/headless, default pane), model (blank =
     default), "Open a draft PR at the end" checkbox (default on).
   - **Start** is enabled only with a project, a base and a valid plan; it posts
     `POST /api/runs` and on success navigates to `runHref(runId)`; on failure shows the
     error and keeps the form.
2. Pure helpers in `src/web/lib/newRun.ts` (unit-tested): `canStart(state)`,
   `projectLabel(project)`, `toRunRequest(state)` (trims fields, omits blanks).
3. Wire `App` for `{ kind: 'new-run' }`.

## Acceptance criteria

- [ ] `canStart`, `projectLabel` and `toRunRequest` behave as described (unit tests).
- [ ] Adding a project by path registers it and selects it; a bad path shows the server's
      error. [browser]
- [ ] Pasting an invalid plan shows its validation errors and keeps Start disabled; a valid
      plan shows its title and criteria and enables Start. [browser]
- [ ] Starting a run lands on its run view, which then shows the run progressing. [browser]
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` and `pnpm build` pass.

## Tests

`src/web/lib/newRun.test.ts` (new).

## Out of scope

- Writing plans in the app (Phase 3), plan templates, editing a plan after start.
- Server changes beyond fixing a bug the form exposes (with a test).
