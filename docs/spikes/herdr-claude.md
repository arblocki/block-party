# Spike: interactive Claude in a herdr pane

Phase 0 spike for architecture sections 5.2, 5.2.1 and 5.6. Environment: herdr 0.9.5 (protocol 22),
Claude Code 2.1.319, macOS, model `haiku`. All runs used an isolated herdr session (`bp-spike`,
socket `~/.config/herdr/sessions/bp-spike/herdr.sock`); the default session was never touched.
Code is in `spikes/herdr-claude/` (`herdr-client.ts` is the reusable socket client). Everything was
run twice end to end (the second time after refactoring into the shared helpers); results were
consistent. Timestamps below are from real runs.

Summary: the mechanics work. Everything the implementer stage needs (launch, structured events from
hooks, herdr agent state, follow-up messages, resume, close) worked reliably. The main surprises
are listed under "Open issues": Claude's folder-trust dialog, the user's `auto` permission mode,
`Stop` firing while a background subagent is still running, and a pane vanishing when its process
exits.

## 1. herdr control from Node over the socket

**What I ran.** `spikes/herdr-claude/01-control.ts` (via `herdr-client.ts`): `workspace.create`
(x3, with `cwd` + `label`), `pane.send_input`, `pane.read`, `pane.wait_for_output`, `pane.split`,
`pane.rename`, `pane.list`, `workspace.close`, `pane.close`, then another `workspace.create`.
Wire format: one JSON object per line, `{"id":"…","method":"pane.read","params":{…}}`, answered by
`{"id":"…","result":{…}}` or `{"id":"…","error":{"code","message"}}`.

**Observed.**

- `workspace.create {cwd, label}` returns `workspace`, `tab`, `root_pane` (with `pane_id`, `cwd`,
  `terminal_id`). The label shows up in `workspace.list`. `cwd` is returned real-path resolved
  (`/tmp` became `/private/tmp`), so compare paths after `realpath`.
- IDs are **not renumbered** when others close. Created `w2,w3,w4`, closed the first: list showed
  `w3,w4` with panes `w3:p1,w3:p2,w4:p1` unchanged; closing pane `w3:p2` left the rest as is; the
  next workspace got a fresh ID (never reused; IDs advance like `w9, wA, wB`). The herdr skill text
  says the same ("opaque stable handles", closed IDs not reused). This contradicts the table row in
  section 5.2.1 that says IDs renumber. However IDs do **reset when the server restarts**: a
  fresh server (session deleted and recreated) started again at `w1`..`w7`. So a pane ID is stable
  only for one server lifetime.
- Finding a pane: `pane.list` / `pane.get` return `workspace_id`, `cwd`, `foreground_cwd`,
  `agent`, `agent_status`, `agent_session`, and a `label` when one was set (via `pane.rename` or via
  `layout.apply`'s `label`). The root pane of a `workspace.create` has no label; the workspace has.
  So labelled lookups work: `workspace.list` by label, or `pane.list` by pane label + cwd.
- Running a command: there is no `pane.run` socket method (the CLI's `pane run` is sugar). Use
  `pane.send_input {pane_id, text, keys:["Enter"]}` (text then keys in one call) or `send_text` +
  `send_keys`. `pane.read {source:"recent", lines:N}` returns `{read:{text,truncated,…}}`;
  `pane.wait_for_output {pane_id, source, match:{type:"substring"|"regex",value}, timeout_ms}`
  returned the matched line in about 1 call; `source` is a required field.
- **Shell timing gotcha.** Typing into a freshly created shell pane within ~2.5s of creation
  (my zsh takes several seconds to become interactive) delivered the text as a literal bracketed
  paste that never executed: `╰─ ^[[200~echo hello-from-$(pwd)^[[201~`. Waiting ~6s fixed it. This is
  why launching Claude by typing into a new shell is fragile (see 3).
- `pane.split` takes `{target_pane_id, direction:"right"|"down", cwd, env}` and has no command
  argument.

**Conclusion.** The socket API is a good fit for a `TerminalHost`. Pane IDs are stable within one
server lifetime, so they can be cached in memory but not persisted across a herdr restart; resolve
by workspace label (`bp-<runId>-<stage>`) and cwd each time, as the doc already proposes.

## 2. Headless server

**What I ran.** `spikes/herdr-claude/02-server.ts`, plus manual: `herdr --session bp-spike
workspace list` with no server, `herdr --session bp-spike server` (backgrounded), `herdr session
list`, `herdr --session bp-spike server stop`, `herdr session delete bp-spike`. Note the commands
must run with `HERDR_*` env stripped when launched from inside a herdr pane, or the CLI aborts with
"nested herdr is disabled by default".

**Observed.**

```
$ herdr --session bp-spike workspace list          # no server
{"id":"cli:workspace:list","error":{"code":"server_not_running","message":"no herdr server is running at …/sessions/bp-spike/herdr.sock; run `herdr session attach bp-spike` to start or attach it"}}
raw socket connect -> ENOENT …/sessions/bp-spike/herdr.sock
$ herdr --session bp-spike server                   # headless, no TUI
herdr server running; …  api socket: ~/.config/herdr/sessions/bp-spike/herdr.sock
ping -> {"type":"pong","version":"0.9.5","protocol":22,"capabilities":{…"health_check":true…}}
```

- Named session socket: default is `~/.config/herdr/herdr.sock`; session `NAME` is
  `~/.config/herdr/sessions/NAME/herdr.sock`. `herdr session list` shows running/stopped.
- `ping` works with no TUI attached; all control calls (workspace/pane/layout/events/agent) worked
  against the headless server. Panes run real shells and agents.
- **The CLI does not auto-start a server.** `server_not_running` is returned. A server has to be
  started explicitly with `herdr [--session NAME] server`, which runs in the foreground
  (`herdr-client.ts#ensureServer` spawns it detached with `HERDR_*` stripped and then polls
  `ping`; it came up within the first poll interval). `herdr --session NAME server stop` (or the
  socket method `server.stop`) stops it; panes die with it. `herdr session delete NAME` removes a
  stopped session.
- Does not matter here, but `pong.capabilities.detached_server_daemon` was `false` when I started
  the server from a plain shell with `nohup`, and `true` when started through `ensureServer`'s
  detached spawn. I did not investigate further.

**Conclusion.** Confirmed: the socket belongs to the server, not the UI. block-party must ping and,
if needed, spawn the server itself; the architecture doc's "pings the socket and starts the server
if it isn't running" is right, and the "unconfirmed" item is resolved.

## 3. Launching a real interactive Claude in a pane

**What I ran.** `spikes/herdr-claude/03-claude-run.ts`. Throwaway git repo, per-run
`settings.json` registering `SessionStart, UserPromptSubmit, PostToolUse, SubagentStop,
Notification, Stop, SessionEnd` hooks that run `node spikes/herdr-claude/hook.js <events.jsonl>`
(appends `{ts, payload, env.HERDR_PANE_ID}` per line). Launch command:

```
claude --model haiku --session-id <uuid> --settings <run>/settings.json \
  --agents '{"helper":{"description":…,"prompt":…,"model":"haiku"}}' \
  "Create hello.txt containing hi. Then use the helper subagent to create bye.txt. Then write report.json with {\"status\":\"done\"} and stop."
```

with per-run settings `{"permissions":{"defaultMode":"acceptEdits"}}`.

**How the command got into the pane (important).** Not by typing into a shell. I used
`workspace.create {cwd,label}` followed by `layout.apply {tab_id:<root tab>, root:{type:"pane",
cwd, label, command:["claude", …argv]}}`. `layout.apply` with an existing `tab_id` replaces that
tab's layout, so the pane runs the argv directly (no shell, no quoting problems, no startup-timing
problem), keeps the label, and the workspace contains only that pane. Without `tab_id` it adds a
second tab and leaves the shell tab behind. (`agent.start` is the alternative: it needs a shell
pane at its prompt and waits for readiness, but passes args after `--`; not tested with a real
Claude run.)

**Observed (run 1, trimmed).** Hook timeline, relative to launch at 05:56:51.9:

```
05:56:53.1 SessionStart      {"source":"startup","model":"claude-haiku-5-5","session_id","transcript_path","cwd"}
05:56:54.1 UserPromptSubmit  {"prompt_id","permission_mode":"acceptEdits","prompt":"Create hello.txt …"}
05:56:56.9 PostToolUse       {"tool_name":"Write","tool_input":{…},"tool_response":{"type":"create",…},"tool_use_id","duration_ms":10}
05:56:57.7 PostToolUse       {"tool_name":"Agent","tool_response":{"isAsync":true,"status":"async_launched","agentId":"aa43…"}}
05:56:59.5 Stop              {"stop_hook_active":false,"last_assistant_message":"`hello.txt` is written. The helper subagent is still creatin…",
                              "background_tasks":[{"id":"aa43…","type":"subagent","status":"running","description":"Create bye.txt file","agent_type":"helper"}],"session_crons":[]}
05:56:59.9 PostToolUse       {"agent_id":"aa43…","agent_type":"helper","tool_name":"Write",…}      # tool use inside the subagent
05:57:00.9 SubagentStop      {"agent_id":"a509…","agent_type":"","agent_transcript_path":"…/subagents/agent-a509….jsonl",…}
05:57:01.4 SubagentStop      {"agent_id":"aa43…","agent_type":"helper","last_assistant_message":"/private/tmp/…","agent_transcript_path":"…"}
05:57:01.4 UserPromptSubmit  {"prompt":"<task-notification>\n<task-id>aa43…</task-id>…"}           # harness wakes the main agent
05:57:02.9 PostToolUse       {"tool_name":"Write"}                                                  # report.json
05:57:04.7 Stop              {"last_assistant_message":"All three files are in the working directory…","background_tasks":[],"session_crons":[]}
```

- All six requested hooks fire (plus `UserPromptSubmit`, which I added; it is the clearest proof
  that a message was submitted). Every payload carries `session_id`, `transcript_path`, `cwd`.
- `SubagentStop` fires for the `helper` subagent (with `agent_type:"helper"`, `agent_id`,
  `last_assistant_message`, `agent_transcript_path`). It also fires for an extra internal agent
  with `agent_type:""` (in run 2 its `last_assistant_message` was `cat stamp.txt`, i.e. the
  prompt-suggestion agent). Filter on `agent_type`.
- `PostToolUse` from inside a subagent carries `agent_id` and `agent_type`; main-agent calls do not.
- **`Stop` is per turn, not per task.** Claude launched `helper` in the background
  (`isAsync:true`) even though the prompt did not ask for that, ended its turn (`Stop` #1 with
  `background_tasks` non-empty and no `report.json` yet), and was woken by a
  `<task-notification>` `UserPromptSubmit` which started a second turn that wrote `report.json`
  and produced `Stop` #2 (`background_tasks:[]`). A naive "Stop and no report.json means it gave
  up" rule would have raised a false inbox item. Use `background_tasks.length === 0` as part of
  the idle test.
- Final `Stop` and `SessionEnd` shape:
  `SessionEnd {"reason":"prompt_input_exit"}` after `/exit`; `{"reason":"other"}` when the pane was
  closed. `SessionStart` on resume has `"source":"resume"` plus `seconds_since_last_response`,
  `context_tokens`, `prompt_cache_likely_expired`.
- Output files all present: `hello.txt`, `bye.txt` (written by the `helper` subagent, model haiku),
  `report.json`.
- **First launch in a new directory shows the folder-trust dialog** ("Quick safety check: Is this a
  project you created or one you trust?", options `❯ No, exit` / `Yes, I trust this folder`; the
  default highlighted choice is "No, exit"). No hook fires until it is answered. herdr's
  `agent_status` read `unknown` right after launch; a pane left alone at that dialog was reported as
  `blocked`. The spike script answers it with `send_keys ["Down","Enter"]`
  (`common.ts#acceptTrustDialog`). Trust is recorded per directory in `~/.claude.json`
  (`projects[path].hasTrustDialogAccepted`) and is **inherited by subdirectories**: after trusting
  `run3-repo`, a Claude started in `run3-repo/sub` showed no dialog (`05-send.ts`, check d). The
  user's block-party repo is already trusted, so worktrees created *inside* a trusted repo directory
  would inherit it; worktrees elsewhere will hit the dialog. Side effect of this spike: Claude added
  trust entries for my scratch repos to the user's `~/.claude.json`.

**Conclusion.** Interactive launch with `--session-id`, `--settings` and `--agents` works exactly as
designed in 5.2. Launch via `layout.apply` (argv, no shell). Treat `Stop` as "turn ended" and gate
completion on `background_tasks` being empty plus `report.json`.

## 4. Hook coexistence with the user's herdr hook

**What I ran.** Read-only inspection of `~/.claude/settings.json` (only a `SessionStart` entry,
matcher `^(startup|resume|clear|compact|fork)$`, command
`bash ~/.claude/hooks/herdr-agent-state.sh session`) and of the script. That script only handles
`SessionStart`, requires `HERDR_ENV=1`, `HERDR_SOCKET_PATH` and `HERDR_PANE_ID` (herdr injects these
into every pane), and calls `pane.report_agent_session` with the Claude `session_id` and transcript
path. Then I queried herdr during runs 2 and 3.

**Observed.**

```
pane.get -> "agent":"claude","agent_session":{"agent":"claude","kind":"id","source":"herdr:claude","value":"bd8a6f53-57c0-466e-a136-b956957f48f2"}
```

`value` equals the `--session-id` I passed. So the user's herdr hook ran (it is the only thing
that can set `source:"herdr:claude"`) and the per-run hooks ran for the same `SessionStart`
(`events.jsonl` has the matching `SessionStart` with `HERDR_PANE_ID` in its env, e.g. `wP:p2`). The
per-run `--settings` file adds hooks; it does not replace the user's. No interference seen, and
herdr's session ID matches the one block-party chose.

**Conclusion.** Both fire. block-party's own hooks never need to talk to herdr. Note the herdr hook
is a no-op unless the pane came from herdr, which it does here.

## 5. Agent state via `events.subscribe`

**What I ran.** `03-claude-run.ts` and `04-permission.ts` subscribe on a separate socket
connection. For `pane.agent_status_changed` the subscription requires a `pane_id`
(`{"type":"pane.agent_status_changed","pane_id":"wP:p2"}`) so you can only subscribe after the pane
exists; the global events (`pane.agent_detected`, `pane.exited`, `pane.closed`, `pane.created`) need
no filter. The doc's `pane.agent_state_changed` is not a valid name: herdr rejects it, and the real
name is `pane.agent_status_changed`. Also note pushed events use `"event":"pane.agent_status_changed"`
but `"pane_exited"`, `"pane_closed"`, `"pane_agent_detected"` (underscores) with the payload under
`data`.

**Observed, run 1 (acceptEdits, background subagent):**

```
05:56:52.4 pane_agent_detected   {"agent":"claude"}                  # 0.6s after launch, while on trust dialog
05:56:55.8 working                                                   # UserPromptSubmit hook was 05:56:54.1 (+1.7s)
           (no idle during the first Stop at 05:56:59.5; subagent was still running)
05:57:04.8 idle                                                      # final Stop hook 05:57:04.737 (+77ms)
05:57:05.8 working   (follow-up submitted)
05:57:09.4 idle      (Stop 05:57:09.288)
05:57:10.2 pane_agent_detected {"final_status":"idle","released":true}; pane_exited   # after /exit
```

So `working -> idle` tracks the true end of work better than the first `Stop` did.

**Observed, run 2 (default permission mode, Bash `date > stamp.txt`):**

```
06:02:46.9 UserPromptSubmit hook
06:02:49.2 herdr: blocked          (+2.3s after submit)
06:02:54.9 Notification hook       {"message":"Claude needs your permission","notification_type":"permission_prompt"}   (+5.7s after blocked)
           [script sends Enter -> option "1. Yes"]
06:02:56.1 herdr: working ; 06:02:56.5 PostToolUse(Bash) ; 06:02:57.7 Stop ; 06:02:57.9 herdr: idle
```

The first run of this scenario: blocked 05:59:23.6, Notification 05:59:28.9. Both fired in both runs;
herdr's `blocked` arrived about 5-6s **before** the `Notification` hook (Claude only emits the
notification after a delay). The permission dialog offers `1. Yes`, `2. Yes, and always allow access
to <dir> from this project`, `3. Yes, and switch to auto mode`, `4. No`; plain Enter picks 1.

**Caveat found along the way.** My first attempt did not produce a prompt at all: the footer said
`auto mode on` and Bash ran without asking. The user's global settings put Claude in `auto` mode, which
`--settings` does not override unless you set the mode. Pass `--permission-mode manual` (this
version's name for the default mode; hooks report it as `"permission_mode":"default"`) or
`permissions.defaultMode` in the per-run settings. The permission profile must therefore always be
explicit.

**Conclusion.** herdr state is a useful second signal: `blocked` is faster than `Notification` and
`working/idle` is more accurate than raw `Stop`. Neither replaces `report.json` and git, as the doc
says. Use `Notification` as the durable hook-based record and `blocked` as the early warning.

## 6. Sending a follow-up message

**What I ran.** `03-claude-run.ts` (send_text + Enter after idle) and `05-send.ts` (alternatives).

**Observed.**

- `pane.send_text {text}` then `pane.send_keys {keys:["Enter"]}`, issued as soon as herdr said
  `idle`: `UserPromptSubmit` fired 707 ms later with the exact text; `third.txt` appeared. 2 of 2
  attempts (one per full run) worked.
- `pane.send_input {text, keys:["Enter"]}` (one request): submitted in 208-209 ms (2 runs).
- `agent.prompt {target, text, wait:{timeout_ms}}`: returns after the turn settles (3.3-3.9 s for
  a trivial file write) with the agent info (`agent_status:"idle"`); per herdr's own
  skill text it refuses with `agent_blocked` when a dialog is open (not tested).
- Multi-line text via `send_input` (`"Line one…\nLine two: create f.txt…\nLine three…"`) produced one
  `UserPromptSubmit`, i.e. one message, not three.
- Typing ahead while Claude is `working`: the second message was accepted and queued; both
  appeared as `UserPromptSubmit` events, work finished with a single `Stop`, and both files were
  created. So sending while busy does not corrupt anything, but there's no need to rely on it.
- No timing issue was seen when waiting for `idle` first. The only timing problem is the
  shell-startup one in 1, which does not apply to a pane running Claude directly.

**Conclusion.** Reliable. Recommended: wait for herdr `idle` (and hook-side `background_tasks` empty),
then `agent.prompt` or `send_input`, then confirm with the `UserPromptSubmit` hook (retry once if
not seen within about 5 s).

## 7. Resume

**What I ran.** In `03-claude-run.ts`: `send_text "/exit"` + Enter, wait for `SessionEnd`, then a new
workspace/pane running `claude --model haiku --resume <uuid> --settings … --agents … "<message>"`.
The message asked what had been written to `third.txt` "without looking at the filesystem", then
to create `fourth.txt`.

**Observed.**

- `/exit` -> `SessionEnd {"reason":"prompt_input_exit"}` 0.7 s later; the claude process was gone
  and **the pane and its workspace disappeared** (`pane.list` empty, `workspace.close` returned
  `workspace_not_found`). herdr emitted `pane_agent_detected {released:true}` then `pane_exited`.
- Resume: `SessionStart {"source":"resume","session_id":<same uuid>,"transcript_path":<same file>}`.
  The reply was "I wrote `3` (no trailing newline) to `third.txt`", so the conversation context
  was restored, and `fourth.txt` was created.
- Transcript `~/.claude/projects/<cwd with non-alphanumerics replaced by ->/<uuid>.jsonl` was
  appended, not forked: 98 -> 133 lines (second full run: 108 -> 142). The path in the hook payload
  is exactly this file.
- The resumed pane displays the earlier conversation history in its scrollback.

**Conclusion.** Resume works as designed in 5.2; session ID and transcript path are stable across
resumes, so `events.jsonl` consumers and transcript tailers can key on the session ID.

## 8. Closing

**What I ran.** After the resumed session finished its turn (still interactive and idle), `pane.close`
on its pane, then `pgrep -f <uuid>` after 2 s.

**Observed.** Before: one `claude` PID. After `pane.close`: none (both runs). herdr's server log:
`pane session terminated … signal=Kill` (while `/exit` shows `signal=Hangup`). A `SessionEnd
{"reason":"other"}` hook still fired before the kill. Closing the last pane of a workspace closes
the workspace (the later `workspace.close` returned `workspace_not_found`). Nothing was left
running after the spike (`pgrep` empty; the isolated server was stopped and the session deleted).

**Conclusion.** `pane.close` kills Claude; confirmed. Only close after the stage is finished or
stopped on purpose; for a graceful stop send `/exit` first.

## Recommendations for the Phase 1 TerminalHost / Claude adapter

1. **Client**: grow `spikes/herdr-claude/herdr-client.ts`. Keep a request-per-connection client for
   calls and a dedicated long-lived connection for `events.subscribe`; reconnect and re-subscribe on
   drop. Wrap errors as typed `code`s (`server_not_running`, `workspace_not_found`, `timeout`,
   `agent_blocked`).
2. **Server lifecycle**: `ensureServer()` before every stage; run block-party's herdr under a named
   session (e.g. `block-party`) only if the user wants isolation from their default workspace layout
   (a decision for the doc: default session shows runs in their daily herdr UI, an isolated
   session is invisible unless they run `herdr session attach`). Strip `HERDR_*` env before shelling
   out to the CLI; the socket API needs no such care.
3. **Open a pane** with `workspace.create` (label `bp-<runId>-<stage>`, cwd = worktree) then
   `layout.apply {tab_id, root:{type:"pane", cwd, label, command:[…]}}`. Never type the launch
   command into a shell. Keep `PaneRef` as `{session, workspaceLabel, paneLabel}` and resolve to
   IDs through `workspace.list`/`pane.list` each call; cache IDs only in memory and drop them on
   any `server_not_running`.
4. **Permission mode and trust**: always pass `--permission-mode` (or `permissions.defaultMode` in the
   per-run settings); the user's global default may be `auto`. Handle the trust dialog: either
   create worktrees under a path the user has already trusted (inheritance works), or detect
   `Yes, I trust this folder` in `pane.read` and send `Down, Enter`. Pre-writing
   `~/.claude.json` is not recommended.
5. **Hooks**: a small `block-party hook` writes `{ts, payload}` lines (see `hook.js`, ~25 lines,
   always exit 0). Subscribe to all six events plus `UserPromptSubmit` (cheap confirmation that a
   message landed). Ignore `SubagentStop` with `agent_type===""`. Treat `Stop` as turn end:
   run the report check only when `background_tasks` is empty. Prefer a settle delay of a few
   hundred ms or confirm with herdr `idle` before declaring "stopped without reporting".
6. **Status**: map to `AgentStatus` as: herdr `blocked` -> `waiting_permission` immediately (inbox
   item), `Notification` confirms; herdr `working` -> `running`; herdr `idle` AND last hook `Stop`
   with empty `background_tasks` -> `idle`; pane gone/`pane_exited`/`SessionEnd` -> `exited`.
   `agentState()` should read `pane.get`/`agent.get` (`agent_status`), and subscribe per pane for
   pushes.
7. **send()**: wait for idle, use `agent.prompt` (or `send_input` text + Enter), and verify with the
   `UserPromptSubmit` hook within ~5 s, retry once. Keep messages short pointers to files.
8. **resume()**: launch the same way with `claude --resume <sessionId> <message>` plus the same
   `--settings`/`--agents`. Record `transcript_path` from `SessionStart` rather than computing it.
9. **stop()**: graceful = send `/exit` then wait for `SessionEnd`; force = `pane.close`. Expect the
   workspace to disappear when its last pane exits, so capture final output (`pane.read`) or rely on
   the transcript before the process ends.
10. **Reconciliation on restart**: `server_not_running` or an empty `pane.list` means every pane is
    gone (the server restart case); IDs restart from `w1`, so never match old IDs.

## Open issues

- **Pane disappears on process exit.** The workspace closes as soon as Claude exits, so a crash's
  last screen is lost. Possible fix (not tested): run `claude` under `sh -c 'claude …; read'` or
  similar wrapper so the pane survives, then close it deliberately; or tail the transcript.
- **`agent.start` untested** with a real Claude run (it may handle readiness/trust better than raw
  launch). Worth a half-day in Phase 1.
- **Trust dialog** answer relies on matching English dialog text; worth guarding with a timeout and an
  inbox item.
- **Permission mode name** (`manual` vs hook-reported `default`) and `--agents` behaviour (the
  subagent ran in the background unprompted) may change between Claude Code versions; pin versions in
  contract tests.
- **herdr event naming is inconsistent** (`pane.agent_status_changed` vs `pane_exited`), and some
  documentation names are wrong (`pane.agent_state_changed`). Keep parsing in one adapter and test
  against a recorded transcript.
- **Not tested:** a herdr server crash mid-run, `Esc`/interrupt via `send_keys`, a `Notification`
  for idle ("waiting for input") rather than permission, remote/ssh machines, very long
  `send_text` payloads, running two Claude panes at once, Codex panes.
- The first full run of the numbering test happened alongside leaked workspaces from my own failed
  attempts; they were all closed, but it is why workspace IDs in the log start above `w1`.
- Side effects outside the repo: trust entries for the scratch repos in `~/.claude.json`, session
  transcripts under `~/.claude/projects/` for those paths. Nothing in user settings was edited.
