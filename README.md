# block-party

A local dashboard for reviewing GitHub pull requests. Run it against a PR and it starts a
server on `127.0.0.1` and opens a review UI in your browser. See [docs/PLAN.md](docs/PLAN.md)
for the design and milestones, and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the
agentic delivery roadmap.

Status: M0 scaffold. The UI currently shows only the PR reference being reviewed.

## Setup

Requires Node 22+ and pnpm.

```sh
pnpm install
pnpm build
```

## Usage

```sh
pnpm start owner/repo#123
pnpm start https://github.com/owner/repo/pull/123 --port 8080 --no-open
pnpm start owner/repo          # or https://github.com/owner/repo
pnpm start                     # pick a repository first
```

The UI has three levels, and the argument picks which one it opens on:

- **Repositories** (no argument): repos you own, collaborate on, or see through an org, most
  recently pushed first (up to 500), with the ones you opened recently in this browser on top.
  Type any `owner/repo` or GitHub URL to open a repo that isn't listed, such as a public one.
- **Open pull requests** (`owner/repo`): most recently updated first (up to 500). Filter by
  number, title, author, branch or label. Type a number that isn't open to open it anyway.
  `← Repos` goes back to the repository list.
- **Review** (`owner/repo#123`): `← PRs` in the header goes back to the list, saving pending
  drafts first.

In both lists you can click, or use ↑/↓ and Enter. The address bar tracks where you are
(`?repos`, `?repo=owner/repo`, `?repo=owner/repo&pr=123`), so you can switch to any repo or
PR without restarting the server.

By default the browser is opened for you. With `--no-open` the full URL is printed. It
contains a session token (`#token=...`), so don't share or log it. When the browser is
opened automatically, the printed URL is redacted.

To reach the server through a reverse proxy (e.g. over a tailnet), set
`BLOCK_PARTY_ALLOWED_HOSTS` to a comma-separated list of extra `host[:port]` names; each is
accepted as the Host and as `https://<host>` for Origin. The server still binds 127.0.0.1. A
browser without `#token=` in its URL shows a login page: paste the token (set a stable one with
`BLOCK_PARTY_TOKEN`) once and the device gets an HttpOnly session cookie (`__Host-bp_session`);
the **Log out** button clears it. Cookie-only requests must carry `Sec-Fetch-Site: same-origin`.
Unset, behaviour is unchanged.

Flags: `--provider`, `--model`, `--port`, `--no-open`, `--debug`.

After `pnpm link --global`, run it as `block-party owner/repo#123`.

Analysis is opt-in: opening a PR only looks for a cached analysis and never calls the LLM.
Press **Analyze** in the header to run the provider (default `codex-cli`) and group the PR;
switching provider/model or loading new commits also waits for a click. **Re-analyze** forces
a fresh run.

Views (header): **By group** (default once the analysis finishes: groups in risk order, with
intent, risk reasons and a verify checklist), **Tests first**, and **By file** (the plain diff).
Each hunk has a reviewed checkbox, and the rail shows per-group and overall progress. Mechanical
groups are auto-cleared: pre-checked and marked "auto-cleared", but not counted as your review.
After new commits are pushed, a banner lists them and "Hide reviewed hunks" leaves only new or
changed hunks. Drafts that no longer fit the new diff are marked outdated and go in the review
body.

Shortcuts: `j`/`k` next/previous hunk, `J`/`K` next/previous group, `r` toggle reviewed, `c`
comment on the focused hunk, `?` help, `Esc` close dialogs.

Per-repo risk rules go in `.block-party.yaml` at the repo root (see
`docs/block-party.example.yaml`). Providers and models are set with `--provider`/`--model`, the
header switcher, or the config file (see `docs/PLAN.md` section 5.4).

To try the UI without a token, run `pnpm build && pnpm demo` (add `DEMO_REREVIEW=1` for the
re-review banner, `--picker` to start on the open-PR list, or `--repos` to start on the
repository list).

## Running a feature (Phase 1)

```sh
block-party run --repo . --plan plan.md [--base main] [--mode pane|headless] \
  [--model opus] [--reviewer-model <m>] [--no-publish] [--no-wait-ci] [--title <t>]
```

The plan is a Markdown file with an H1 title and the sections Goal, Approach, Acceptance
criteria (`- [ ]` items) and Out of scope. The run creates a worktree, has Claude implement
the plan, runs your local checks (with fix rounds), has Codex review it (one fix round for
P0/P1 findings), pushes the branch, opens a draft PR and waits for GitHub CI. Exit codes: 0
complete, 3 blocked (attach to the live session and continue by hand), 1 failed, 2 usage.

Prerequisites:

- `herdr` installed (pane mode), `claude` on your PATH, and `codex` logged in (`codex login`).
- A `checks:` section in `.block-party.yaml`: run `block-party checks init --write`.
- `~/.block-party/worktrees` trusted once in Claude Code (open `claude` there and accept the
  trust prompt), so pane sessions don't stop on the trust dialog.
- A GitHub token (`gh auth login` or `GITHUB_TOKEN`) for pushing and the PR.

Optional defaults live in a `run:` section of `.block-party.yaml` (`implementer`, `subagents`,
`reviewer`, `policy`, `publish`, `waitForCi`); flags override it.

Artifacts land in `~/.block-party/runs/<runId>/` (`run.json`, `run-events.jsonl`, `plans/`,
`briefs/`, `reports/`, `checks/`, `reviews/round-N/`, `inputs/`, `logs/`) and the worktree in
`~/.block-party/worktrees/<owner>__<repo>/<runId>/`. Nothing is deleted automatically.

## Authentication

The GitHub token is resolved in this order:

1. `gh auth token` (the GitHub CLI)
2. the `GITHUB_TOKEN` environment variable

Copy `.env.example` to `.env` for local environment variables (`GITHUB_TOKEN`,
`OPENROUTER_API_KEY`). `.env` is gitignored; never commit secrets. Tokens are never sent to
the browser.

## Development

```sh
PR=owner/repo#123 pnpm dev   # rebuilds the UI on change, restarts the server on port 5174
pnpm lint
pnpm typecheck
pnpm test
pnpm format
```

Data lives in `~/.block-party` (override with `BLOCK_PARTY_HOME`) and config in
`~/.config/block-party` (respects `XDG_CONFIG_HOME`).

## Layout

`src/cli` (entry point), `src/server` (Hono API, serves the built UI), `src/core`
(domain logic), `src/web` (React + Tailwind UI).
