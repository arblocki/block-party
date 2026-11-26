# Phase 1: one linear run from the CLI

## Goal

`block-party run --repo <path> --plan plan.md [--base main]` takes an approved plan through
the whole delivery chain once, with no UI beyond the terminal, logs, and on-disk artifacts:
create a worktree and branch, run an interactive Opus implementer (with Sonnet subagents) in a
herdr pane (or headless), verify its report against git, run the project's CI-parity checks
locally, have Codex review the exact head SHA with schema-validated findings, send P0/P1
findings back to the same implementer session for one fix round, re-check and re-review,
then push and open a draft PR, confirm its head SHA, and wait for GitHub CI.

Exit check (ARCHITECTURE 10, Phase 1): run it on a real plan for this repo and get a draft PR
with Codex findings and their resolutions, without copying text between tools.

## Context

- Architecture and roadmap: `docs/ARCHITECTURE.md` (sections 3, 5.2–5.6, 6, 10). Phase 0
  spike write-ups: `docs/spikes/{herdr-claude,claude-headless,codex-review,ci-parity}.md`.
  They contain verified CLI flags, event shapes, and gotchas; implementers must read the
  sections their task points at.
- Phase 0 code to lift: `spikes/claude-headless/stream.ts` (+ test),
  `spikes/codex-review/findings.ts`, `findings.schema.json`, `review-prompt.md`,
  `spikes/herdr-claude/herdr-client.ts`, `spikes/herdr-claude/hook.js`,
  `spikes/herdr-claude/common.ts` (trust-dialog handling).
- Existing reusable code: `src/core/llm/spawn-cli.ts` (process-group spawn, timeouts, kill
  escalation; `fake-spawn.testutil.ts` for tests), `src/core/llm/codex-cli.ts`
  (`stripMcpNoise`, `lastAgentMessage`), `src/core/checks/*` (workflow parsing, proposal,
  drift, `checks:` zod schema), `src/core/github/*` (Octokit `RestLike` adapter, token
  resolution), `src/core/paths.ts` (`dataDir()` honours `BLOCK_PARTY_HOME`),
  `src/core/hash.ts`, `src/cli/args.ts` + `src/cli/index.ts` (review CLI).
- Templates: `docs/templates/plan.md` (plan validation rules), `task-brief.md`,
  `report.schema.json`.
- Installed and verified locally: herdr 0.9.5, Claude Code 2.1.319, codex-cli 0.162.1,
  tmux. This repo has no `.github/workflows`, so CI parity uses the package-scripts
  fallback and "wait for GitHub CI" must handle "no CI configured".

## Global constraints

These bind every task.

1. TypeScript strict, ESM (`.js` import suffixes), Node ≥ 22, existing lint/prettier
   config. New runtime dependencies are not allowed; use what `package.json` already has
   (`zod`, `yaml`, `@octokit/*`, Node built-ins).
2. All new code lives under `src/` (core logic in `src/core/<module>/`, CLI wiring in
   `src/cli/`). Files that must ship in `dist/` cannot be `.json`/`.md` assets (the build
   is plain `tsc`); embed schemas and templates as TS constants.
3. Every module that talks to an external process or socket takes its dependency by
   injection (a `SpawnFn`, a runner function, a socket path, a client) so unit tests never
   launch `claude`, `codex`, `herdr`, or reach GitHub. Tests that need the real tools are
   opt-in behind `BP_LIVE=1` and skipped otherwise.
4. Tests use vitest, sit next to the code (`*.test.ts`), and must pass with
   `pnpm typecheck && pnpm lint && pnpm test`. Git-service tests may create real temporary
   git repos under `os.tmpdir()`.
5. Never destroy work: no `git push --force`, no branch deletion, no `worktree remove`, no
   `rm -rf` of run directories anywhere in Phase 1 code.
6. On-disk layout (ARCHITECTURE 4): runs under `<dataDir>/runs/<runId>/`, worktrees under
   `<dataDir>/worktrees/<owner>__<repo>/<runId>/`, where `<dataDir>` is
   `src/core/paths.ts#dataDir()`.
7. Agent output (reports, findings, hook payloads) is untrusted data: validate with zod,
   never execute anything from it, never interpolate it into shell commands.
8. Secrets: never pass `GITHUB_TOKEN`/`GH_TOKEN` into agent environments; never log tokens.
9. Don't change existing review-UI behaviour. `block-party owner/repo#123` and every
   existing CLI flag must keep working.

## Approach

Tasks are sequential (each builds on the previous ones' interfaces). Each task owns the
files it lists; touch other files only as stated.

### Task 1: Lift the stream parser and findings schema into `src/`

Phase 0 left `stream.ts` and `findings.ts` in `spikes/`. Move them into `src/` with proper
tests.

Files:
- Create `src/core/agents/claude-stream.ts` from `spikes/claude-headless/stream.ts`
  (same exports and behaviour) and `src/core/agents/claude-stream.test.ts` from the spike
  test, extended with: every event kind it classifies (init, assistant text/tool_use,
  user tool_result, task_started/task_notification, permission_denied, result success and
  error, rate_limit/thinking ignored as `unknown`), an unknown event shape → `unknown`
  (never throws), invalid JSON line handling, and `parent_tool_use_id` preserved for
  subagent events. Use small inline fixtures modelled on the examples in
  `docs/spikes/claude-headless.md` Q1/Q2.
- Create `src/core/reviewer/findings.ts` from `spikes/codex-review/findings.ts`, keeping
  `SeveritySchema`, `CategorySchema`, `FindingSchema`, `ReviewerOutputSchema`,
  `parseReviewerOutput`, `parseEvents`, `lastAgentMessage`. Drop `normalizeProseReview`
  and `UnstructuredReview` (option 1 was rejected). Add `'e2e'` to `CategorySchema`
  (ARCHITECTURE 3.3/5.7).
- Create `src/core/reviewer/schema.ts` exporting `FINDINGS_JSON_SCHEMA` (the content of
  `spikes/codex-review/findings.schema.json` as a TS `const`, with `e2e` added to the
  category enum) and `writeFindingsSchema(dir): Promise<string>` that writes it as
  `findings.schema.json` into `dir` and returns the path.
- Create `src/core/reviewer/prompt.ts` exporting `REVIEW_PROMPT_TEMPLATE` (content of
  `spikes/codex-review/review-prompt.md`) and
  `renderReviewPrompt({ planPath, baseSha, headSha, priorFindings }): string`, where
  `priorFindings` is an array of `{ id, severity, title, location, resolution, note }` and
  renders as one bullet per finding (`- [P1] f_1_2 "title" at path:10-14 — resolution:
  fixed — note`), or `(none: first round)` when empty. Placeholders are replaced with
  `replaceAll`; a value containing `{{` must not cause a second substitution.
- Create `src/core/reviewer/findings.test.ts`: parse success; fenced JSON tolerated;
  invalid JSON; schema violation (message names the path); `reviewedSha` mismatch with
  expected; a finding whose `reviewedSha` differs; short-vs-long SHA prefix match;
  `lastAgentMessage` picks the last `agent_message`; **parity test**: every property of
  every object in `FINDINGS_JSON_SCHEMA` is listed in its `required` and has
  `additionalProperties: false`, and the enums for severity/category/confidence equal the
  zod enums (compare to `z.toJSONSchema(ReviewerOutputSchema)` or walk both).
  `renderReviewPrompt` tests: placeholders filled, empty prior findings text, injection of
  `{{HEAD_SHA}}` inside a plan path is not re-substituted.
- Update `spikes/claude-headless/run.ts` and `spikes/codex-review/run.ts` to import from
  the new `src/` modules (keep them runnable; `run.ts` option 1 may be deleted since
  `normalizeProseReview` is gone). Delete `spikes/claude-headless/stream.ts`,
  `spikes/claude-headless/stream.test.ts`, `spikes/codex-review/findings.ts`,
  `spikes/codex-review/findings.schema.json`, `spikes/codex-review/review-prompt.md`.
  `run.ts` should write the schema via `writeFindingsSchema` into its `--out` dir and
  render the prompt via `renderReviewPrompt`.
- `vitest.config.ts`: drop `spikes/**/*.test.ts` from `include` if no spike tests remain.

### Task 2: Run workspace: ids, paths, plan import, report schema, event log

Files (all new, in `src/core/run/`):
- `paths.ts`: `runsRoot(env?, home?)`, `runDir(runId, env?, home?)`,
  `worktreesRoot(env?, home?)`, `worktreePath(owner, repo, runId, env?, home?)` built on
  `dataDir()`. `owner`/`repo`/`runId` must match `^[A-Za-z0-9._-]+$` and not be `.` or `..`
  (throw otherwise) so no path can escape the roots.
- `id.ts`: `newRunId(now = new Date(), rand = randomBytes)` → `r<yyyyMMdd>-<6 lowercase hex>`
  (e.g. `r20261108-3fa9c1`); `slugify(title)` → lowercase kebab, ASCII only, max 40 chars,
  never empty (fallback `run`); `branchName(title, runId)` → `bp/<slug>-<last 6 of runId>`.
- `plan.ts`: `parsePlan(markdown): { ok: true, plan } | { ok: false, errors: string[] }`
  implementing the validation rules table in `docs/templates/plan.md`: H1 title required;
  H2 sections `Goal`, `Approach`, `Acceptance criteria`, `Out of scope` exist
  (case-insensitive); Acceptance criteria has ≥ 1 `- [ ]` (or `- [x]`) item; no `TODO` or
  `TBD` as whole words in Approach or Acceptance criteria (case-sensitive, outside code
  fences). `plan` = `{ title, sections: Record<lowercased heading, body>,
  acceptanceCriteria: string[] (item text, tags like [browser] kept), contentHash }` where
  `contentHash` uses `src/core/hash.ts`. Headings inside fenced code blocks are ignored.
- `report.ts`: zod `ReportSchema` mirroring `docs/templates/report.schema.json` (strict
  objects; `questions` non-empty iff `status === 'blocked'` via `superRefine`), and
  `readReport(path): Promise<{ ok: true, report } | { ok: false, error } | { ok: false,
  missing: true }>`. Parity test: load `docs/templates/report.schema.json` from the repo in
  the test, compare required keys and enums with the zod schema.
- `events.ts`: `RunLog` class: `new RunLog(runDir, { now?, echo? })`;
  `log(type: string, data?: Record<string, unknown>)` appends
  `{"ts":ISO,"type":...,"data":...}\n` to `<runDir>/run-events.jsonl` synchronously
  (`appendFileSync`, so a crash never loses an acknowledged event) and, if `echo` is set,
  calls it with a one-line human summary (`[12:01:03] checks.passed typecheck (4.2s)`).
- `artifacts.ts`: `writeArtifact(runDir, relPath, content: string | object):
  Promise<{ path, hash }>` (objects are written as pretty JSON; creates parent dirs;
  rejects `relPath` that is absolute or escapes `runDir`); `readJson<T>(path, schema)`.
- `run-state.ts`: zod `RunStateSchema` and `saveRunState(runDir, state)` writing
  `<runDir>/run.json` atomically (write temp + rename). State fields: `id, title, repoPath,
  owner, repo, baseRef, baseSha, branch, worktreePath, headSha | null, planPath, planHash,
  stage: 'setup'|'implementing'|'checking'|'reviewing'|'fixing'|'publishing'|'waiting_ci'|
  'complete'|'blocked'|'failed', stageNote: string | null, implementer: { mode: 'pane' |
  'headless', sessionId, paneLabel: string | null } | null, rounds: { checkFix: number,
  reviewFix: number }, prNumber: number | null, createdAt, updatedAt`.
- Tests for each file (`*.test.ts`), using a temp `BLOCK_PARTY_HOME`.

### Task 3: Git service

Files: `src/core/git/git.ts`, `src/core/git/index.ts`, `src/core/git/git.test.ts`.

- `type GitRunner = (args: string[], opts: { cwd: string }) => Promise<{ stdout, stderr,
  code }>`; default uses `execFile('git', args)` with `GIT_TERMINAL_PROMPT=0`, a 120s
  timeout, and no shell. Expose `createGit(runner = defaultRunner)` returning:
  - `repoRoot(cwd)` (`rev-parse --show-toplevel`, realpath-resolved).
  - `originRepo(cwd)` → `{ owner, repo }` parsed from `remote get-url origin`
    (ssh `git@github.com:o/r.git`, https `https://github.com/o/r(.git)`), else throw.
  - `fetchBase(repo, baseRef)` → base SHA: `fetch origin <baseRef>` then
    `rev-parse origin/<baseRef>^{commit}`; if the repo has no `origin` remote, fall back
    to `rev-parse <baseRef>^{commit}` and say so in the result (`{ sha, source: 'origin' |
    'local' }`).
  - `createWorktree({ repo, path, branch, baseSha })`: refuses if `path` exists or the
    branch exists; runs `worktree add -b <branch> <path> <baseSha>`.
  - `headSha(cwd)`, `isClean(cwd)` (`status --porcelain=v1 --untracked-files=all` empty),
    `statusLines(cwd)`.
  - `commitsBetween(cwd, base, head)` → `{ sha, subject }[]` oldest first.
  - `diffStat(cwd, base, head)` → `{ files, insertions, deletions }` (`diff --shortstat`).
  - `pushBranch(cwd, branch)`: `push -u origin <branch>:refs/heads/<branch>`; never
    `--force`.
  - `remoteBranchSha(cwd, branch)` via `ls-remote origin refs/heads/<branch>` (undefined
    when absent).
- `runSetup({ cwd, command, logPath, timeoutMs })` in `src/core/git/setup.ts`: runs a
  shell command (`sh -c`) in its own process group, streams stdout+stderr to `logPath`,
  kills the group on timeout, resolves `{ code, durationMs, timedOut }`. **This is the
  shared shell-command runner for Task 4 too**: export it as `runShell` from
  `src/core/process/run-shell.ts` and have `runSetup` call it. Signature:
  `runShell({ command, cwd, logPath, timeoutMs, env? }): Promise<{ code: number | null,
  signal: string | null, durationMs, timedOut }>`.
- All argv are arrays; branch names and paths are passed as separate args, never
  interpolated into a shell string. Branch names are validated with
  `git check-ref-format --branch`.
- Tests use real temp repos: a bare "origin", a clone, commits; cover each function,
  including a dirty worktree, an untracked file, push to the bare remote then
  `remoteBranchSha` equals local head, `createWorktree` refusal cases, `originRepo` URL
  forms (unit-test the parser separately), and `runShell` timeout killing a child
  (`sh -c 'sleep 30'` with a 200 ms timeout) plus log capture.

### Task 4: Local CI runner, `checks init`, and CLI subcommands

Files: `src/core/checks/load.ts`, `src/core/checks/run.ts`, tests for both,
`src/cli/commands/checks.ts`, `src/cli/main.ts` (subcommand dispatch), edits to
`src/cli/index.ts` and `src/cli/args.ts` (USAGE text only), new `.block-party.yaml` at the
repo root.

- `load.ts`: `loadProjectChecks(dir)` reads (from the filesystem, not git) `.block-party.yaml`
  / `.yml` (`checks:` section via `parseChecksConfig`; other sections ignored),
  `.github/workflows/*.y{a,}ml` (via `parseWorkflow`), lockfile names, and `package.json`
  scripts. Returns `{ config: ChecksConfig | undefined, proposal: ChecksProposal,
  drift: DriftReport | undefined, parityMeasurable: boolean, errors: string[] }`. Drift is
  computed only when `config` exists.
- `run.ts`: `runChecks({ cwd, checks: CheckConfig[], logDir, headSha, timeoutMs = 15 min,
  runShell })` runs required checks **sequentially** with `runShell` (Task 3), log file per
  check `<logDir>/<name>.log`, continuing after a failure so all results are known.
  Result: `{ headSha, passed: boolean, results: { name, command, cwd, exitCode, durationMs,
  timedOut, logPath }[] }`. A check's `cwd` is resolved relative to the worktree and must
  stay inside it. Also `tailLog(path, lines = 80)` for building fix prompts.
- CLI: introduce `src/cli/main.ts` exporting `main(argv)`: if `argv[0]` is `checks`,
  `run`, or `hook`, dispatch to `src/cli/commands/<name>.ts`; otherwise the existing review
  flow (move the current body of `src/cli/index.ts` into `src/cli/commands/review.ts`
  unchanged). `src/cli/index.ts` becomes the shebang entry calling `main`. For `run` and
  `hook` add stub modules that print "not implemented yet" and exit 2 (Tasks 6 and 11 fill
  them).
- `block-party checks init [--repo <dir>] [--write]`: prints the rendered proposal
  (`renderChecksYaml`) and the drift report if a config exists; `--write` creates
  `.block-party.yaml` only when no repo config file exists (otherwise refuse with a
  message telling the user to paste the printed `checks:` block).
- `block-party checks run [--repo <dir>]`: runs the configured required checks in that
  directory with logs under a temp dir, prints a pass/fail table, exits non-zero on
  failure. Errors if no `checks:` config.
- Add `.block-party.yaml` to this repo with the package-scripts proposal from
  `docs/spikes/ci-parity.md` (setup `pnpm install --frozen-lockfile`; typecheck, lint,
  test, build).
- Tests: load with/without config and workflows, drift present, invalid YAML reported in
  `errors`; runChecks with real `sh` commands (`true`, `false`, `exit 3`, a cwd escape
  rejected), logs written; CLI dispatch unit test (argv routing; review flow still
  receives its args).

### Task 5: herdr terminal host

Files: `src/core/terminal/types.ts`, `src/core/terminal/herdr-client.ts`,
`src/core/terminal/herdr.ts`, `src/core/terminal/index.ts`, tests with a fake socket
server (`src/core/terminal/fake-herdr.testutil.ts`).

Read `docs/spikes/herdr-claude.md` sections 1, 2, 3, 5, 6, 8 and the recommendations
first; the wire format and event names there are verified, the ARCHITECTURE doc's are not
always.

- `types.ts`:
  ```ts
  export interface PaneRef { session: string; label: string; cwd: string }
  export type AgentState = 'idle' | 'working' | 'blocked' | 'unknown';
  export interface TerminalHost {
    open(opts: { label: string; cwd: string; argv: string[]; env?: Record<string, string> }): Promise<PaneRef>;
    sendText(pane: PaneRef, text: string, opts?: { submit?: boolean }): Promise<void>;
    sendKeys(pane: PaneRef, keys: string[]): Promise<void>;
    read(pane: PaneRef, lines?: number): Promise<string>;   // diagnostics only
    agentState(pane: PaneRef): Promise<AgentState>;
    isAlive(pane: PaneRef): Promise<boolean>;
    close(pane: PaneRef): Promise<void>;
    attachCommand(pane: PaneRef): string;
    list(): Promise<PaneRef[]>;
  }
  ```
  (`argv` replaces the doc's `command: string`, per the spike: launch via `layout.apply`
  argv, never typed into a shell.)
- `herdr-client.ts`: grow `spikes/herdr-claude/herdr-client.ts`: request-per-connection
  `request(method, params, { timeoutMs = 10s })`, typed `HerdrError` with `code`
  (`server_not_running` when the socket is missing/ENOENT/ECONNREFUSED, `timeout`, plus
  codes from the server), `cleanHerdrEnv`, `ensureServer(session, { herdrBin = 'herdr',
  spawnFn, timeoutMs })` (ping; if not running, spawn `herdr --session <s> server`
  detached with `HERDR_*` stripped, poll ping), and `subscribe(events, onEvent)` on a
  dedicated connection returning `{ close() }`. Malformed lines from the socket are
  ignored, not thrown.
- `herdr.ts`: `createHerdrHost({ session = 'block-party', socketPath?, client? })`
  implementing `TerminalHost`: `open` = `ensureServer` + `workspace.create {cwd, label}` +
  `layout.apply { tab_id: <root tab>, root: { type: 'pane', cwd, label, command: argv,
  env } }`; resolve panes **by label + realpath(cwd)** through `pane.list` on every call
  (cache ids in memory only, drop the cache on `server_not_running`); `sendText` uses
  `pane.send_input {pane_id, text, keys: submit ? ['Enter'] : []}`; `sendKeys` uses
  `pane.send_keys`; `read` uses `pane.read {source:'recent', lines}`; `agentState` maps
  `pane.get().agent_status`; `isAlive` = pane found; `close` = `pane.close`;
  `attachCommand` = `herdr --session <session>` (plus a note naming the workspace label);
  `list` returns labelled panes. Check the exact param/response field names against the
  spike code (`spikes/herdr-claude/*.ts`) — they are the verified source.
- Tests: the fake server listens on a Unix socket in a temp dir and answers scripted
  responses keyed by method; cover open (both calls, argv passed through), label lookup
  after a simulated server restart (ids changed), `server_not_running` mapping, request
  timeout, malformed line ignored, subscribe receives pushed events, `cleanHerdrEnv`.
- Opt-in live test (`BP_LIVE=1`): open a pane running `sh -c 'echo hi; sleep 5'` in an
  isolated session `bp-test`, read it, close it, stop that session's server.

### Task 6: Implementer inputs, `block-party hook`, and completion detection

Files: `src/core/agents/brief.ts`, `src/core/agents/claude-config.ts`,
`src/core/agents/hook-events.ts`, `src/core/agents/hook.ts`, `src/cli/commands/hook.ts`,
tests for each.

This task also creates `src/core/agents/types.ts` containing only the `TurnOutcome` type
exactly as written in Task 7; `waitForTurnEnd` returns `TurnOutcome`. Task 7 adds the rest.

- `brief.ts`: `TASK_BRIEF_TEMPLATE` (TS constant equal to the fenced block in
  `docs/templates/task-brief.md`; a test extracts the fence from the doc and asserts
  equality) and `renderBrief(vars)`. Vars: `runTitle, worktreePath, branch, baseRef,
  baseSha, runDir, planPath, planVersion, extraBoundaries, subagentList, checkCommands,
  stage: 'implement' | 'fix', round, findingsPath, rulingsPath`. When `stage` is
  `implement`, the whole "Fix round _(fix rounds)_" section is removed; when `fix`, its
  heading's `_(fix rounds)_` marker is removed. Unknown `{{x}}` left in the output is an
  error. Values are inserted literally (no recursive substitution).
- `claude-config.ts`:
  - `buildAgents(subagents: { name: 'implementer' | 'test-writer' | 'explorer', model,
    readOnly? }[])` → the object for `agents.json` (`{ [name]: { description, prompt,
    model, tools? } }`); explorer gets read-only tools `["Read","Glob","Grep"]`; prompts
    are short role descriptions that restate the file-ownership rule.
  - `buildSettings({ hookArgv: string[], eventsPath, permissionMode })` → settings object
    registering command hooks for `SessionStart, UserPromptSubmit, PostToolUse,
    SubagentStop, Notification, Stop, SessionEnd`, each running the hook argv with the
    events path appended (shell-quoted safely; paths may contain spaces), and
    `permissions.defaultMode` = `permissionMode`.
  - `implementerPermissions(checkCommands: string[])` → `{ allowedTools, disallowedTools }`
    following `docs/spikes/claude-headless.md` "Recommended permission profile" but listing
    the specific check commands (e.g. `Bash(pnpm test:*)`) plus `pnpm install
    --frozen-lockfile` instead of `Bash(pnpm:*)`; deny `git push`, `curl`, `wget`, `rm -rf`,
    `pnpm add`, `npm install`, `gh`.
  - `hookArgv()` → argv that runs this build's CLI `hook` subcommand: `[process.execPath,
    ...process.execArgv, <abs path of the CLI entry>]`. Must work both from `dist/` and
    under `tsx` (test it by spawning `hookArgv()` with a payload on stdin in a test and
    checking the line is appended).
- `hook.ts` + `src/cli/commands/hook.ts`: `block-party hook <eventsPath>` reads stdin
  (cap 1 MiB), parses JSON, requires an object, appends `{"ts":ISO,"payload":<obj>}\n` to
  `eventsPath`; refuses (exit 0, message on stderr) unless `eventsPath` is absolute, ends
  in `/events.jsonl`, and lies inside `runsRoot()` after realpath of its directory. Always
  exits 0 (a failing hook must never break the agent).
- `hook-events.ts`: `HookEventSchema` (loose: `hook_event_name`, `session_id`, optional
  `background_tasks`, `agent_type`, `agent_id`, `transcript_path`, `notification_type`,
  `reason`, `source`), `readHookEvents(path, fromOffset)` → `{ events, nextOffset }`
  (handles a partial last line by not consuming it), and `HookWatcher` that polls the
  file (every 250 ms, injectable) and emits typed events. Helpers:
  `isFinalStop(ev)` = `Stop` with `background_tasks` absent or empty;
  `isRealSubagentStop(ev)` = `SubagentStop` with non-empty `agent_type`.
- `waitForTurnEnd({ watcher, sessionId, reportPath, agentState?, settleMs = 1500,
  timeoutMs, signal })` in `hook-events.ts`: resolves with the first of
  `{ kind: 'report' }` (final Stop observed and `report.json` exists after `settleMs`),
  `{ kind: 'no_report' }` (final Stop, no report after settle, and `agentState` is not
  `working` if provided), `{ kind: 'permission', message }` (`Notification` with
  `notification_type: 'permission_prompt'`, or `agentState` `blocked` for > 3 s),
  `{ kind: 'exited', reason }` (`SessionEnd`), `{ kind: 'timeout' }`. Events for other
  session ids are ignored. Only events appended after the call started count (pass the
  starting offset).
- Tests: rendering both stages; agents/settings shapes; quoting of a path with spaces and
  a `'`; hook path refusal cases; partial line handling; the Stop-with-background-tasks
  case from the spike (first Stop ignored, second resolves `report`); permission via
  notification; session id filtering.

### Task 7: Headless Claude implementer adapter

Files: `src/core/agents/types.ts`, `src/core/agents/claude-headless.ts`, test; small
extension to `src/core/llm/spawn-cli.ts` (+ its test).

- `spawn-cli.ts`: add optional `env?: NodeJS.ProcessEnv` (passed to `spawnFn`) and
  `onStdout?: (chunk: string) => void` / `onStderr?` callbacks invoked for every chunk
  (in addition to the existing buffering). Existing callers unchanged.
- `types.ts` (exists from Task 6 with `TurnOutcome`; add the rest):
  ```ts
  export interface ImplementerSession { mode: 'pane' | 'headless'; sessionId: string; cwd: string; paneLabel?: string }
  export interface ImplementerStartInput {
    runId: string; cwd: string; runDir: string; prompt: string; model: string;
    agentsPath: string; settingsPath: string; eventsPath: string; reportPath: string;
    permissionMode: string; allowedTools: string[]; disallowedTools: string[];
    timeoutMs: number; signal?: AbortSignal;
  }
  export type TurnOutcome =
    | { kind: 'report' }                       // report.json present (not yet validated)
    | { kind: 'no_report'; detail?: string }
    | { kind: 'permission'; message: string }
    | { kind: 'exited'; reason: string }
    | { kind: 'timeout' };
  export interface ImplementerAdapter {
    start(input: ImplementerStartInput): Promise<{ session: ImplementerSession; outcome: TurnOutcome }>;
    /** New turn in the same conversation (resume if the process is gone). */
    send(session: ImplementerSession, input: ImplementerStartInput, message: string): Promise<TurnOutcome>;
    stop(session: ImplementerSession, opts?: { force?: boolean }): Promise<void>;
    describe(session: ImplementerSession): string; // e.g. attach command or log path
  }
  ```
  Messages vs lifecycle stay separate (`send` vs `stop`).
- `claude-headless.ts`: `createHeadlessClaude({ spawnFn?, claudeBin = 'claude', randomUUID? })`.
  `start` spawns `claude -p --model <m> --session-id <uuid> --output-format stream-json
  --verbose --permission-mode <mode> --settings <settingsPath> --agents <agentsPath>
  --allowedTools ... --disallowedTools ... -- <prompt>` with stdin closed (no `input`),
  `cwd`, and an env without `GITHUB_TOKEN`/`GH_TOKEN`/`BLOCK_PARTY_TOKEN`. Every stdout
  chunk is appended to `<runDir>/agent/stream-<n>.jsonl` and fed to `StreamParser`;
  `init`'s `claude_code_version` and `result` (`total_cost_usd`, `num_turns`,
  `permission_denials`, `is_error`) are logged through an optional `onEvent` callback.
  Outcome: process exit with a `result` event and `report.json` present → `report`; with
  `result` but no report → `no_report`; exit without a `result` event → `exited`
  (interrupted); spawn timeout → `timeout`. Non-empty `permission_denials` is reported in
  the outcome detail (it is not a failure). `send` = `claude -p --resume <id>` repeating
  model, permission flags, settings, agents. `stop` aborts the live process (AbortSignal).
- Tests with `fake-spawn.testutil.ts`: argv shape (prompt after `--`, flags repeated on
  resume), env scrubbing, each outcome, stream file written, a result with denials.

### Task 8: Interactive (pane) Claude implementer adapter

Files: `src/core/agents/claude-pane.ts`, test.

Read `docs/spikes/herdr-claude.md` sections 3, 5, 6, 7, 8 and recommendations 3–9.

- `createPaneClaude({ host: TerminalHost, watcherFactory, randomUUID?, claudeBin, now? })`
  implementing `ImplementerAdapter` (Task 7 types).
- `start`: `host.open({ label: 'bp-<runId>-impl', cwd, argv: [claudeBin, '--model', m,
  '--session-id', uuid, '--permission-mode', mode, '--settings', settingsPath, '--agents',
  agentsPath, '--allowedTools', ..., '--disallowedTools', ..., '--', prompt], env })`
  (same env scrubbing as Task 7). Then handle the folder-trust dialog: for up to 20 s,
  until a `SessionStart` hook event for the session arrives, `read` the pane; if it
  contains `trust this folder` **and** `cwd` is inside `worktreesRoot()`, send keys
  `["Down", "Enter"]` once and log it; outside the worktree root, return
  `{ kind: 'permission', message: 'folder trust dialog' }`. Then `waitForTurnEnd` (Task 6)
  with `agentState` from the host.
- `send`: if the pane is alive: wait until `agentState` is `idle` (poll, bounded), then
  `sendText(text, { submit: true })` and confirm a `UserPromptSubmit` hook event for the
  session within 5 s, retrying once; then `waitForTurnEnd`. If the pane is gone: open a
  new pane `bp-<runId>-impl-r<n>` with `claude --resume <id> ...same flags... -- <message>`.
  Messages must be single short pointers to files (the pipeline guarantees this; the
  adapter rejects messages over 2000 chars).
- `stop`: graceful = `sendText('/exit', { submit: true })` and wait up to 10 s for
  `SessionEnd`; `force` (or graceful timeout) = `host.close`. Before closing, save
  `host.read(pane, 200)` to `<runDir>/agent/pane-final.txt`.
- `describe`: the host's attach command plus the workspace label.
- Tests with a fake `TerminalHost` and a fake watcher: argv shape; trust dialog accepted
  inside the root and refused outside; send waits for idle and retries once when no
  `UserPromptSubmit`; send after pane death resumes in a new pane; stop graceful and
  forced paths.
- Opt-in live test (`BP_LIVE=1`, model `haiku`, isolated herdr session): start in a temp
  git repo under a temp `BLOCK_PARTY_HOME` worktree root, ask it to write `report.json`,
  expect `report`.

### Task 9: Codex reviewer adapter

Files: `src/core/reviewer/codex-reviewer.ts`, `src/core/reviewer/codex-home.ts`, tests.

Read `docs/spikes/codex-review.md` "Recommendations for the Phase 1 reviewer adapter".

- `codex-home.ts`: `ensureReviewerCodexHome({ dir = <dataDir>/codex-home, userCodexHome =
  $CODEX_HOME || ~/.codex })`: creates `dir` (mode 0700) containing only a symlink
  `auth.json` → the user's `auth.json` (so token refreshes are shared) and no skills,
  config, or MCP servers. Throws a clear error if the user's `auth.json` is missing.
- `codex-reviewer.ts`: `reviewWithCodex({ worktree, baseSha, headSha, planPath,
  priorFindings, outDir, round, model?, timeoutMs = 5 min, spawnFn?, codexHome })`:
  - Verifies `git rev-parse HEAD` in `worktree` equals `headSha` and the worktree is clean
    (inject the Task 3 git service) before starting; otherwise fails without running codex.
  - Writes the schema (`writeFindingsSchema(outDir)`) and the rendered prompt
    (`outDir/prompt.md`), runs `codex exec --sandbox read-only --ignore-user-config
    --ephemeral --json --output-schema <schema> --output-last-message <outDir/last.txt>
    [-m model] -` with the prompt on stdin, `cwd = worktree`, env with `CODEX_HOME =
    codexHome` and no GitHub tokens, via `spawnCli` (Task 7's `env` option). Raw stdout
    to `outDir/events.jsonl`, stderr (through `stripMcpNoise`) to `outDir/stderr.txt`.
  - Success requires a `turn.completed` event and no `turn.failed`/`error` event, then
    `parseReviewerOutput(text, headSha)` on `last.txt` (fallback: `lastAgentMessage`).
    On parse failure: exactly one retry, a fresh `codex exec` whose prompt is the original
    plus a section "Your previous output was rejected: <error>. Return only valid JSON."
    Then fail.
  - Normalizes findings: ids re-minted as `f_<round>_<n>` (1-based, in output order),
    `reviewedSha` set to the full `headSha`, `location.path` made repo-relative (strip a
    leading worktree prefix or `./`); a location whose file does not exist in the worktree,
    or whose `startLine` is past the end of the file, or `endLine < startLine`, is set to
    `null` and the original is appended to `body` as `(reported location: ...)`.
  - Returns `{ ok: true, output: ReviewerOutput, usage, attempts, durationMs }` or
    `{ ok: false, error, attempts }`. Never returns an empty findings list on failure.
  - Writes `outDir/findings.json` (the normalized output) on success.
- Tests with fake spawn: happy path; `turn.failed`; missing `turn.completed`; invalid JSON
  then valid on retry; invalid twice → fail; sha mismatch; HEAD mismatch refuses to run;
  path normalization and location nulling; env contains `CODEX_HOME` and no tokens;
  `codex-home` symlink creation in a temp dir.

### Task 10: GitHub publish and CI wait

Files: edits to `src/core/github/types.ts` and `client.ts` (+ `github.test.ts`), new
`src/core/run/publish.ts` + test.

- Extend `GitHubClient` with:
  - `findOpenPrForBranch(repo, branch)` → `{ number, headSha, url, draft } | undefined`
    (`GET /repos/{o}/{r}/pulls?head=<o>:<branch>&state=open`).
  - `createPr(repo, { head, base, title, body, draft: true })` → same shape.
  - `getPr(repo, number)` → same shape.
  - `getCiStatus(repo, sha)` → `{ state: 'pending' | 'success' | 'failure' | 'none',
    checks: { name, status, conclusion, url }[] }` combining
    `GET /commits/{sha}/check-runs` and `GET /commits/{sha}/status`; `none` when both are
    empty; any failure/cancelled/timed_out conclusion or `failure`/`error` status →
    `failure`; anything incomplete → `pending`.
- `publish.ts`:
  - `renderPrBody({ plan, report, checks, reviewRounds, runId })`: Markdown with Summary
    (from report), Acceptance criteria (report statuses), Local CI (per check, on SHA),
    Codex review (per round: reviewed SHA, findings table with severity, title, location,
    resolution), and a "⚠ Unresolved blocking findings" section when any P0/P1 is still
    open, ending with `Run: <runId>`. Agent text is inserted as plain Markdown text, but
    `@` mentions are neutralised (`@​`) so a finding can't ping people.
  - `publishRun({ git, github, worktree, branch, base, title, body })`: push (no force),
    then `remoteBranchSha === local HEAD` else fail; ensure PR (find, else create draft);
    poll `getPr` until `headSha === local HEAD` (bounded, 30 s) else fail. Idempotent:
    re-running finds the existing PR.
  - `waitForCi({ github, repo, sha, timeoutMs = 30 min, intervalMs = 20 s, noCiGraceMs =
    60 s, sleep, now })` → `{ state: 'success' | 'failure' | 'no_ci' | 'timeout', checks }`
    (`no_ci` when status stays `none` for the grace period).
- Tests with a fake `RestLike`: each client method and URL/params; CI state combination
  table; publish idempotency (PR exists); head mismatch failure; waitForCi success after
  pending, failure, no_ci, timeout (fake clock). PR body snapshot-style assertions
  including the unresolved section and mention neutralisation.

### Task 11: The `block-party run` pipeline

Files: `src/core/run/pipeline.ts`, `src/core/run/config.ts`, `src/cli/commands/run.ts`,
tests (`pipeline.test.ts`, `run-args.test.ts`); README section.

- `config.ts`: `RunConfig` zod schema with defaults: `implementer: { model: 'opus', mode:
  'pane' }`, `subagents: { implementer: 'sonnet', 'test-writer': 'sonnet', explorer:
  'sonnet' }`, `reviewer: { model: null }` (codex default), `policy: { maxCheckFixRounds:
  2, maxReviewFixRounds: 1, autoFix: ['P0','P1'], stageTimeoutMs: 2 h,
  checkTimeoutMs: 15 min }`, `publish: true`, `waitForCi: true`. Read optional `run:`
  section from the repo's `.block-party.yaml`, then CLI flags override.
- `pipeline.ts`: `runPipeline(input, deps)` where `deps` bundles the git service,
  `runShell`, `runChecks`, `loadProjectChecks`, an `ImplementerAdapter`,
  `reviewWithCodex`, `publishRun`, `waitForCi`, a `GitHubClient` factory, `RunLog`, clock.
  Steps, each logged and reflected in `run.json`:
  1. Read and validate the plan (`parsePlan`); copy to `<runDir>/plans/v1.md` (importing
     counts as approval of v1). Resolve repo root and `originRepo`. Load checks; refuse
     without a `checks:` config (tell the user to run `block-party checks init`). Log
     drift warnings.
  2. `fetchBase`, `createWorktree` at `worktreePath(...)` on `branchName(...)`, run
     `checks.setup` (log to `<runDir>/logs/setup.log`; failure → `failed`).
  3. Write `agents.json`, `settings.json`, the implement brief
     (`<runDir>/briefs/implement-1.md`), start the implementer with prompt `Read the task
     brief at <path> and follow it.`
  4. On outcome: `report` → validate `report.json` (Task 2). Verify against git: HEAD
     moved past base (≥ 1 commit), worktree clean. `blocked` status → stage `blocked`,
     print the questions, stop. `partial`, invalid report, uncommitted changes, no
     commits, `no_report`, `permission`, `exited`, `timeout` → stage `blocked` with a
     specific note and the adapter's `describe()` so I can attach; stop (worktree kept).
     Rename the consumed report to `reports/<stage>-<n>.json` so the next turn's report
     is fresh.
  5. Local CI on HEAD (`<runDir>/checks/<headSha7>/`). On failure and
     `checkFix < maxCheckFixRounds`: write `inputs/check-failures-<n>.md` (failed check
     names, commands, last 80 log lines each), render a fix brief whose findings file is
     that path, `send` "Read the fix brief at <path> and follow it.", then back to 4/5.
     At the cap → `blocked`.
  6. Review: `reviewWithCodex` (round r, prior findings with resolutions) into
     `<runDir>/reviews/round-<r>/`. Failure → `blocked` (no silent "clean").
  7. Triage: findings whose severity is in `autoFix` are blocking; others recorded. If
     blocking and `reviewFix < maxReviewFixRounds`: write `inputs/findings-round-<r>.json`
     (the blocking findings) and an empty `inputs/rulings.json` (`[]`), fix brief,
     `send`, validate the report's `findingResolutions` (every blocking id present;
     `disputed` ones stay open with the note), then checks (5) and review again (6) with
     round r+1. Repeated finding detection is out of scope for Phase 1.
  8. Publish (unless `--no-publish`): `renderPrBody`, `publishRun`, record PR number;
     then `waitForCi` (unless disabled): `success`/`no_ci` → `complete`, `failure` →
     `blocked` ("GitHub CI failed after local CI passed: parity gap"), `timeout` →
     `blocked`.
  9. Stop the implementer gracefully at the end (`complete`) — but not on `blocked`, so I
     can attach to the live session.
  Exit codes from the CLI: 0 complete, 3 blocked, 1 failed.
- `src/cli/commands/run.ts`: `block-party run --repo <path> --plan <file> [--base <ref>]
  [--mode pane|headless] [--model <m>] [--reviewer-model <m>] [--no-publish] [--no-wait-ci]
  [--title <t>]`. Defaults: `--repo .`, base = repo default branch (`origin/HEAD` symbolic
  ref, else `main`). Echoes the run id, run dir, worktree, attach command, and each stage
  transition. SIGINT stops waiting and marks the run `blocked` ("interrupted") without
  killing the pane.
- Tests: the whole pipeline with fakes for every dep (no processes): happy path with one
  P1 finding fixed in one round then a clean re-review → published, PR body contains the
  finding and its resolution; check failure → fix round → pass; check cap → blocked;
  report `blocked` → blocked with questions; uncommitted changes → blocked; reviewer
  failure → blocked; findings remain after the cap → published with the unresolved
  section; `--no-publish` stops after review; `no_ci` → complete. Arg parsing tests.
- README: a "Running a feature (Phase 1)" section with the command, prerequisites (herdr,
  claude, codex logged in, `checks init`, trusting `~/.block-party/worktrees` once), and
  where artifacts land.

### Task 12: Reviewer eval harness

Files: `scripts/reviewer-eval.ts`, `test/fixtures/reviewer-eval/*.json`, `package.json`
script `eval:reviewer`, `docs/spikes/reviewer-eval.md` (results).

- A case is JSON: `{ name, kind: 'synthetic', files: { [path]: content } (base),
  patch: { [path]: content | null } (head), plan: string, expected: [{ path, lines?:
  [start, end], minSeverity: 'P0'|'P1'|'P2'|'P3', keywords: string[] }] }` or
  `{ name, kind: 'git', repo: '.', base, head, plan, expected }` for real history of this
  repo. Synthetic cases build a temp repo (base commit, head commit). Negative cases
  (`expected: []`, a correct change) measure false positives.
- The script runs `reviewWithCodex` on each case (sequentially, real codex; it is a manual
  script, not a test), scores: a finding matches an expectation when the path matches,
  line ranges overlap (if given) or any keyword appears in title/body, and severity ≤
  `minSeverity`. Prints recall per case, false positives on negative cases, duration, and
  writes `<out>/results.json`.
- Cases: at least 4 synthetic planted bugs (SQL injection via interpolation; off-by-one
  in a pagination loop; missing `await` that drops an error; a check that a plan's
  acceptance criterion requires but the code skips), 2 negative cases, and at least 1
  `git` case from this repo's history (e.g. the change that `f5195e2` fixed: review its
  parent range and expect the issue it fixed).
- Unit test only the pure scoring function (`scripts/` is not in vitest's include, so put
  scoring in `src/core/reviewer/eval-score.ts` with `eval-score.test.ts`).

## Acceptance criteria

- [ ] `pnpm typecheck && pnpm lint && pnpm test` pass; no test launches real
      `claude`/`codex`/`herdr` or hits GitHub unless `BP_LIVE=1`.
- [ ] `spikes/` no longer contains `stream.ts`, `findings.ts`, the schema, or the prompt;
      their `src/` replacements have tests, including a JSON-schema/zod parity test.
- [ ] `block-party checks init` in this repo prints the package-scripts proposal;
      `block-party checks run` runs the four checks and prints a pass/fail table.
- [ ] `block-party hook <path>` appends one JSON line per invocation and refuses paths
      outside the runs root.
- [ ] `block-party run --repo . --plan <plan> --no-publish` creates a worktree and
      branch, launches the implementer in a herdr pane (attach command printed), and
      after the implementer reports, runs local CI and a Codex review pinned to the head
      SHA, writing everything under `~/.block-party/runs/<runId>/`. [manual]
- [ ] With P0/P1 findings, the pipeline sends one fix round to the same Claude session,
      re-runs local CI, and re-reviews the new head. [manual]
- [ ] Without `--no-publish`, the branch is pushed (no force), a draft PR is created
      whose head SHA equals local HEAD, its body lists findings and resolutions, and the
      run waits for GitHub CI (reporting `no_ci` for this repo). [manual]
- [ ] `--mode headless` runs the same flow with `claude -p`. [manual]
- [ ] `pnpm eval:reviewer` runs the eval cases and prints recall and false positives;
      results are recorded in `docs/spikes/reviewer-eval.md`. [manual]
- [ ] The existing review flow (`block-party owner/repo#123`) still works.

## Tests

Listed per task above. Cross-cutting: every external-process module is tested through
injected fakes; git and shell runners are tested against real temp repos and `sh`; the
pipeline is tested end-to-end with fakes only.

## Out of scope

- The app shell, server refactor, SSE, any web UI change (Phase 2).
- SQLite run tables and migrations (Phase 2); Phase 1 state is `run.json` +
  `run-events.jsonl` on disk.
- The decision inbox; in Phase 1 "escalate" means stop with stage `blocked`, print why, and
  keep the worktree and the live session.
- In-app planning, plan revisions, P2 triage prompts, disputed-finding rulings UI,
  repeated-finding detection, diff-size sanity checks (Phase 3).
- The tmux terminal host (fallback only if herdr proves unreliable), embedded terminals,
  reconciliation on restart, resuming a stopped run (`block-party run --resume`).
- The verify stage (Phase 5).
- Dependency upgrades, CI config, and refactors of unrelated code.

## Risks and open questions

- Claude Code TUI changes (trust dialog text, permission prompt) can break pane mode;
  headless mode is the fallback behind the same interface.
- `hookArgv()` must resolve correctly under both `tsx` (development) and `dist/`; if
  `process.execArgv` doesn't carry the tsx loader, the hook silently never fires. Task 6
  tests this by actually spawning it.
- The reviewer's recall is unproven; until the eval says otherwise, an empty findings list
  is shown as "Codex found nothing" in the PR body, not "clean".
