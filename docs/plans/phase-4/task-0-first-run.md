# First-run experience

## Goal

Someone opening block-party for the first time can start a run on one of their repos in
under a minute, without knowing block-party's internal vocabulary. The new-run form starts
from "which repo?", lists their GitHub repos, and handles the local clone itself. The home
page explains what block-party is when there's nothing on it yet.

## Problems this fixes (reported by the user, verbatim in spirit)

- "What's a project? Select a project doesn't show me anything." The project dropdown is
  empty until you register a local path by hand.
- "Add a project shows me a prompt for base ref. What is base ref?" The branch to start
  from is a required visible field. It should default to the repo's default branch and be
  hidden.
- "It should at a minimum show me my repos." `/api/repos` already lists them, but the
  new-run form doesn't use it.
- "Mode: pane / headless" and "Model" are visible to everyone as bare words.

## Context

- `src/web/components/NewRun.tsx` (431 lines) and `src/web/lib/newRun.ts` (`canStart`,
  `toRunRequest`). Projects come from `GET /api/projects`; `POST /api/projects { path }`
  registers a clone via `git.repoRoot`, `git.originRepo` and `git.defaultBranch`
  (`src/server/runs-api.ts`).
- `GET /api/repos` (`src/server/app.ts`/`api.ts`) returns `RepoSummary[]` for the viewer.
  `src/web/lib/repoList.ts` has ordering and filtering, and `RepoPicker.tsx` uses them.
- `Home.tsx`, `AppShell.tsx` (`TopBar`: "New run", "Repositories", logout),
  `StageBadge.tsx`, `DecisionItem.tsx`.
- `StartRunRequest` in `src/server/run-manager.ts` takes `projectId`, `baseRef`, and
  `planText` or `description`.

## Approach

1. **Finding local clones** in `src/server/local-clones.ts`:
   - `findLocalClones(roots: string[], git): Promise<LocalClone[]>`, where `LocalClone =
     { owner, repo, path }`.
   - Scans each root and its children, two levels deep, for directories containing `.git`.
     Reads each one's GitHub origin with `git.originRepo` and skips anything without a
     GitHub origin. Symlinks are resolved, duplicates are removed by realpath, and
     unreadable directories are skipped.
   - Roots: the parent directories of already-registered projects, plus whichever of
     `~/repos`, `~/code`, `~/src`, `~/projects`, `~/dev`, `~/Developer`, `~/git` and
     `~/workspace` exist.
   - Cached in memory for 60 s, with `?refresh=1` to bypass the cache.
2. **One list for the form.** `GET /api/new-run/repos` returns `{ repos: Array<{ owner,
   repo, private, pushedAt, defaultBranch | null, clones: string[], projectId | null }>,
   cloneRoot }`:
   - It merges `/api/repos` with the local clones and the registered projects.
   - A clone whose origin matches a GitHub repo attaches to that repo. A registered project
     whose repo isn't in the GitHub list still appears.
   - Sorted: registered projects first (most recently used), then repos with a clone, then
     the rest by `pushedAt`.
   - `cloneRoot` is the first existing default root, or `~/repos`.
3. **Picking a repo** gets a usable project for it with no typing:
   - `POST /api/new-run/prepare { owner, repo, clonePath? }` returns `{ project }`.
   - With an existing project, it returns that project.
   - With exactly one clone, it registers that clone.
   - With several clones, the client must pass `clonePath`, which must be one of them.
   - With no clone, it clones `https://github.com/<owner>/<repo>.git` into
     `<cloneRoot>/<repo>`, or `<cloneRoot>/<owner>-<repo>` if that path exists. It
     refuses when the path exists and is not that repo. It uses plain `git clone`, through
     the git service with a timeout, and the user's own git credentials.
   - Only repos the viewer can access, as listed by `/api/repos`, are accepted, and the
     origin is verified after cloning.
   - A failed clone returns the error and the exact command to run by hand.
4. **New-run form, rewritten top to bottom**:
   - **"Which repo?"**: a filterable list with keyboard navigation, reusing `repoList.ts`
     helpers and the `useListNav` pattern from `RepoPicker`. Each row shows owner/repo, a
     "private" badge, "on this computer" or "will be cloned to ~/repos/<repo>", and when it
     was last used.
     - A repo with several clones gets a small "Which copy?" select.
     - Selecting a row calls `prepare` and shows "Cloning…" when it has to clone.
   - **"What should it build?"**: the description textarea (the default). A secondary
     "I already have a plan" link switches to the paste/upload mode.
   - Helper text says the planner writes a plan first, and nothing is changed until you
     approve it.
   - **Start run** button. Disabled until a repo is ready and there's a description or a
     valid plan.
   - **"Advanced"** (collapsed `<details>`):
     - "Start from branch" (defaults to the repo's default branch, with the hint "The
       branch the new work starts from");
     - "Run title";
     - "Watch the agent in a terminal" checkbox (default on). It is `mode: pane` and hints
       "Off runs it in the background";
     - "Model" with the hint "Leave empty for the default";
     - "Open a draft PR when done" (publish).
   - No field is labelled Project, Base ref, Mode, pane or headless.
5. **Home**:
   - With no runs and an empty inbox, an intro block replaces "Nothing needs you" and "No
     runs yet". It has one sentence on what block-party does ("Describe a change; an agent
     plans it, you approve the plan, it builds, tests and reviews it, and you review the
     PR."), the three steps, and a primary **Start your first run** button.
   - Otherwise the sections stay. Rename the "Needs you" heading to "Waiting on you", and
     "Runs" to "Your runs".
   - TopBar: "Repositories" becomes "Review a PR", and "New run" stays as the primary button.
6. **Plain stage names**:
   - `StageBadge` and anywhere else a raw stage id is shown as text use a `stageLabel(stage)`
     map in `src/web/lib/stageLabel.ts`. Examples: `awaiting_plan_approval` → "Plan ready
     for you", `awaiting_review` → "Ready for your review", `awaiting_decision` → "Needs
     your answer", `waiting_ci` → "Waiting for GitHub CI", `interrupted` → "Interrupted",
     `blocked` → "Stuck — needs you".
   - Every `RunStage` gets an entry, enforced by a typed `Record`.
7. **Audit pass**: walk Home → New run → Run view as a new user and replace any other
   internal jargon in visible labels and empty states. Note each change in the report.

## Acceptance criteria

- [ ] `findLocalClones` finds clones two levels deep, skips non-GitHub origins and
      duplicates by realpath, and survives unreadable directories (`local-clones.test.ts`
      with a temp dir and fake git).
- [ ] `/api/new-run/repos`:
  - merges GitHub repos, clones and projects;
  - attaches clones by origin;
  - keeps projects missing from GitHub;
  - sorts as specified (`runs-api.test.ts` or a new `new-run-api.test.ts`).
- [ ] `/api/new-run/prepare`:
  - returns the existing project;
  - registers a single clone;
  - requires `clonePath` for several clones and rejects one that isn't listed;
  - clones when there's no clone (fake git), and refuses an occupied path holding another
    repo;
  - rejects repos the viewer can't access.
- [ ] `canStart`/`toRunRequest` default the start branch to the repo's default branch
      (`newRun.test.ts`).
- [ ] `stageLabel` covers every `RunStage` (`stageLabel.test.ts`).
- [ ] With an empty DB, the home page shows the intro, and New run lists the viewer's repos
      with the clone state marked. Picking a cloned repo and typing a description starts a
      run. [browser]
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` and `pnpm build` pass.

## Out of scope

- A settings page for clone roots (the defaults plus registered parents are enough for now).
- Cloning over SSH, forks, and GitHub Enterprise.
