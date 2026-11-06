# block-party: Architecture and Roadmap

A living design doc for turning block-party from a PR review dashboard into an **agentic
software delivery workspace**: one local app that takes a feature from an approved plan
through implementation, verification, adversarial review, fixes, and finally my own review,
with as few manual handoffs as possible.

This doc is updated as the system is built. Each phase in the [roadmap](#10-roadmap) has
checkboxes, and every non-obvious choice goes in the [decision log](#12-decision-log). When
the code and this doc disagree, fix whichever one is wrong in the same PR.

- **Status:** Phase 0 (design and spikes). Review UI (M0–M3 of `PLAN.md`) is shipped.
- **Owner:** Drew Blocki
- **Last updated:** 2026-11-05
- **Related:** [`PLAN.md`](PLAN.md) is the detailed spec for the review subsystem (diff
  grouping, risk, comments, re-review). This doc covers everything around it.

---

## 1. Vision

My current process works, but I am the message bus:

1. Write a detailed plan with Claude (Opus).
2. Have Opus implement it, delegating bounded pieces to Sonnet subagents.
3. Run an adversarial review with Codex.
4. Copy the findings back into Claude, have it fix them, re-run Codex.
5. Review the PR myself in block-party, then merge.

Every arrow between those steps is me copying text, switching terminals, and remembering
what state things are in. block-party should own those arrows.

**The goal:** I approve a plan, disengage, and come back to a PR that has been implemented,
checked, independently reviewed, and fixed, together with the evidence that shows what was
verified and what still needs my judgment. I get interrupted only for real decisions.

### What block-party is, and isn't

| | Firstmate (Kun Chen) | block-party |
|---|---|---|
| Shape | One AI coordinator managing a fleet of agents across projects | One workspace taking a feature from plan to merge-ready PR |
| Optimizes for | Throughput across many parallel tasks | Confidence and speed per feature |
| Who decides "what's next" | The coordinator agent | A deterministic workflow engine |
| Entry point | A conversation | An app: projects, runs, decision inbox, review |
| Review | Pluggable delivery gate | Cross-model adversarial review as a first-class stage |

block-party borrows Firstmate's best ideas (worktree isolation, persistent task briefs,
durable state outside agent conversations, event-driven supervision, separating messages
from lifecycle control) and skips the parts that solve problems I don't have yet
(secondmates, remote workers, multi-backend terminals, quota-based dispatch). See
[section 11](#11-borrowed-from-firstmate) for the full list.

### Non-goals (for now)

- Multiple users, hosting, or distributing it as a product. It runs on my machine with my
  Claude and Codex subscriptions.
- A general-purpose agent framework. The agents (Claude Code, Codex) already handle tool
  calls, context, and model interaction. block-party orchestrates them.
- Auto-merge. Deferred until there's a track record that justifies it.
- A wall of chat windows. The UI shows meaningful progress and decisions, not every token.

---

## 2. Principles

These are the rules to check designs against.

1. **The workflow engine decides what happens next; agents decide how to do the work.**
   Stage transitions are code, not prompts. No agent is trusted to remember workflow
   obligations.
2. **Every stage produces an artifact the next stage consumes.** Planning produces a
   versioned `plan.md`, not a chat reply. Implementation produces commits on a branch, not
   "I'm done". Review produces findings against a specific SHA, not "looks good".
3. **Evidence over agent confidence.** An agent exiting cleanly is not the stage succeeding.
   block-party independently verifies everything it can: commits exist, the diff is non-empty,
   checks actually ran and passed, the PR exists and its head SHA matches.
4. **Every review result is pinned to a commit SHA.** A finding or a "clean" verdict about
   commit `abc123` says nothing about `def456`. (The review UI already enforces this for
   human review; the same rule applies to agent review.)
5. **The record of the work lives outside the agents.** Plans, briefs, events, findings, and
   decisions live in SQLite and on disk, and survive crashes, restarts, and closed tabs.
6. **The implementer never grades its own work.** Codex review runs as a separately managed
   stage with its own process and recorded result.
7. **Bounded loops.** Every automatic retry and review/fix cycle has a cap. Hitting the cap
   escalates to me; it never loops forever.
8. **Never destroy work silently.** Worktrees and branches are kept until the work is
   verifiably published or I explicitly discard it.
9. **Build the narrow thing that works before the general thing.** One reliable local
   feature run beats ten flaky concurrent ones.

---

## 3. The feature run

A **run** is one feature (or bug fix) going from plan to merge-ready PR on one branch, in
one worktree, with one accountable implementer.

```
 ┌────────────┐   ┌──────────┐   ┌─────────────┐   ┌──────────┐   ┌──────────┐   ┌─────────┐   ┌──────────────┐
 │ 1. Plan    │──▶│ 2. Impl  │──▶│ 3. Checks   │──▶│ 4. PR    │──▶│ 5. Codex │──▶│ 6. Fix  │──▶│ 7. My review │
 │ Opus,      │   │ Opus +   │   │ build, type │   │ draft PR │   │ review   │   │ Opus    │   │ block-party  │
 │ read-only  │   │ Sonnet   │   │ lint, test  │   │ from     │   │ pinned   │   │ resumes │   │ review UI +  │
 └─────┬──────┘   └──────────┘   └─────────────┘   │ worktree │   │ to SHA   │   │ session │   │ evidence     │
       │                               ▲           └──────────┘   └──────────┘   └────┬────┘   └──────────────┘
   I approve                           └──────────────── loop, max N rounds ─────────┘
```

| # | Stage | Input | Output (artifact) | Done when (verified by block-party) | Human? |
|---|---|---|---|---|---|
| 1 | Plan | Task description, repo, references | `plan.md` (versioned) | I approve a specific plan version | Yes, always |
| 2 | Implement | Approved plan, task brief | Commits on the run branch, `report.json` | Agent signals done **and** branch has new commits **and** worktree is clean | Only if blocked |
| 3 | Checks | Worktree, configured commands | Check results with logs and exit codes | All required checks exit 0 on the current HEAD | Only on repeated failure |
| 4 | Publish | Branch, base | PR number, head SHA | GitHub confirms the PR and its head SHA matches local HEAD | No |
| 5 | Review | Diff `base_sha..head_sha`, plan | Structured findings pinned to `head_sha` | Reviewer process exits 0 and output validates against the schema | No |
| 6 | Fix | Actionable findings | New commits, per-finding resolution | Fix commits exist; then back to 3 | Judgment calls only |
| 7 | Human review | Current PR + all evidence | My decision | I approve, or send it back with instructions | Yes, always |

**Autonomy policy (default):** hands-off between plan approval and my review. The run
implements, checks, reviews, and auto-fixes blocking findings for up to `maxReviewRounds`
(default 3), and only interrupts me for blockers and judgment calls via the
[decision inbox](#8-product-and-ui).

### 3.1 Planning: import first, in-app later

- **Phase 1:** the run starts from a `plan.md` I wrote in an interactive Claude Code
  session. `block-party run --plan path/to/plan.md`. Importing counts as approval of v1.
- **Phase 3:** block-party runs planning itself: a read-only Opus session explores the repo
  and writes the plan; I comment on it or ask for revisions in the UI; each revision is a
  new immutable plan version; I approve one version. That version is what the implementer,
  reviewer, and my final review all reference.

Either way the approved plan is stored by content hash, and every later stage records which
plan version it worked from.

### 3.2 The task brief

The implementer does not get my whole planning conversation. block-party generates a
**task brief** from a template, saved with the run so I can inspect exactly what the agent
was told:

- **Goal and plan:** a path to the approved `plan.md`.
- **Acceptance criteria:** pulled from the plan (a required section of the plan format).
- **Context:** repo conventions (`CLAUDE.md`/`AGENTS.md` are read by the agent anyway),
  base branch, related PRs or issues.
- **Boundaries:** what it may change, what is off-limits (e.g. no dependency upgrades,
  no edits to CI config) unless the plan says otherwise.
- **Delegation rules:** use the Sonnet subagents for bounded pieces; give each subagent
  clear file/module ownership so they don't collide in the shared worktree; Opus owns
  integration and the final state of the branch.
- **Completion contract:** commit all work (no uncommitted changes), run the check commands
  locally, then write `report.json` (schema below) and stop. Don't push, don't open PRs.
  block-party does that.
- **How to get unstuck:** if blocked on a decision, write a `blocked` report with the
  question instead of guessing.

```jsonc
// report.json: written by the implementer at the end of each stage
{
  "status": "done" | "blocked" | "partial",
  "summary": "what was built, in a few sentences",
  "acceptance": [{ "criterion": "...", "status": "met" | "not_met" | "unsure", "evidence": "..." }],
  "questions": ["only when blocked"],
  "findingResolutions": [   // only in fix rounds
    { "findingId": "...", "resolution": "fixed" | "disputed" | "deferred", "note": "..." }
  ]
}
```

The report is a claim, not evidence. block-party checks it against reality (commits,
checks, diff), and a claim that doesn't match reality becomes an inbox item.

### 3.3 The review/fix loop

This is the part I do by hand most often today, and the main reason block-party exists.

**Finding schema** (normalized from whatever the reviewer emits):

```jsonc
{
  "id": "f_…",                 // stable within a run
  "reviewedSha": "abc123",     // the head this finding is about
  "severity": "P0" | "P1" | "P2" | "P3",
  "category": "correctness" | "security" | "concurrency" | "tests" | "design" | "style" | "...",
  "title": "Authorization check missing",
  "body": "…",
  "location": { "path": "src/x.ts", "startLine": 10, "endLine": 14 } | null,
  "confidence": "high" | "medium" | "low",
  "suggestedFix": "…" | null
}
```

**Default triage policy** (configurable per project):

| Severity | Default action |
|---|---|
| P0 / P1 | Blocking. Sent back to the implementer automatically. |
| P2 | Goes to the decision inbox: I pick fix / skip / defer. (Can be set to auto-fix.) |
| P3 | Recorded and shown in review. Never triggers a fix round on its own. |

**Rules:**

- Fixes go back into the **same implementer session** (resumed), so Opus keeps its context
  of the plan and the code it wrote.
- The implementer may **dispute** a finding with a reason. A disputed finding is never
  silently dropped: it goes to the inbox with both sides.
- After a fix round, checks run again, then Codex reviews the **new** head. Old findings
  remain in history but say nothing about the new head.
- The reviewer in round N+1 sees the prior findings and their resolutions, so it can
  confirm fixes and avoid re-raising disputed points I already ruled on.
- **Stop conditions:** no blocking findings on the current head → advance to my review.
  `maxReviewRounds` hit, or the same finding reappears after being marked fixed, or a fix
  round produces a diff much bigger than the findings justify → stop and escalate.
- Destructive or unusually broad fixes (deleting files, touching many unrelated modules)
  require my approval even when the finding is P1.

---

## 4. System architecture

```
┌──────────────────────────────── block-party (one local Node process) ────────────────────────────────┐
│                                                                                                      │
│  React UI  ◀── SSE ──  Hono API ──▶ Workflow engine (run state machine, policies, decision inbox)     │
│  projects · runs ·          │              │                                                         │
│  inbox · review             │              ├──▶ Agent runner ──▶ adapters: claude (tmux | headless), │
│                             │              │                              codex (headless)           │
│                             │              ├──▶ Git service (worktrees, branches, SHAs)              │
│                             │              ├──▶ Check runner (configured commands, logs)             │
│                             │              └──▶ GitHub client (PRs, CI status) — existing            │
│                             │                                                                        │
│                             └──▶ Review subsystem (diff grouping, risk, comments) — existing         │
│                                                                                                      │
│  SQLite ~/.block-party/block-party.db: projects, runs, stages, sessions, events, artifacts, findings │
│  Files  ~/.block-party/runs/<runId>/:  plans, briefs, reports, event logs, check logs, review output  │
│  Worktrees ~/.block-party/worktrees/<owner>__<repo>/<runId>/                                          │
└──────────────────────────────────────────────────────────────────────────────────────────────────────┘
          │ tmux sessions bp-<runId>-<stage>  (I can `tmux attach` to any live agent)
```

Three boundaries that hold from day one:

1. **Workflow engine:** deterministic, database-backed authority over run state.
2. **Agent adapters:** Claude and Codex run bounded stages behind one interface and never
   own the workflow.
3. **Evidence layer:** plans, diffs, checks, findings, and decisions are inspectable
   independent of any agent.

### 4.1 What already exists and gets reused

| Existing | Reused for |
|---|---|
| `src/core/llm/spawn-cli.ts` (process groups, timeouts, kill escalation, exit cleanup) | Base for headless agent processes (Codex review, headless Claude) |
| `src/core/llm/claude-cli.ts`, `codex-cli.ts` | Starting point for agent adapters (the existing ones are single-shot LLM calls for analysis) |
| `src/core/github/*` (Octokit, token resolution) | PR creation, head SHA confirmation, CI status |
| `src/core/store/*` (SQLite + migrations) | New run tables go in the same DB and migration system |
| Head-SHA checks and re-review/interdiff (`review.ts`, `reanchor.ts`) | Showing what changed between review rounds; making sure my final review is of the current head |
| Diff grouping and risk ordering (`src/core/group`, `src/core/risk`) | The final human review stage, now with Codex findings attached to groups |
| Session token, Host/Origin checks (`src/server/security.ts`) | Same protections for the new endpoints |

### 4.2 Required refactor: from one-PR server to app shell

Today the server is started around one repo/PR (`startServer({ repo, initialPr })`), and
the CLI is the entry point for a specific review. The agentic workflow needs a long-lived
server that knows about many projects and runs:

- `block-party` with no args starts the **app shell**: projects, runs, inbox.
- The existing review flow becomes a route inside it (`/review/:owner/:repo/:pr`), opened
  from a run or directly as today.
- `block-party owner/repo#123` keeps working as a shortcut that opens the review route.
- The workflow engine runs inside the server process, so active runs keep going when the
  browser is closed. (Runs survive a **server** restart via reconciliation, see 5.6.)

---

## 5. Components

### 5.1 Workflow engine

A run is an explicit state machine persisted in SQLite. The engine is the only thing that
writes run state.

```
draft ─▶ planning ─▶ awaiting_plan_approval ─▶ implementing ─▶ checking ─▶ publishing
                         ▲          │                 ▲              │
                         └─ revise ─┘                 │              ▼
                                                   fixing ◀───── reviewing
                                                      │              │
                                                      └──(cap)──▶ awaiting_human_review ─▶ complete
```

Any active state can also go to `blocked` (needs me), `failed`, `cancelled`, or
`interrupted` (process died / server restarted). `blocked` and `interrupted` can resume
into the state they left.

Design rules:

- **Stages are rows.** Each stage execution (including each review round) is its own row
  with immutable inputs (plan version, base SHA, head SHA, model config) and recorded
  outputs. Re-running a stage creates a new row; it never edits an old one.
- **Events are append-only** (`run_events`); the current state is a separate column kept in
  sync in the same transaction.
- **Transitions are pure functions** of (current state, event, policy) → (next state,
  side effects). That makes the engine unit-testable without spawning anything, using
  the same fake-spawn approach as the existing LLM tests.
- **Side effects are idempotent where possible** (e.g. "ensure PR exists for branch" rather
  than "create PR"), so a crash mid-transition can be retried.

### 5.2 Agent runner

```ts
interface AgentAdapter {
  /** Launch a session for one stage. Returns once the process is running. */
  start(input: AgentStartInput): Promise<AgentSession>;
  /** Send a conversational message (a new turn). Never used for lifecycle control. */
  send(session: AgentSession, message: string): Promise<void>;
  /** Lifecycle: interrupt the current turn, or end the session. Separate from send(). */
  interrupt(session: AgentSession): Promise<void>;
  stop(session: AgentSession, opts?: { force?: boolean }): Promise<void>;
  /** Resume a previous session (new process, same conversation). */
  resume(session: AgentSession, message: string): Promise<AgentSession>;
  status(session: AgentSession): Promise<AgentStatus>; // running | idle | waiting_permission | exited
}

interface AgentStartInput {
  runId: string;
  stage: StageKind;
  role: 'planner' | 'implementer' | 'reviewer';
  cwd: string;              // the run's worktree
  prompt: string;           // usually "read the brief at <path> and follow it"
  model: string;            // from role config, never hardcoded
  subagents?: SubagentDef[];
  permissions: PermissionProfile;
}
```

Messages vs lifecycle are deliberately separate methods (a Firstmate lesson): "stop" is
never typed into the agent's conversation.

#### Claude adapter, interactive mode (primary, for planner and implementer)

I want to be able to drop into a live Claude session and steer it, so the implementer runs
as a **real interactive Claude Code session inside tmux**, not a headless pipe:

- **Launch:** `tmux new-session -d -s bp-<runId>-<stage> -c <worktree>` running
  `claude --model <opus> --session-id <uuid> --settings <run settings> --agents <agents.json> "<prompt>"`.
  The session ID is chosen by block-party so it can resume or locate the transcript later.
- **Attach:** the UI shows `tmux attach -t bp-…` with a copy button (and later, possibly an
  embedded terminal via `xterm.js` + `node-pty`). Attaching doesn't disturb the run.
- **Structured events come from Claude Code hooks**, not from scraping the terminal. The
  per-run settings file registers hooks (`SessionStart`, `PostToolUse`, `SubagentStop`,
  `Notification`, `Stop`, `SessionEnd`) that call a tiny `block-party hook` command. It
  appends one JSON line to `~/.block-party/runs/<runId>/events.jsonl`. The server tails
  that file. Writing to a file instead of POSTing means events aren't lost while the server
  is restarting.
- **Rich activity feed:** the session transcript JSONL that Claude Code writes is tailed and
  condensed for the UI (tool calls, subagent dispatches, file edits), without showing every
  token.
- **Completion detection:** the `Stop` hook fires whenever Claude ends a turn, which does
  not mean the stage is done. On `Stop`, block-party checks for `report.json`:
  - report present → validate it, then verify against git (section 3.2) → advance or
    escalate.
  - no report → the agent is idle mid-task (asked a question, gave up, or misunderstood).
    Becomes an inbox item: "Implementer stopped without reporting", with an attach button.
- **Permission prompts:** the `Notification` hook reports when Claude is waiting for
  permission. That becomes an inbox item immediately, since an unattended run otherwise
  stalls silently. To make prompts rare, each role gets a permission profile (edit
  freely in the worktree; allowlisted commands for checks, git, package manager; no
  network-affecting or out-of-tree writes).
- **Sending a message** (e.g. fix-round findings): if the session is idle, type into it via
  `tmux send-keys` with a short brief pointer ("Read findings at <path> and fix them per the
  brief."), not pasting long text. If the process has exited, `claude --resume <sessionId>`
  in a new tmux session with the message. Long content always goes in files; messages only
  point at files.

**Risk:** this mode is more fragile than headless (send-keys timing, detecting idle vs busy,
TUI changes in new Claude Code versions). Phase 0 spikes it. If it proves unreliable, the
fallback is below, and "attach" becomes "stop the headless run and resume it interactively
in tmux", which still gives me a live session when I need one.

#### Claude adapter, headless mode (fallback, and for non-interactive roles)

`claude -p --model <m> --session-id <uuid> --output-format stream-json --verbose --agents …`
spawned through `spawn-cli`. Events come from the JSON stream; completion is process exit
plus `report.json`. Resume via `claude -p --resume <id> "<message>"`. Same `AgentAdapter`
interface, so the engine doesn't care which mode is used.

#### Opus driver with Sonnet subagents

block-party supervises the Opus process; Opus supervises its Sonnet children. block-party
doesn't micromanage subagents in Phase 1–3.

- Subagents are defined in a generated `agents.json` passed via `--agents` (or written to
  the worktree's `.claude/agents/` if that proves more reliable), with model `sonnet`, a
  focused prompt, and restricted tools. Roles to start with: a general `implementer`, a
  `test-writer`, and a read-only `explorer`.
- Model choices come from config (`roles.implementer.model`, `roles.subagents.*.model`), so
  switching models is a config change.
- Subagents share one worktree, so the brief requires Opus to assign disjoint file/module
  ownership when it parallelizes. Separate worktrees per subagent are a Phase 4+ idea, only
  if collisions show up in practice.
- `SubagentStop` hook events give the UI a "3 subtasks, 2 done" view without parsing
  conversation text.

#### Codex adapter (reviewer)

Always headless. No need to attach to a reviewer.

- Runs in the run's worktree at the exact `head_sha`, read-only sandbox.
- Two candidate interfaces, decided by a Phase 0 spike:
  1. `codex review --base <base_sha>`: the purpose-built review command, but its output is
     prose, so findings would need a normalization step (an LLM extraction call, which adds
     a failure mode).
  2. `codex exec --json --output-schema findings.schema.json -s read-only "<review prompt>"`:
     I control the prompt (plan, acceptance criteria, prior findings) and get structured
     output directly.

  Leaning toward (2) because structured findings and plan-aware review matter more than the
  canned review prompt. Its prompt should borrow the adversarial framing I use today.
- Output is validated with zod. Invalid output → one retry with the validation error →
  then the stage fails and escalates. No silently empty findings lists.

### 5.3 Git service

Uses native `git worktree`. No pooled worktree manager.

Each run needs a local clone of the project (the `projects` table stores its path, normally
my existing checkout). Worktrees live outside it, under
`~/.block-party/worktrees/<owner>__<repo>/<runId>/`.

On run start:

1. `git fetch origin <base>` and record `base_sha`.
2. `git worktree add -b bp/<slug>-<shortId> <path> <base_sha>`.
3. Record path, branch, and base SHA on the run.
4. Run the project's setup command (e.g. `pnpm install`), since worktrees don't share
   `node_modules`.

Lifecycle rules:

- **Never delete a worktree because a process exited.** Failed and interrupted runs keep
  their worktrees until I discard the run.
- Cleanup happens only after the branch is pushed **and** its remote head equals local
  HEAD **and** the worktree is clean, or when I explicitly discard (with a warning if it has
  unpushed or uncommitted work).
- After every agent stage, block-party records `head_sha`, checks for uncommitted changes
  (a contract violation: escalate, don't auto-commit), and computes the diff stats.
- A worktree is **not** a security sandbox. It isolates the checkout, not the machine. See
  section 9.

### 5.4 Check runner

Per-project commands in `.block-party.yaml` (which already holds risk rules):

```yaml
checks:
  setup: pnpm install --frozen-lockfile
  required:
    - { name: typecheck, run: pnpm typecheck }
    - { name: lint, run: pnpm lint }
    - { name: test, run: pnpm test }
  optional:
    - { name: build, run: pnpm build }
```

- Runs in the worktree against a recorded HEAD, with a timeout and captured output.
- Results are stored per stage: command, exit code, duration, log path, HEAD SHA.
- Failing required checks after implementation → send the failure log back to the
  implementer as a fix round (counts toward its own cap, `maxCheckFixRounds`, default 2).
- The implementer is told to run checks too, but block-party's run is the one that counts.

### 5.5 GitHub integration

Extends the existing client:

- Push the branch and create a **draft** PR once checks first pass (title and body from the
  plan and report; body links back to the run).
- Confirm `pr.head.sha == local HEAD` after every push before treating anything as
  published.
- Read CI status for the head SHA and show it as evidence (Phase 3+). Optionally wait for
  CI before moving to my review.
- Optionally post Codex findings to the PR as a review comment (off by default; findings
  live in block-party).
- Mark ready-for-review / merge only on my explicit action.

### 5.6 Events, streaming, and recovery

- **To the browser:** Server-Sent Events per run (`/api/runs/:id/events`) and a global
  stream for the run list and inbox. WebSockets only if interactive control needs it.
- **Reconciliation on server start:** for each run in an active state, check reality: is
  the tmux session alive, did the process exit, is there a `report.json`, what is git HEAD,
  replay any unprocessed lines in `events.jsonl`. Then either resume supervision, advance
  the state, or mark `interrupted` with an inbox item. This is the hard part of reliability
  and gets built incrementally (Phase 2 basic, Phase 4 thorough).
- **Stall detection:** a cheap timer (no LLM) flags sessions with no events for a
  configurable time as possibly stuck.

---

## 6. Data model

New tables in the existing SQLite DB (via the existing migration system). Large or
human-readable things go on disk under `~/.block-party/runs/<runId>/`, with paths and
content hashes in the DB.

| Table | Key columns |
|---|---|
| `projects` | id, owner, repo, local_path, default_base, config_json |
| `runs` | id, project_id, title, kind (`feature` / later `bugfix`, `scout`…), state, branch, worktree_path, base_sha, head_sha, pr_number, approved_plan_id, created_at, updated_at |
| `plans` | id, run_id, version, content_hash, path, status (`draft` / `approved` / `superseded`), created_by (`me` / `agent`) |
| `stages` | id, run_id, kind, attempt, round, state, input_json (plan_id, base/head SHA, model config), output_json, started_at, ended_at |
| `agent_sessions` | id, stage_id, adapter, mode (`tmux` / `headless`), cli_session_id, tmux_session, pid, model, status, transcript_path |
| `run_events` | id, run_id, stage_id, ts, type, payload_json (append-only) |
| `artifacts` | id, run_id, stage_id, kind (`brief` / `report` / `check_log` / `review_raw`…), path, content_hash |
| `check_results` | id, stage_id, name, command, head_sha, exit_code, duration_ms, log_artifact_id |
| `review_findings` | id, run_id, stage_id, reviewed_sha, severity, category, title, body, path, start_line, end_line, confidence, status (`open` / `fixed` / `disputed` / `deferred` / `wont_fix`), resolution_note |
| `decisions` | id, run_id, kind (`plan_approval` / `blocked` / `permission` / `finding_triage` / `final_review`…), prompt_json, status, answer_json, created_at, answered_at |

`decisions` is the decision inbox: every time the engine needs me, it writes a row, and the
run waits on it.

---

## 7. Configuration

Global (`~/.config/block-party/config.yaml`), overridable per project (`.block-party.yaml`):

```yaml
roles:
  planner:     { agent: claude, model: opus, mode: tmux }
  implementer: { agent: claude, model: opus, mode: tmux }
  subagents:
    implementer: { model: sonnet }
    test-writer: { model: sonnet }
    explorer:    { model: sonnet, readOnly: true }
  reviewer:    { agent: codex, model: <default>, mode: headless }

policy:
  maxReviewRounds: 3
  maxCheckFixRounds: 2
  autoFix: [P0, P1]        # P2 → inbox by default
  publishAs: draft
  waitForCi: false

worktrees:
  root: ~/.block-party/worktrees
```

---

## 8. Product and UI

Not a wall of agent chats. Three primary views, plus an inbox:

- **Projects / home:** active runs, their stage, what needs me, recently completed work.
- **Decision inbox:** the only place that should demand attention. Plan approvals,
  blocked agents and their questions, permission prompts, P2 triage, disputed findings,
  cap-reached escalations, final reviews. Each item links to the context needed to decide.
- **Run view:**
  - Stage strip: Plan → Build → Checks → Codex → Fix → Review, with round counts.
  - The approved plan, always visible, with acceptance criteria and their status.
  - Condensed activity feed (tool calls, subagent tasks, files changed), plus "Attach" (tmux
    command or embedded terminal) and "Send message" / "Stop" as separate controls.
  - Evidence panel: which checks ran on which SHA, which review rounds ran on which SHA,
    and what is still unverified.
- **Review (existing UI, extended):** the current diff grouped and risk-ordered as today,
  plus Codex findings shown on the groups and lines they touch, resolution history per
  finding, check results, and the plan's acceptance criteria. From any finding or my own
  comment: **"Send to implementer"** starts a fix round without copying anything.

Later: a run template picker (Feature, Bug fix, Refactor, Investigation, Security audit,
Test coverage), each a different stage list on the same engine.

---

## 9. Security and safety

- **Localhost only**, with the existing session token and Host/Origin checks on all new
  endpoints (including SSE).
- **Agents are trusted code running as me.** Worktrees isolate checkouts, not the machine.
  Mitigations, in order of adoption: per-role permission profiles (allowlisted commands,
  no writes outside the worktree), Codex read-only sandbox for review, never passing
  `GITHUB_TOKEN` or other secrets into agent environments unless a stage needs them
  (block-party does the pushing and PR creation itself), and later containerized or
  sandboxed execution for fully unattended runs.
- **Hook command input is untrusted:** `block-party hook` validates payloads, writes only to
  that run's directory, and never executes anything from them.
- **Agent output is data, not instructions** for the engine. Reports and findings are
  validated against schemas; free text in them is displayed, never executed.
- **No destructive git operations** by block-party without my confirmation: no force
  pushes, no branch deletion of unpublished work, no worktree removal with uncommitted
  changes.
- The existing secrets checklist in `PLAN.md` section 13 still applies to the run directory.

---

## 10. Roadmap

Each phase ends with something I actually use. Estimates are rough full-time-equivalent
guesses for AI-assisted development.

### Phase 0: Design and spikes (1–3 days)

Verify the risky integration assumptions before building on them.

- [x] This doc.
- [ ] Spike: interactive Claude in tmux with `--session-id`, per-run `--settings` hooks
      writing to `events.jsonl`, `--agents` Sonnet subagents. Confirm: hook payloads for
      `Stop`/`SubagentStop`/`Notification`, idle detection, `send-keys` reliability, resume.
- [ ] Spike: headless `claude -p --output-format stream-json` with the same agents file
      (the fallback), including what subagent activity shows up in the stream.
- [ ] Spike: `codex exec --output-schema` vs `codex review --base` on a real PR of mine.
      Compare finding quality and parse reliability. Record the decision in section 12.
- [ ] Draft the `plan.md` format (required sections, acceptance criteria) and the task brief
      template.

### Phase 1: One linear run from the CLI (≈1 week)

`block-party run --repo <path> --plan plan.md [--base main]` does the whole chain once,
with no UI beyond the terminal, logs, and artifacts.

- [ ] Git service: worktree + branch creation, SHA recording, setup command.
- [ ] Claude adapter (tmux mode, falling back to headless if the spike says so) with hooks
      and `report.json` completion.
- [ ] Check runner from `.block-party.yaml`.
- [ ] Push + draft PR + head SHA confirmation.
- [ ] Codex reviewer adapter with schema-validated findings.
- [ ] One automatic fix round for P0/P1 findings, then re-check and re-review.
- [ ] All artifacts saved under `~/.block-party/runs/<runId>/`.
- **Exit check:** I run it on a real plan for this repo and get a draft PR with Codex
  findings and their resolutions, without copying text between tools.

### Phase 2: Persistent runs and the app shell (1–2 weeks)

- [ ] Server refactor to the app shell (section 4.2); review becomes a route.
- [ ] Run tables + migrations; engine as a pure state machine with tests.
- [ ] SSE run stream; run list and run view (stage strip, activity feed, attach command).
- [ ] Decision inbox (blocked, permission prompts, stopped-without-report, cap reached).
- [ ] Basic reconciliation on server restart.
- [ ] Start a run from the UI (pick project, base, upload/paste a plan).
- **Exit check:** I start a run, close the browser and even restart the server, come back,
  and see exactly what happened and what needs me.

### Phase 3: Planning in-app and the integrated review loop (1–2 weeks)

- [ ] Planning stage: read-only Opus session, plan versions, comment/revise/approve in UI.
- [ ] Full bounded review/fix loop with triage policy, disputes, and stop conditions.
- [ ] Findings shown in the review UI on groups/lines; per-finding history across rounds.
- [ ] "Send to implementer" from findings and from my own review comments.
- [ ] Evidence panel; acceptance-criteria tracking.
- [ ] CI status for the head SHA.
- **Exit check:** I start from a feature description and finish with a reviewed PR, and the
  only things I did were approve a plan, answer inbox items, and do the final review.

### Phase 4: Reliability and parallel runs (several weeks)

- [ ] Thorough crash recovery and reconciliation; safe cancellation at any stage.
- [ ] Concurrency limits; multiple simultaneous runs across projects.
- [ ] Stronger permission profiles; optional sandboxed execution.
- [ ] Embedded terminal in the run view (`xterm.js` + `node-pty`).
- [ ] Stall detection and auto-nudges.
- **Exit check:** three independent runs proceed in parallel for an afternoon without
  corrupting each other or needing me except via the inbox.

### Phase 5: End-to-end verification

- [ ] A QA stage: an independent agent launches the app, exercises the changed behavior
      (browser automation for web projects), and produces evidence such as screenshots and
      assertion results tied to acceptance criteria.

### Later / maybe

- Run templates (bug fix, refactor, investigation/"scout" runs that produce a report, not a
  PR; security audit; test coverage).
- Auto-merge for low-risk runs once there's a track record.
- Dynamic model routing; additional reviewer models (second-opinion review).
- Stacked runs (a run based on another run's branch).
- Pooled worktrees, remote workers.
- Agent SDK adapter, if this is ever distributed (subscription auth can't be offered
  through SDK apps; it would need API keys).

---

## 11. Borrowed from Firstmate

| Firstmate idea | Decision |
|---|---|
| Single coordination point | **Borrow**, as the workflow engine + one UI, not an LLM coordinator |
| Worktree per task | **Borrow** (native `git worktree`, Phase 1) |
| Persistent task briefs | **Borrow** (section 3.2) |
| Durable state outside conversations | **Borrow** (SQLite + run dirs) |
| Event-driven supervision, no LLM polling | **Borrow, simplified** (hooks → JSONL → server) |
| Messages separate from lifecycle control | **Borrow** (`send` vs `interrupt`/`stop`) |
| tmux-hosted agent sessions | **Borrow** (attachable implementer sessions) |
| Ship vs scout tasks | **Borrow conceptually**; scout runs are a later template |
| Configurable model routing | **Borrow** for planner/implementer/subagents/reviewer roles |
| Append-only fleet ledger | **Study** its event vocabulary when designing `run_events` |
| No Mistakes validation pipeline | **Study**, don't duplicate; checks + Codex review cover it for now |
| Avoiding an extra review loop in delivery | **Reject**: cross-model review is central here |
| Secondmates, remote workers, multiple terminal backends, quota dispatch, chat relays | **Defer / skip** |
| Depending on Firstmate's scripts directly | **Skip**: a smaller TypeScript implementation fits better |

---

## 12. Decision log

Newest first. Each entry: date, decision, why, and what would make us revisit it.

- **2026-11-05: Personal, local-only; use installed `claude` and `codex` CLIs with my
  subscriptions.** Agent SDK can't use subscription auth in third-party apps without
  approval, and I don't need distribution. Adapters keep the SDK swappable. *Revisit if* I
  want to share block-party with others.
- **2026-11-05: Implementer runs as an attachable interactive Claude session in tmux;
  structured state comes from hooks, not terminal scraping.** I want to drop into and steer
  live sessions. Headless stream-json stays as the fallback behind the same interface.
  *Revisit after* the Phase 0 spike if tmux mode is unreliable.
- **2026-11-05: Hands-off autonomy between plan approval and my review.** Auto-fix P0/P1,
  inbox for P2 and judgment calls, `maxReviewRounds = 3`. No auto-merge.
- **2026-11-05: Planning is import-first (Phase 1), in-app later (Phase 3).** Proves the
  hard execution path before building planning UI.
- **2026-11-05: Deterministic workflow engine, not an LLM coordinator.** Easier to debug,
  test, and trust for a fixed workflow. Agents own the creative work inside stages.
- **2026-11-05: Opus manages its own Sonnet subagents; block-party supervises only the
  Opus process.** *Revisit if* subagent file collisions become a real problem.
- **2026-11-05: Codex review is a separate stage with its own process and SHA-pinned
  results**, never a tool the implementer calls on itself.

---

## 13. Risks and open questions

**Risks**

| Risk | Mitigation |
|---|---|
| tmux/send-keys interaction breaks with Claude Code TUI changes | Hooks for state; files for content; headless fallback |
| Unattended run stalls on a permission prompt | `Notification` hook → inbox; permission profiles that make prompts rare |
| Agent says "done" without doing it | `report.json` is a claim; engine verifies commits, cleanliness, checks, diff |
| Review/fix churn or regressions | Round caps, repeated-finding detection, diff-size sanity check, escalation |
| Lost work on crash or cleanup | Never auto-delete worktrees; reconciliation on restart |
| Subagents collide in one worktree | Ownership rules in brief; revisit with per-subagent worktrees if needed |
| Building infrastructure before validating the workflow | Phase 1 is a CLI-only end-to-end run on a real plan |

**Open questions**

- `codex review` vs `codex exec` with an output schema (Phase 0 spike).
- `--agents` JSON vs generated `.claude/agents/*.md` in the worktree: which is more
  reliable, and should it pollute the worktree?
- Where should `report.json` live: in the worktree (needs a `.gitignore` entry or
  `.git/info/exclude`) or in the run dir (needs an absolute path in the brief)? Leaning
  toward the run dir.
- Should the draft PR open before the first Codex review, or only after the review loop is
  clean? Current plan: after the first passing checks, so CI runs in parallel with review.
- Plan format: how strict? Required sections (Goal, Approach, Acceptance criteria,
  Out of scope) at minimum.
- Does block-party develop itself? Dogfooding from Phase 1 onward is the best test, but a
  run that modifies block-party while block-party is supervising it needs care (separate
  worktree, rebuild-then-restart).
