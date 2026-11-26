# Planning in the UI

## Goal

I can start a run by describing a feature, read each plan version the planner writes, see
what changed between versions, and approve one or ask for changes. All of this happens in
the run view, without the terminal (`docs/plans/phase-3.md`, ARCHITECTURE 3.1 and 8).

## Context

- Task 5:
  - `POST /api/runs` accepts `description` instead of `planText`.
  - `GET /api/runs/:id/plans` returns every version with its text, status, author and
    feedback.
  - Runs rest in `awaiting_plan_approval` with a `plan_approval` decision whose options are
    `approve` / `revise`; `revise` needs a note.
- Task 1: `POST /api/inbox/:id/answer`, and `DecisionItem` with option buttons and a note.
- `src/web/components/NewRun.tsx` and `src/web/lib/newRun.ts` (`canStart`,
  `toRunRequest`).
- `src/web/components/RunView.tsx` (plan section, live refetch on `run` frames) and
  `AppShell.tsx` (layout tokens).

## Approach

1. **New-run form**:
   - Add a two-way switch at the top of the Plan section: "Describe the feature" (default)
     or "Paste a plan".
   - Describe mode shows a textarea (required, max 20000 chars) and no validation call.
   - Paste mode is today's behaviour.
   - `canStart` and `toRunRequest` take the mode into account: they send `description` or
     `planText`, never both.
2. **Plan panel in the run view** (`src/web/components/PlanPanel.tsx`):
   - A version selector (v1…vN, labelled with status and author; default: approved, else
     latest).
   - The selected plan rendered as Markdown text in a `<pre>`-style block, with its
     acceptance criteria listed.
   - The feedback that produced the version.
   - A "Changes from v<n-1>" toggle that shows a line diff.
   - While the run is in `awaiting_plan_approval`, Approve and "Request changes" sit right
     under the latest version. They answer the open `plan_approval` decision; "Request
     changes" opens a required note field.
   - While the run is `planning`, show "The planner is writing v<n>…" and the attach command.
3. **Pure helpers** in `src/web/lib/plans.ts`:
   - `lineDiff(a, b): Array<{ kind: 'same' | 'add' | 'del'; text: string }>` (an LCS over
     lines is fine, since plans are small);
   - `defaultVersion(plans)`;
   - `planActions(run, decisions)`, which returns the open `plan_approval` decision or null.
4. **Home**: runs resting in `awaiting_plan_approval` show "Plan v<n> ready" as their note,
   and the inbox item's buttons work there too (task 1 already renders options).

## Acceptance criteria

- [ ] `lineDiff`, `defaultVersion` and `planActions` cover a single version, a revised plan,
      an approved older version, and no open decision (`plans.test.ts`).
- [ ] `canStart`/`toRunRequest` send exactly one of `description`/`planText`
      (`newRun.test.ts`).
- [ ] Starting from a description lands on the run view. The planner's v1 appears when it is
      ready; Request changes produces v2 with a visible diff; Approve moves the run to
      implementing. [browser]
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` and `pnpm build` pass.

## Tests

New `src/web/lib/plans.test.ts`; `newRun.test.ts`.

## Out of scope

- Editing plan text in the app, and comments anchored to plan lines.
