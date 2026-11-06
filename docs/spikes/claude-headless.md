# Spike: headless Claude Code (`claude -p`) as the fallback adapter

Claude Code 2.1.319, model `haiku` (resolves to `claude-haiku-5-5`), macOS, 2026-11-05. All runs in
throwaway git repos under the session scratchpad; total spend well under $0.10. Code:
`spikes/claude-headless/` (`stream.ts` = typed parser + zod schemas, `run.ts` = driver,
`experiments.sh` = reproduction). Event counts below were validated by parsing the real logs with
`stream.ts` (all lines classify; only `thinking_tokens` is deliberately "unknown").

Gotchas that bit during the spike, up front:

- Close stdin (`stdio: ['ignore', ...]`). Otherwise claude prints `Warning: no stdin data received in 3s`
  and waits 3 seconds.
- Variadic flags (`--allowedTools`, `--disallowedTools`) swallow the prompt. Put `--` before the prompt.
- A standalone `sleep N` Bash command is blocked by the Bash tool itself ("use Monitor"), so use a
  different long-running command when testing interruption.

## Q1. Event types in the stream

**Ran:** `claude -p --model haiku --session-id <uuid> --output-format stream-json --verbose
--settings settings.json --agents agents.json --permission-mode acceptEdits "<prompt>"` with
`helper` (model haiku, tools `[Write]`) in a fresh repo. 17 s wall, 29 lines, cost $0.008, 4 turns.
Outcome: `a.txt`, `b.txt`, `report.json` all created.

**Observed**, one JSON object per line. Types seen (in order of first appearance):

| line | meaning |
| --- | --- |
| `system/hook_started`, `system/hook_response` | SessionStart hook lifecycle (only SessionStart showed up, without `--include-hook-events`) |
| `system/init` | cwd, session_id, model, permissionMode, tools[], agents[], claude_code_version |
| `system/thinking_tokens` | estimated thinking-token counters, noise |
| `assistant` | one content block per line: `thinking`, `text`, or `tool_use` (same `message.id` for blocks of one API message) |
| `user` | `tool_result` blocks (and, for subagents, the prompt text) |
| `rate_limit_event` | rate-limit window state, noise |
| `system/task_started`, `task_progress`, `task_updated`, `task_notification` | subagent lifecycle |
| `system/permission_denied` | seen in Q5 |
| `result` | final line |

Trimmed real examples:

```jsonc
{"type":"system","subtype":"init","cwd":".../r1","session_id":"25b3d6e5-dcf2-47ed-8985-874a028801e8",
 "model":"claude-haiku-5-5","permissionMode":"acceptEdits","tools":["Task","Bash","Edit","Write",...],
 "agents":["claude","Explore","general-purpose","helper","Plan",...],"claude_code_version":"2.1.319"}
{"type":"assistant","message":{"model":"claude-haiku-5-5","id":"msg_011Cgm9dz5...","role":"assistant",
 "content":[{"type":"tool_use","id":"toolu_01Tuj5a4...","name":"Write",
 "input":{"file_path":".../r1/a.txt","content":"a"},"caller":{"type":"direct"}}],
 "usage":{"input_tokens":2,"output_tokens":4,...}},"parent_tool_use_id":null,"session_id":"25b3d6e5-..."}
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01Tuj5a4...","type":"tool_result",
 "content":"File created successfully at: .../r1/a.txt ..."}]},"parent_tool_use_id":null,
 "session_id":"25b3d6e5-...","timestamp":"...","tool_use_result":{"type":"create","filePath":"..."}}
{"type":"result","subtype":"success","is_error":false,"result":"Done. All three files are in ...",
 "stop_reason":"end_turn","terminal_reason":"completed","session_id":"25b3d6e5-...","num_turns":4,
 "duration_ms":...,"duration_api_ms":10433,"total_cost_usd":0.008011235,
 "usage":{"input_tokens":8,"cache_creation_input_tokens":28593,"cache_read_input_tokens":116769,
 "output_tokens":908,...},"permission_denials":[],
 "subagent_stats":{"spawned":1,"completed":1,"failed":0,"by_type":{"helper":1},...}}
```

**Conclusion.** Everything Phase 1 needs is in the stream: tool calls (`assistant/tool_use`), results
(`user/tool_result`), per-run cost (`result.total_cost_usd`), token usage, `session_id`, `num_turns`,
`permission_denials`, `terminal_reason`, and `subagent_stats`. `--session-id` is honored exactly (the
`session_id` on every line equals the UUID we passed). `result.subtype` is `success` or an
`error_*` variant; `is_error` is the simple check. The tool is called `Agent` in current
versions (init still lists `Task`); match both.

## Q2. Subagent visibility

**Ran:** run 1 (above) without `--forward-subagent-text`, and run 2 with it, same task shape.

**Observed.** `claude --help` documents: `--forward-subagent-text  Forward subagent text and thinking
blocks as assistant/user messages with parent_tool_use_id set (only works with --print and
--output-format=stream-json)`. So the flag exists in 2.1.319.

Subagent activity is visible **even without the flag**, flat (not nested) and tagged with
`parent_tool_use_id` = the parent's `Agent` tool_use id (user events also carry `agent_id`):

```
assistant  tool_use Agent  (parent)                           <- Agent{subagent_type:"helper",prompt:...}
system/task_started        {task_id, tool_use_id, subagent_type:"helper", description, prompt}
user       text            parent_tool_use_id=toolu_01Mv..     <- the prompt handed to the subagent
system/task_progress       {description:"Writing b.txt", usage:{total_tokens,tool_uses,duration_ms}}
assistant  tool_use Write  parent_tool_use_id=toolu_01Mv..     <- subagent's own tool call
user       tool_result     parent_tool_use_id=toolu_01Mv..
system/task_updated        {patch:{status:"completed"}}
system/task_notification   {status:"completed", summary:"I created ...b.txt...", usage, output_file}
user       tool_result     (parent's result of the Agent call)
```

What the flag adds: the subagent's **text and thinking** blocks (e.g. its final
`assistant text ... parent_tool_use_id=toolu_01DU...` line). Without it, subagent tool_use/tool_result
and the task_* system events still appear but its prose does not (the summary is in
`task_notification.summary`).

**Conclusion.** For a "3 subtasks, 2 done" UI, the `task_*` events (`task_started` /
`task_notification`, keyed by `task_id` and `tool_use_id`) are enough and need no flag. Per-subagent
tool activity is available by filtering on `parent_tool_use_id`. Pass `--forward-subagent-text` only
if we want to show subagent prose; it costs nothing extra but adds stream volume. `result` also has
`subagent_stats` (spawned/completed/failed/killed). Subagent tokens roll into `total_cost_usd`.

## Q3. Hooks via `--settings` in `-p` mode

**Ran:** run 1 with `--settings settings.json` defining command hooks (`cat >> hooks-<Event>.jsonl`)
for `Stop`, `SubagentStop`, `PostToolUse`, `SessionStart`.

**Observed:** all four fire, one JSON payload each on stdin:

| hook | count in run | notes |
| --- | --- | --- |
| SessionStart | 1 | |
| PostToolUse | 4 | Write (main), Write (agent_type `helper`), Agent, Write (main) |
| SubagentStop | 1 | `agent_id`, `agent_type: "helper"` |
| Stop | 1 | fires when the main turn ends |

Payload common fields: `session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode`,
`hook_event_name`; subagent-originated events add `agent_id` and `agent_type`. The user's own
`~/.claude` settings hooks are also active (SessionStart hook lifecycle lines in the stream) unless
`--bare`/setting-source flags are used; `--settings` is additive.

**Conclusion.** Hooks work in `-p` mode and are a good side channel (esp. SubagentStop, with
`agent_type`). Note the stream already carries equivalent information (task_notification), so hooks
are optional for headless; they matter more for the interactive adapter. `--include-hook-events`
(adds all hook lifecycle events to the stream) exists but was not tried.

## Q4. Resume

**Ran:** `claude -p --resume <uuid> --model haiku --output-format stream-json --verbose
--permission-mode acceptEdits "What files did you create earlier?..."` in the same cwd.

**Observed:** `init.session_id` and `result.session_id` equal the original UUID; the model answered
`a.txt b.txt report.json` from the previous conversation (`num_turns: 1`). A second resume
(`--output-format json`) also returned the same id. The session id is **stable across resumes**
(only `--fork-session` creates a new one). Resume must run from the same cwd (sessions are stored
under `~/.claude/projects/<cwd-slug>/<uuid>.jsonl`); `--model`, `--permission-mode` etc. must be
re-passed, since `init.permissionMode` was `default` when not passed.

**Conclusion.** `resume` fits the `AgentAdapter` "send follow-up" model. Persist `session_id` and
cwd per run; re-pass the permission profile and model on every resume.

## Q5. Permissions in `-p` mode

**Ran:** (a) default mode, prompt asks for a compound Bash command and a Write; (b) the profile below.

**Observed (a):** nothing hangs. Tools that would prompt are denied immediately with
`is_error: true` tool_results ("Claude requested permissions to write to ... but you haven't
granted it yet"; "This Bash command contains multiple operations. The following parts require
approval..."). The agent reports failure and finishes (12 s). The `result` event lists them in
`permission_denials` (`tool_name`, `tool_use_id`, `tool_input`), and each also emits
`system/permission_denied`. (`--permission-prompts none|host` exists to make this explicit; not needed.)

**Observed (b):** with `--permission-mode acceptEdits --allowedTools "Bash(git status:*)"
"Bash(git add:*)" ... "Bash(pnpm:*)" Read Edit Write --disallowedTools "Bash(git push:*)"
"Bash(curl:*)" "Bash(rm:*)"`: Write y.txt ran, `git status --short` ran, `pnpm --version` ran
(10.33.0), `git add` ran, while `git push`, `curl` and `rm -rf` were denied and listed in
`permission_denials`. Exit code was 0 in all cases; denials are not process failures.

**Conclusion.** Default is deny-and-continue, which is safe but can burn turns; the orchestrator must
inspect `permission_denials` and treat a non-empty list as a signal (log, surface in the UI, maybe
re-run with a wider profile).

## Q6. Interruption (SIGTERM)

**Ran:** started a run with a 60 s `node -e setTimeout` Bash command, sent SIGTERM to the claude pid
once the Bash tool_use appeared.

**Observed:** claude exits promptly with code 143. It killed its own Bash child (no orphaned
`node` left) and emitted a final `tool_result "Exit code 137"` `is_error` line, but **no `result`
event** (stream just ends). Files written before the kill (`one.txt`) remain; the git worktree is
left in whatever partial state. The session transcript on disk stays valid:
`claude -p --resume <uuid> "Continue ... two.txt ..."` resumed the same session id, saw the
killed command, and finished the work (`two.txt` created).

**Conclusion.** "Process exited without a `result` event" = interrupted/crashed; the adapter should
map this to `interrupted` and resume with the saved session id. Kill the process group
(`spawn-cli`'s detached/group kill) to also catch MCP server children (claude spawns npm/uvx MCP
processes from user config; they exit with it on SIGTERM in this test but use group-kill anyway).

## Q7. `--agents`: inline vs file vs `.claude/agents/`

**Ran:** (a) `--agents /path/agents.json`; (b) `--agents "$(cat agents.json)"` (run 1); (c) a
`.claude/agents/helper.md` with frontmatter in the repo and no `--agents`.

**Observed:** all three register `helper` (init `agents` lists it; `task_started.subagent_type`
is `helper`; the subagent completed the task). `claude --help` confirms `--agents <json-or-file>`
("with --print the path to a file that holds one"). Only (c) pollutes the worktree: `git status
--short` showed `?? .claude/`. Adding `.claude/` to `.git/info/exclude` hides it.

**Conclusion.** Use `--agents <file>`, generated per run outside the worktree. No repo pollution, no
escaping issues, and the file is a record of what was used. Only fall back to `.claude/agents/` if
subagent definitions need features not available in the JSON form (untested); if so, exclude via
`info/exclude` (for `git worktree`, `git rev-parse --git-path info/exclude`).

## Recommended permission profile for the implementer role

```
claude -p --model <opus|haiku|...> --session-id <uuid> --output-format stream-json --verbose \
  --permission-mode acceptEdits \
  --allowedTools "Read" "Edit" "Write" "Glob" "Grep" \
     "Bash(git status:*)" "Bash(git diff:*)" "Bash(git log:*)" "Bash(git add:*)" "Bash(git commit:*)" \
     "Bash(pnpm:*)" \
  --disallowedTools "Bash(git push:*)" "Bash(curl:*)" "Bash(rm:*)" \
  --agents /path/to/agents.json --settings /path/to/settings.json \
  -- "<prompt>"
```

Verified in Q5: edits + `git status/add` + `pnpm` allowed, `git push`/`curl`/`rm -rf` denied. Not
verified: `Bash(node:*)` is allowed (worked in Q6); Glob/Grep, `git commit`, `git diff`, and
edits outside cwd (acceptEdits is documented for cwd only; use `--add-dir` if needed). Prefer
prefix rules over `*`. Subagents inherit the permission context (helper's Write succeeded under
acceptEdits), but note `tools` on the agent definition restricts it further. `pnpm:*` is broad
(`pnpm dlx`, `pnpm exec` run arbitrary code), so consider `Bash(pnpm test:*)`, `Bash(pnpm lint:*)`,
`Bash(pnpm build:*)`, `Bash(pnpm install:*)` instead. Compound commands (`a && b`) are checked per
part, so each part must be allowed.

## Recommendations for the Phase 1 headless adapter

1. Spawn via `spawn-cli`-style process-group handling, stdin `ignore`, prompt after `--`. Pass
   `--session-id` on first spawn and persist it plus cwd; use `--resume` for follow-ups.
2. Feed stdout to `StreamParser` (`spikes/claude-headless/stream.ts`, lift as `src/core/llm/claude-stream.ts`).
   Map: `init` -> run started; `assistant/tool_use` + `user/tool_result` -> activity feed;
   `task_started/task_notification` -> subtask counters; `permission_denied` -> warning;
   `result` -> completion (cost, usage, num_turns, denials).
3. Completion = `result` event (check `is_error`/`subtype`) + process exit + `report.json` per the brief.
   Exit without `result` = interrupted; resume rather than restart.
4. Generate `agents.json` and `settings.json` into a per-run dir outside the worktree.
5. Use the `Stop`/`SubagentStop` hooks only as an optional extra; the stream already covers them.
6. Ignore `rate_limit_event` and `thinking_tokens` for the UI (or surface rate-limit `status` when not `allowed`).
7. Keep schemas loose (`z.looseObject`) and treat unknown events as non-fatal; the stream has changed
   shape between versions (`Task` -> `Agent`).
8. Record `claude_code_version` from `init` per run for debugging.

## Open issues

- `--include-hook-events` and `--permission-prompts host` (SDK permission prompt tool) were not tried.
- Only Haiku and a one-level subagent were tested; Opus-driving-Sonnet and parallel subagents
  (multiple concurrent `task_*` streams) not exercised. `result.subagent_stats` has `max_depth`.
- `--max-budget-usd` and `--max-turns`-style caps not tested; recommend adding a budget flag in Phase 1.
- Whether `.claude/agents/*.md` offers anything `--agents` JSON lacks is unknown.
- SIGTERM test only covered the process killed during a tool call; SIGTERM during an API stream
  and SIGKILL (no cleanup of Bash children) not tested.
- Allowlist coverage of `git commit`, `git diff`, Glob/Grep, writes outside cwd not verified.
- `result.duration_ms` was present in the schema but not independently checked against wall time.
- The user's global MCP servers/hooks load in `-p` runs (slow startup, noise); analogous to the
  codex-cli "ignore user MCP config" fix. A hermetic mode (`--strict-mcp-config`, setting sources) is
  untested here.
