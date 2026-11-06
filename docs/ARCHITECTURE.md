# block-party: Architecture and Roadmap

A living design doc for turning block-party from a PR review dashboard into an **agentic
software delivery workspace**: one local app that takes a feature from an approved plan
through implementation, verification, adversarial review, fixes, and finally my own review,
with as few manual handoffs as possible.

This doc is updated as the system is built. Each phase in the [roadmap](#10-roadmap) has
checkboxes, and every non-obvious choice goes in the [decision log](#12-decision-log). When
the code and this doc disagree, fix whichever one is wrong in the same PR.

- **Status:** Phase 0 complete (spike write-ups in [`docs/spikes/`](spikes/)); Phase 1 next.
  Review UI (M0–M3 of `PLAN.md`) is shipped.
- **Owner:** Drew Blocki
- **Last updated:** 2026-11-06
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
 ┌─────────┐  ┌─────────┐  ┌─────────────┐  ┌─────────┐  ┌───────┐  ┌───────────┐  ┌──────────┐  ┌───────────┐
 │ 1. Plan │─▶│ 2. Impl │─▶│ 3. Local CI │─▶│ 4. Codex│─▶│ 6. Fix│  │ 7. Verify │─▶│ 8. Publish│─▶│ 9. My     │
 │ Opus,   │  │ Opus +  │  │ same checks │  │ review  │  │ Opus  │  │ QA agent, │  │ push +    │  │ review    │
 │ r/o     │  │ Sonnet  │  │ as GH CI    │  │ @ SHA   │  │resumes│  │ E2E       │  │ draft PR  │  │           │
 └────┬────┘  └─────────┘  └─────────────┘  └────┬────┘  └───┬───┘  └─────┬─────┘  └──────────┘  └───────────┘
      │                           ▲              │ clean      │            ▲  │
  I approve                       └──────────────┼────────────┘            │  │ failed criteria
                                                 └─────────────────────────┘  └──▶ become findings → 6
```

Nothing is pushed to GitHub until the run has passed local CI, the review loop, and
verification. That keeps Codex from reviewing code that wouldn't build, and keeps GitHub
Actions minutes for a branch that is already expected to pass. (Stage 5 is the triage step
inside the loop, see 3.3.)

| # | Stage | Input | Output (artifact) | Done when (verified by block-party) | Human? |
|---|---|---|---|---|---|
| 1 | Plan | Task description, repo, references | `plan.md` (versioned) | I approve a specific plan version | Yes, always |
| 2 | Implement | Approved plan, task brief | Commits on the run branch, `report.json` | Agent signals done **and** branch has new commits **and** worktree is clean | Only if blocked |
| 3 | Local CI | Worktree, CI-parity commands (5.4) | Check results with logs and exit codes | Every required check exits 0 on the current HEAD | Only on repeated failure |
| 4 | Review | Diff `base_sha..head_sha`, plan | Structured findings pinned to `head_sha` | Reviewer process exits 0 and output validates against the schema | No |
| 5 | Triage | Findings + policy | Findings split into auto-fix / inbox / record | Policy applied; inbox items answered if any are blocking | Judgment calls only |
| 6 | Fix | Actionable findings (from review or verify) | New commits, per-finding resolution | Fix commits exist; then back to 3 | Judgment calls only |
| 7 | Verify | Clean head, acceptance criteria, verify profile (5.7) | Per-criterion pass / fail / unverified, with evidence | Every criterion has a result; no `fail` | Only if environment can't start |
| 8 | Publish | Branch, base | PR number, head SHA, GitHub CI result | GitHub confirms the PR, its head SHA matches local HEAD, and CI is green | Only if CI disagrees with local CI |
| 9 | Human review | Current PR + all evidence | My decision | I approve, or send it back with instructions | Yes, always |

**Autonomy policy (default):** hands-off between plan approval and my review. The run
implements, checks, reviews, auto-fixes blocking findings for up to `maxReviewRounds`
(default 3), verifies, and publishes, and only interrupts me for blockers and judgment
calls via the [decision inbox](#8-product-and-ui).

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
- After a fix round, local CI runs again, then Codex reviews the **new** head. Old findings
  remain in history but say nothing about the new head. Codex never runs on a head that
  failed local CI.
- Failed verify criteria (5.7) re-enter this same loop as findings with category `e2e`, so
  an E2E fix also gets local CI and a Codex review before it's verified again.
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
│  inbox · review             │              ├──▶ Agent runner ──▶ adapters: claude (pane | headless), │
│                             │              │                              codex (headless)           │
│                             │              ├──▶ Git service (worktrees, branches, SHAs)              │
│                             │              ├──▶ Local CI runner (CI-parity commands, logs)           │
│                             │              ├──▶ Verify runner (environments + MCP drivers, QA agent) │
│                             │              └──▶ GitHub client (PRs, CI status) — existing            │
│                             │                                                                        │
│                             └──▶ Review subsystem (diff grouping, risk, comments) — existing         │
│                                                                                                      │
│  SQLite ~/.block-party/block-party.db: projects, runs, stages, sessions, events, artifacts, findings │
│  Files  ~/.block-party/runs/<runId>/:  plans, briefs, reports, event logs, check logs, review output  │
│  Worktrees ~/.block-party/worktrees/<owner>__<repo>/<runId>/                                          │
└──────────────────────────────────────────────────────────────────────────────────────────────────────┘
          │ terminal host: herdr (default) or tmux, one labeled pane per agent session; I can attach to any
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
draft ─▶ planning ─▶ awaiting_plan_approval ─▶ implementing ─▶ checking ─▶ reviewing
                         ▲          │                              ▲           │ clean
                         └─ revise ─┘                              │           ▼
                                                                fixing ◀── verifying
                                                    (blocking findings │           │ all criteria pass
                                                     or failed criteria)           ▼
                                      complete ◀── awaiting_human_review ◀── publishing
```

`reviewing` with blocking findings also goes to `fixing`. Hitting any loop cap goes to
`blocked` with an inbox item, not straight to my review.

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
as a **real interactive Claude Code session inside a terminal multiplexer** (herdr or tmux,
see [5.2.1](#521-terminal-host-herdr-or-tmux)), not a headless pipe:

- **Launch:** the terminal host opens a pane in the worktree and runs
  `claude --model <opus> --session-id <uuid> --settings <run settings> --agents <agents.json> "<prompt>"`.
  The session ID is chosen by block-party so it can resume or locate the transcript later.
- **Attach:** the UI shows the host's attach command with a copy button (and later, possibly
  an embedded terminal via `xterm.js` + `node-pty`). Attaching doesn't disturb the run.
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
  not mean the stage is done. The spike showed a first `Stop` while a background subagent
  was still running (`background_tasks` non-empty), followed by a second turn. So a `Stop`
  only counts when its `background_tasks` is empty. Then block-party checks for
  `report.json`:
  - report present → validate it, then verify against git (section 3.2) → advance or
    escalate.
  - no report → the agent is idle mid-task (asked a question, gave up, or misunderstood).
    Becomes an inbox item: "Implementer stopped without reporting", with an attach button.
- **Permission prompts:** the `Notification` hook reports when Claude is waiting for
  permission. That becomes an inbox item immediately, since an unattended run otherwise
  stalls silently. To make prompts rare, each role gets a permission profile (edit
  freely in the worktree; allowlisted commands for checks, git, package manager; no
  network-affecting or out-of-tree writes). Always pass `--permission-mode` explicitly: my
  global default is `auto`, which silently changes what prompts. herdr reports `blocked`
  about 2s after a permission prompt appears, several seconds before the `Notification`
  hook, so it raises the inbox item first.
- **Folder trust:** the first launch in an untrusted directory shows Claude Code's trust
  dialog (default answer: exit), which blocks every hook. Trust is inherited by
  subdirectories, so block-party trusts the worktree root
  (`~/.block-party/worktrees`) once during setup instead of answering dialogs per run.
- **Launching:** use herdr `layout.apply` with an argv (`{command: [...]}`) so `claude` is
  exec'd directly in the pane. Typing a command into a fresh shell pane raced zsh startup
  in the spike and arrived as literal bracketed-paste text.
- **Sending a message** (e.g. fix-round findings): once the session is idle, type a short
  pointer into it through the terminal host ("Read findings at <path> and fix them per the
  brief."), never long pasted text. Measured: `pane.send_input` (text plus Enter) after
  herdr reports `idle` was submitted reliably in ~0.2s; input sent while Claude is working
  is queued. If the process has exited, `claude --resume <sessionId>`
  in a new pane with the message. Long content always goes in files; messages only point at
  files.

**Risk:** this mode is more fragile than headless (keystroke timing, detecting idle vs busy,
TUI changes in new Claude Code versions). Phase 0 spikes it. If it proves unreliable, the
fallback is below, and "attach" becomes "stop the headless run and resume it interactively
in a pane", which still gives me a live session when I need one.

#### 5.2.1 Terminal host: herdr or tmux

The engine talks to the multiplexer through a small interface, so herdr and tmux are
interchangeable adapters:

```ts
interface TerminalHost {
  open(opts: { label: string; cwd: string; command: string }): Promise<PaneRef>;
  sendText(pane: PaneRef, text: string, opts?: { submit?: boolean }): Promise<void>;
  read(pane: PaneRef, lines?: number): Promise<string>;   // diagnostics only, never state
  agentState?(pane: PaneRef): Promise<'idle' | 'working' | 'blocked' | 'unknown'>;
  close(pane: PaneRef): Promise<void>;
  attachCommand(pane: PaneRef): string;
  list(): Promise<PaneRef[]>;                              // for reconciliation on restart
}
```

[herdr](https://github.com/herdrdev/herdr) (upstream: `herdrdev/herdr`; many forks and older
READMEs point elsewhere) is a Rust terminal multiplexer built for running coding agents.
Its control surface fits this interface closely: a local Unix socket with newline-delimited
JSON (`workspace.create` with `cwd`, `pane.split`, `pane.send_text`, `pane.send_keys`,
`pane.read`, `pane.close`, `pane.wait_for_output`), a matching CLI (`herdr pane run`,
`herdr wait agent-state`), and `events.subscribe`, which pushes events such as
`pane.agent_status_changed` (subscribed per `pane_id`), `pane.exited` and
`pane.output_matched`. Spike details: [`docs/spikes/herdr-claude.md`](spikes/herdr-claude.md).

| | herdr | tmux |
|---|---|---|
| Control from Node | Socket API with JSON request/response and a push event stream. Natural fit for the server. | Shell out to `tmux` commands and parse text output; no push events (would poll or use hooks). |
| Agent state | Built in: `idle` / `working` / `blocked` for Claude Code and Codex, pushed as events. A second signal that catches permission prompts and stalls even if a hook misfires. | None. We rely entirely on Claude Code hooks. |
| Waiting on output | `pane.wait_for_output` and `output_matched` events | Poll `capture-pane` |
| Agents driving it | Designed for this: an agent can open panes, run commands, and check other agents (useful later for a QA agent that starts servers). | Possible, but every agent has to learn tmux's CLI quirks. |
| My own use | I'm already using it, and its UI shows every run's agent state at a glance. | Familiar, but no agent awareness. |
| Remote | Reported to support a remote server with a local client (relevant for the Ableton machine later). Unconfirmed in its API docs. | Run tmux over ssh. |
| Maturity | Pre-1.0 (v0.9.5 as of 2026-10-14) but widely used (~47k stars, ~100 releases). Fast-moving; the socket API has no stability promise. | Decades old, extremely stable. |
| Identifiers | Pane and workspace IDs are stable and never reused while the server runs (verified), but **restart from `w1` when the server restarts**. | Named sessions (`bp-<runId>`) survive. |
| Persistence | Same model as tmux: a background session server owns the panes, so agents keep running when the TUI (or desktop app) detaches or its window closes. A **server** stop, reboot, or logout kills them; herdr then restores only the layout and screen history, not the processes. | Same: server keeps running detached; processes die with the server. |
| State detection method | Process name + screen heuristics, polled every few hundred ms. Can break when an agent's TUI changes. | N/A |
| License | Apache-2.0 | ISC |

**Decision: herdr is the default host, tmux is the fallback, and neither is the source of
truth.** Architecturally it fits well, since it is basically the tmux adapter with better
primitives. What it doesn't change: run state still comes from Claude Code hooks,
`report.json`, and git, because heuristic screen detection is not reliable enough to
advance a run. herdr's agent state is used as an extra signal: it can raise a `blocked`
inbox item sooner and help with stall detection.

Mitigations for the cons:

- **IDs across restarts:** label each workspace `bp-<runId>-<stage>`. Pane IDs may be
  cached for one server lifetime, keyed by the server's start time, but reconciliation
  always resolves panes by label (and realpath-resolved `cwd`) through `pane.list`.
- **API churn:** pin the herdr version, and keep all herdr calls inside the one adapter
  with contract tests against a recorded socket transcript.
- **Server lifetime:** the socket belongs to the background server, not the UI, so block-party
  can drive herdr with no window open (verified). The CLI does **not** auto-start a server
  (it returns `server_not_running`), so block-party runs `herdr --session <name> server`
  itself when `ping` fails, with any `HERDR_*` variables stripped from the environment
  (herdr refuses to start nested inside one of its own panes). Runs live in a dedicated
  named session, `block-party`, so they don't crowd my everyday workspaces; I watch them
  with `herdr --session block-party`. Its socket is
  `~/.config/herdr/sessions/block-party/herdr.sock`. A herdr server
  restart is treated like a reboot: every pane is gone, so reconciliation marks affected
  stages `interrupted` and resumes them with `claude --resume <sessionId>` in a new pane.
  Restored screen history is never mistaken for a live process.
- **Closing kills:** `pane.close` and closing a workspace end the processes inside
  (verified: SIGKILL, though `SessionEnd` still fires). A pane also disappears when its
  process exits, taking the last screen with it, so block-party captures `pane.read`
  output before closing and Phase 1 tries a wrapper that keeps the pane open after exit.
  Only the engine closes panes, and only after a stage has finished or been stopped on
  purpose. "Hide this run" in the UI never maps to close.
- **Hooks side by side:** herdr's official Claude Code integration installs its own hooks,
  and block-party adds per-run hooks via `--settings`. Verified: both fire, and herdr's
  sees the same session ID block-party chose. (v0.9.5 removed Codex turn hooks after
  timeout warnings, so hook behavior does change between versions.)

Resolved 2026-11-05/06 (herdr docs, then the Phase 0 spike on v0.9.5): agents survive
detach and closing the window; the socket works headless; the CLI doesn't auto-start the
server; closing a pane kills its process; upstream is `herdrdev/herdr`. Pinned: v0.9.5.

#### Claude adapter, headless mode (fallback, and for non-interactive roles)

Verified on Claude Code 2.1.319, see [`docs/spikes/claude-headless.md`](spikes/claude-headless.md).
Spawn with stdin ignored and put `--` before the prompt (variadic flags like
`--allowedTools` otherwise swallow it). `--resume` must repeat the model and permission
flags. A run killed by a signal leaves no `result` event, which is how block-party tells
"interrupted" apart from "finished". Hooks from `--settings` fire in `-p` mode too, and
denied tools show up as `permission_denied` events instead of hanging.

`claude -p --model <m> --session-id <uuid> --output-format stream-json --verbose --agents …`
spawned through `spawn-cli`. Events come from the JSON stream; completion is process exit
plus `report.json`. Resume via `claude -p --resume <id> "<message>"`. Same `AgentAdapter`
interface, so the engine doesn't care which mode is used.

#### Opus driver with Sonnet subagents

block-party supervises the Opus process; Opus supervises its Sonnet children. block-party
doesn't micromanage subagents in Phase 1–3.

- Subagents are defined in a generated `agents.json` in the run directory, passed as
  `--agents <path>` (verified: a file path works, and unlike `.claude/agents/` it doesn't
  leave files in the worktree), with model `sonnet`, a
  focused prompt, and restricted tools. Roles to start with: a general `implementer`, a
  `test-writer`, and a read-only `explorer`.
- Model choices come from config (`roles.implementer.model`, `roles.subagents.*.model`), so
  switching models is a config change.
- Subagents share one worktree, so the brief requires Opus to assign disjoint file/module
  ownership when it parallelizes. Separate worktrees per subagent are a Phase 4+ idea, only
  if collisions show up in practice.
- `SubagentStop` hook events (with `agent_id`, `agent_type`) give the UI a "3 subtasks, 2
  done" view without parsing conversation text. Filter out events with an empty
  `agent_type`; Claude Code's internal agents emit those too.

#### Codex adapter (reviewer)

Always headless. No need to attach to a reviewer.

- Runs in the run's worktree at the exact `head_sha`, read-only sandbox.
- **Decided (Phase 0, [`docs/spikes/codex-review.md`](spikes/codex-review.md)):**
  `codex exec --json --output-schema findings.schema.json -s read-only --ignore-user-config -`
  with the review prompt on stdin (and stdin closed; an open stdin hangs). It's the only
  option that accepts the plan and prior rulings: `codex review --base` rejects a custom
  prompt. It returns schema-valid JSON every time with real usage numbers, in 16–19s on a
  typical change. `codex review` gives prose that only a regex can partly parse.
- The schema must list every property in `required` (nullable instead of optional), or the
  turn fails with `invalid_json_schema`. A run without `turn.completed` is a failure.
- `--ignore-user-config` doesn't stop Codex from reading user skills, so the reviewer gets a
  dedicated `CODEX_HOME` in Phase 1.
- **Quality is not yet proven.** On two real past commits, the `exec` reviewer found
  nothing, while bare `codex review` found one plausible P2. Both caught planted bugs.
  Before an empty findings list is trusted, Phase 1 runs a small eval on past PRs with
  known issues and tunes the prompt.
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

### 5.4 Local CI (check runner)

The goal is **CI parity**: run locally what GitHub Actions would run on the PR, so that
Codex only reviews code that builds and passes tests, and the branch is pushed only once
it is expected to go green. GitHub CI then confirms the result instead of finding failures.

Per-project commands in `.block-party.yaml` (which already holds risk rules):

```yaml
checks:
  setup: pnpm install --frozen-lockfile
  required:
    - { name: typecheck, run: pnpm typecheck, ci: "ci.yml#typecheck" }
    - { name: lint,      run: pnpm lint,      ci: "ci.yml#lint" }
    - { name: test,      run: pnpm test,      ci: "ci.yml#test" }
    - { name: build,     run: pnpm build,     ci: "ci.yml#build" }
  ciParity:
    workflows: [.github/workflows/ci.yml]   # what "parity" is measured against
    ignore: [deploy-preview]                # CI jobs that can't or shouldn't run locally
```

- **Deriving the list.** `block-party checks init` reads `.github/workflows/*.yml`, finds
  the jobs that run on `pull_request`, and proposes a `checks` entry for each `run:` step
  (it skips setup actions such as `actions/checkout` and `setup-node`). I review and commit
  the result. LLM help is optional; the parser handles the common case.
- **Detecting drift.** On every run, block-party re-reads the workflows. If CI has a step
  that no local check maps to and that isn't in `ignore`, the run gets a warning in the
  evidence panel ("CI step `e2e` has no local equivalent"). That way a passing local CI
  can't quietly mean less than it used to.
- **Running `act`** (GitHub Actions in Docker) is an optional mode for repos whose CI is hard
  to reproduce by hand. It isn't the default: it's slower, needs Docker, and differs
  from real runners in subtle ways.
- Checks run in the worktree against a recorded HEAD, with a timeout and captured output.
  Results are stored per stage: command, exit code, duration, log path, HEAD SHA.
- Failing required checks → the failure log goes back to the implementer as a fix round
  (its own cap, `maxCheckFixRounds`, default 2). Codex is not started until local CI is
  green.
- The implementer is told to run checks too, but block-party's run is the one that counts.
- **If GitHub CI fails after local CI passed**, that's a parity gap. The run goes back to
  `fixing` with the CI log, and the inbox records the gap so I can add the missing check.

### 5.5 GitHub integration

Extends the existing client:

- Push the branch and create a **draft** PR only at the Publish stage, after local CI, the
  review loop, and verification have passed (title and body from the plan, report, and
  verify results; body links back to the run). One push per run in the normal case keeps
  Actions minutes down.
- Confirm `pr.head.sha == local HEAD` after every push before treating anything as
  published.
- Wait for GitHub CI on the head SHA and record it as evidence. Green → my review. Red →
  parity gap (5.4).
- Optionally post Codex findings to the PR as a review comment (off by default; findings
  live in block-party).
- Mark ready-for-review / merge only on my explicit action.

### 5.6 Events, streaming, and recovery

- **To the browser:** Server-Sent Events per run (`/api/runs/:id/events`) and a global
  stream for the run list and inbox. WebSockets only if interactive control needs it.
- **Reconciliation on server start:** for each run in an active state, check reality: is
  the agent's pane alive, did the process exit, is there a `report.json`, what is git HEAD,
  replay any unprocessed lines in `events.jsonl`. Then either resume supervision, advance
  the state, or mark `interrupted` with an inbox item. This is the hard part of reliability
  and gets built incrementally (Phase 2 basic, Phase 4 thorough).
- **Stall detection:** a cheap timer (no LLM) flags sessions with no events for a
  configurable time as possibly stuck. With herdr, `pane.agent_state_changed` adds a second,
  faster signal.

### 5.7 Verify stage (agentic end-to-end testing)

Unit tests and review answer "is the code reasonable?". Verify answers "does the change
actually work when you use it?". It runs after the review loop is clean and before
publishing, and for now it's the last automated stage.

The hard requirement is that it works for **any kind of project**: a web app, an MCP server,
a database migration, a CLI, or a desktop app like Ableton running on another machine. So
the stage is generic, and everything project-specific lives in a **verify profile**.

**How it works:**

1. **Bring up the environment** from the profile: start commands, a readiness probe, seed
   data, on the local worktree or a remote host.
2. **Start an independent QA agent** (not the implementer, so it doesn't share its
   assumptions). It receives the acceptance criteria, a summary of the diff, and a set of
   **drivers**: tools for exercising the thing under test.
3. The agent writes a short test plan per criterion, executes it through the drivers, and
   records evidence.
4. **Tear down** the environment (always, even on failure) and collect artifacts.

**Drivers are MCP servers.** That's the generalization that makes "any project type"
tractable: block-party starts the environment and hands the QA agent an MCP config. The QA
agent doesn't need to know what kind of project it is; it just has different tools.

| Project type | Environment | Drivers the QA agent gets |
|---|---|---|
| Web app | `pnpm dev` + wait for port | Browser (Playwright MCP): navigate, click, fill, screenshot, read console and network |
| MCP server | Build, then launch the server under test | An MCP client driver pointed at the built server: list tools, call them with real and edge-case inputs, check schemas and errors |
| API / CLI | Start service, or nothing | Shell and HTTP within the worktree; recorded requests and responses |
| Database change | **Ephemeral** database: a local Docker Postgres, or a branch of a hosted DB such as a Neon branch, created per run and deleted after | SQL driver: run migrations up **and** down, seed, run queries, compare schema to expectation |
| Desktop app (e.g. Ableton on a remote machine) | Remote host from an allowlist; app already running | 1st choice: the app's structured control (e.g. an Ableton MCP or OSC remote script) to set up state and query results. 2nd: a **computer-use driver** for checks that only make sense visually |

**Prefer structured drivers to pixels.** A computer-use driver (screenshots plus mouse and
keyboard, driven by a computer-use model such as OpenAI's or Claude's) can test anything
with a screen, but it is slow, expensive, and less deterministic. The profile lists drivers
in preference order, and the QA agent is told to use computer use only for what the
structured drivers can't observe. For Ableton that might be: create a track and load a
device through the MCP, then use computer use only to confirm the new UI element renders.

The computer-use driver is itself wrapped as an MCP tool, for example
`ui_task(goal, host) → { outcome, screenshots[], actions[] }`. That way the model behind it
(OpenAI or Claude computer use) is a driver config choice, and the QA agent stays the same.
It runs against a dedicated machine or VM reached over VNC or a small agent process on that
host, never my everyday desktop session.

**Verify profile** (in `.block-party.yaml`; a project can have several, chosen by which
paths the diff touches):

```yaml
verify:
  profiles:
    - name: web
      when: ["src/web/**"]
      environment:
        start: pnpm build && pnpm start --no-open --port 0
        ready: { log: "listening on" , timeoutMs: 60000 }
      drivers: [browser]
    - name: ableton
      when: ["remote-script/**"]
      environment:
        host: studio-mac            # from an allowlist in global config
        ready: { mcp: ableton, call: query_connection_status }
      drivers: [ableton-mcp, computer-use]
  maxVerifyRounds: 2
```

**Output: evidence per acceptance criterion.**

```jsonc
{
  "reviewedSha": "9d02…",
  "profile": "web",
  "criteria": [
    { "criterion": "Run list shows live stage", "result": "pass",
      "evidence": ["screens/run-list.png", "steps.md#3"] },
    { "criterion": "Inbox item appears on permission prompt", "result": "fail",
      "evidence": ["screens/inbox-empty.png", "console.log"], "note": "…" },
    { "criterion": "Works on Safari", "result": "unverified",
      "note": "no Safari driver configured" }
  ]
}
```

- `unverified` is an honest, allowed result. It shows up in my review as a gap, never as a
  pass.
- Each `fail` becomes a finding (`category: "e2e"`, P1 by default) and goes through the
  normal fix loop: fix → local CI → Codex review → verify again, capped by
  `maxVerifyRounds`.
- If the environment can't start, the stage reports `blocked` (an infrastructure problem),
  not `fail` (a code problem). The run waits in the inbox instead of making the
  implementer chase a broken setup.
- Results are pinned to a SHA like everything else.

**Safety rules specific to verify:** never point a profile at production; database drivers
refuse anything that isn't an ephemeral database created by the run; remote hosts come from
an allowlist in global config; credentials for drivers are injected only into the verify
stage; computer use runs only on dedicated machines.

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
| `agent_sessions` | id, stage_id, adapter, mode (`pane` / `headless`), terminal_host (`herdr` / `tmux`), pane_label, cli_session_id, pid, model, status, transcript_path |
| `verify_results` | id, stage_id, verified_sha, profile, criterion, result (`pass` / `fail` / `unverified`), evidence_artifact_ids, note |
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
  planner:     { agent: claude, model: opus, mode: pane }
  implementer: { agent: claude, model: opus, mode: pane }
  subagents:
    implementer: { model: sonnet }
    test-writer: { model: sonnet }
    explorer:    { model: sonnet, readOnly: true }
  reviewer:    { agent: codex, model: <default>, mode: headless }
  verifier:    { agent: claude, model: opus, mode: pane }   # QA agent; never the implementer's session

terminal:
  host: herdr              # or tmux; see 5.2.1

policy:
  maxReviewRounds: 3
  maxCheckFixRounds: 2
  maxVerifyRounds: 2
  autoFix: [P0, P1]        # P2 → inbox by default
  publishAs: draft         # pushed once, after local CI, review, and verify pass
  waitForCi: true

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
  - Stage strip: Plan → Build → Local CI → Codex → Fix → Verify → Publish → Review, with
    round counts.
  - The approved plan, always visible, with acceptance criteria and their status.
  - Condensed activity feed (tool calls, subagent tasks, files changed), plus "Attach" (herdr/tmux
    command or embedded terminal) and "Send message" / "Stop" as separate controls.
  - Evidence panel: which checks ran on which SHA (and CI steps with no local equivalent),
    which review rounds and verify results apply to which SHA,
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
- [x] Spike: interactive Claude in a herdr pane: hooks, subagents, agent state, follow-up
      messages, resume, close. [Findings](spikes/herdr-claude.md).
- [x] Spike: headless `claude -p --output-format stream-json` fallback and a permission
      profile for the implementer. [Findings](spikes/claude-headless.md).
- [x] Spike: `codex exec --output-schema` vs `codex review --base`. Decision: `exec`.
      [Findings](spikes/codex-review.md).
- [x] CI parity core (`src/core/checks`): parse workflows, propose checks, detect drift,
      with a `package.json` fallback for repos without CI (this one).
      [Notes](spikes/ci-parity.md).
- [x] Plan format, task brief template, and report schema in
      [`docs/templates/`](templates/).

### Phase 1: One linear run from the CLI (≈1 week)

`block-party run --repo <path> --plan plan.md [--base main]` does the whole chain once,
with no UI beyond the terminal, logs, and artifacts.

- [ ] Git service: worktree + branch creation, SHA recording, setup command.
- [ ] Terminal host adapter (herdr or tmux, per the spike) and Claude adapter with hooks
      and `report.json` completion; headless fallback.
- [ ] Local CI runner from `.block-party.yaml`, with `checks init` and CI drift warnings.
- [ ] Codex reviewer adapter with schema-validated findings; only runs on green local CI.
- [ ] Reviewer eval: a few past PRs with known issues, to tune the prompt before trusting
      "no findings".
- [ ] One automatic fix round for P0/P1 findings, then local CI and re-review.
- [ ] Push + draft PR at the end + head SHA confirmation + wait for GitHub CI.
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
- [ ] CI parity gap handling (GitHub CI red after local green → fix round + inbox note).
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

### Phase 5: Verify stage (agentic end-to-end testing)

See 5.7. Built driver by driver, in the order I need them:

- [ ] Stage plumbing: verify profiles, environment start/ready/teardown, QA agent with an
      MCP config, per-criterion results and evidence, `fail` → `e2e` findings → fix loop.
- [ ] Browser driver (Playwright MCP) for web projects. First target: block-party itself.
- [ ] MCP-client driver for MCP server projects.
- [ ] Ephemeral database driver (local Docker Postgres first, hosted DB branches later).
- [ ] Remote hosts from an allowlist; structured app drivers (e.g. Ableton MCP).
- [ ] Computer-use driver (`ui_task`) on a dedicated machine, model configurable.
- **Exit check:** a web change and a non-web change (MCP server or DB) each get verified
  with real evidence and no manual setup.

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
| Multiplexer-hosted agent sessions | **Borrow** (attachable implementer sessions in herdr, tmux fallback) |
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

- **2026-11-06: Phase 0 results.** Reviewer uses `codex exec --output-schema`. Agents
  file lives in the run dir and is passed as `--agents <path>`; `report.json` lives in the
  run dir. Runs use a dedicated herdr named session (`block-party`) that block-party
  starts itself. Panes are launched via `layout.apply` argv, not typed commands. A `Stop`
  counts only with no background tasks. Plan format: four required sections plus at
  least one acceptance criterion (`docs/templates/plan.md`).
- **2026-11-05: herdr (`herdrdev/herdr`, pinned) is the default terminal host, tmux the
  fallback, behind a `TerminalHost` adapter.** Its socket API and agent-state events fit a
  Node server better than shelling out to tmux, it has the same detach/persistence model,
  it's Apache-2.0, and I already use it. Its state detection is a secondary signal only.
  *Revisit if* its API breaks between versions often enough to cost more than tmux would.
- **2026-11-05: Add a generic Verify stage after the review loop, before publishing.**
  Project types differ only by verify profile (environment + MCP drivers); structured
  drivers are preferred, computer use is a last resort on dedicated machines.
- **2026-11-05: Local CI parity before Codex review; push only once, at the end.** Codex
  shouldn't review code CI would reject, and GitHub Actions minutes are limited. Local
  checks are derived from the workflow files, and drift is reported. *Revisit if* GitHub CI
  regularly disagrees with local CI.
- **2026-11-05: Personal, local-only; use installed `claude` and `codex` CLIs with my
  subscriptions.** Agent SDK can't use subscription auth in third-party apps without
  approval, and I don't need distribution. Adapters keep the SDK swappable. *Revisit if* I
  want to share block-party with others.
- **2026-11-05: Implementer runs as an attachable interactive Claude session in a terminal
  multiplexer; structured state comes from hooks, not terminal scraping.** I want to drop
  into and steer live sessions. Headless stream-json stays as the fallback behind the same
  interface. *Revisit after* the Phase 0 spike if interactive mode is unreliable.
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
| Keystroke-driven interaction breaks with Claude Code TUI changes | Hooks for state; files for content; headless fallback |
| herdr is pre-1.0 and its API changes | Pinned version; all calls in one adapter with contract tests; tmux fallback |
| herdr server restarts and kills live agents | Treated like a reboot: stages marked `interrupted`, resumed via `claude --resume`; worktrees untouched |
| Local CI drifts from GitHub CI | Checks derived from workflow files; drift warnings; CI-red-after-local-green recorded as a parity gap |
| Verify environments are flaky or slow | Environment failures are `blocked`, not `fail`; ready probes and timeouts; structured drivers before computer use |
| Verify touches real data or machines | Ephemeral DBs only, host allowlist, credentials scoped to the stage, never production |
| Unattended run stalls on a permission prompt | `Notification` hook → inbox; permission profiles that make prompts rare |
| Agent says "done" without doing it | `report.json` is a claim; engine verifies commits, cleanliness, checks, diff |
| Review/fix churn or regressions | Round caps, repeated-finding detection, diff-size sanity check, escalation |
| Lost work on crash or cleanup | Never auto-delete worktrees; reconciliation on restart |
| Subagents collide in one worktree | Ownership rules in brief; revisit with per-subagent worktrees if needed |
| Building infrastructure before validating the workflow | Phase 1 is a CLI-only end-to-end run on a real plan |

**Open questions**

- How should the QA agent choose between several verify profiles when a diff touches
  multiple areas: run all matching profiles, or let it pick? Leaning toward all matching.
- Computer-use driver: OpenAI's or Claude's computer-use model, and what runs on the
  remote host (VNC plus a local driver, or a small agent on the host)? Decide when that
  driver is built.
- Implementer permissions: the spike's `Bash(pnpm:*)` allowlist would also allow
  `pnpm add`, which the brief forbids. Phase 1 should list specific scripts instead.
- Does block-party develop itself? Dogfooding from Phase 1 onward is the best test, but a
  run that modifies block-party while block-party is supervising it needs care (separate
  worktree, rebuild-then-restart).
