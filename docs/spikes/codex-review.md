# Spike: how the reviewer stage invokes Codex

Decides ARCHITECTURE 5.2 "Codex adapter (reviewer)": option 1 `codex review --base <sha>` vs option 2
`codex exec --json --output-schema findings.schema.json -s read-only "<prompt>"`.
codex-cli 0.162.1. Artifacts: `spikes/codex-review/` (`findings.schema.json`, `review-prompt.md`,
`findings.ts` zod + parsers, `run.ts` runner).

## What I ran

Throwaway detached worktree at `b7490b3` ("Default to codex-cli and make LLM analysis opt-in (#11)"),
base = first parent `d37a3cd`. Codex ran with cwd = the worktree; the worktree was clean afterwards
(no writes). Worktree removed, no branches created.

- Option 1a: `codex review --base d37a3cd` (the top-level command).
- Option 1b: `codex exec review --ignore-user-config --ephemeral --json --base d37a3cd -o last.txt`.
- Option 2: `codex exec --sandbox read-only --ignore-user-config --ephemeral --json --output-schema findings.schema.json --output-last-message last.txt -` with `review-prompt.md` (placeholders filled) on stdin. Reproduce with
  `npx tsx spikes/codex-review/run.ts --repo <worktree> --base <sha> --head <sha> --option both --out <dir>`.
- Extra targets: `f5195e2` (small real fix), and a synthetic commit on top of `b7490b3` that
  adds `src/server/lookup.ts` with string-interpolated SQL against a nonexistent schema, to confirm
  each option can produce findings at all.

## Observed

CLI surface (from `--help`):

| | `codex review` | `codex exec review` | `codex exec` |
|---|---|---|---|
| `--base` / `--commit` / `--uncommitted` | yes | yes | no |
| `--json` | no | yes | yes |
| `--ignore-user-config` | no (rejected: "unexpected argument") | yes | yes |
| `-s/--sandbox` | no | no | yes |
| `-m/--model` | no (only `-c model=...`) | yes | yes |
| `--output-schema` | no | listed in help | yes |
| `-o` last message | no | yes (worked) | yes |
| custom prompt with `--base` | n/a | rejected: "--base cannot be used with [PROMPT]" | n/a |

Option 1 on `b7490b3` (no findings):

```
$ codex exec review --ignore-user-config --ephemeral --json --base d37a3cd   # 19 s, exit 0
{"type":"item.completed","item":{"type":"agent_message","text":"The changes consistently make analysis opt-in, ... No actionable regressions were identified in the diff."}}
{"type":"turn.completed","usage":{"input_tokens":0,"cached_input_tokens":0,...,"output_tokens":0}}
```

Usage reported as all zeros in review mode. The review itself ran `cat ~/.agents/skills/review/SKILL.md`
even with `--ignore-user-config`: user skills still leak into the context.

Bare `codex review --base d37a3cd` (no way to ignore user config): 196 s, exit 0, prose with one
finding, different from the quiet run above:

```
- [P2] Preserve Analyze clicks when committing a model edit — <abs worktree path>/src/web/components/AnalysisBar.tsx:101-103
  On an uncached PR, editing the model and clicking Analyze first triggers the input's `onBlur`, which calls `setChoice` and starts a cache-only lookup. ...
```

Option 2 on `b7490b3`, three runs: 18.9 s, 16.5 s, 18.3 s, all exit 0, all schema-valid, all
`findings: []` (summary "No concrete regressions found ..."). Each run is ~13 events, ~170k input
tokens (~130k cached), ~400 output tokens. Event stream:

```
thread.started, turn.started,
item.completed{agent_message "I'll inspect the diff ..."},      # progress narration
item.started/completed{command_execution "git diff d37a3cd..b7490b3"} x N,
item.completed{agent_message "<final JSON>"},
turn.completed{usage:{input_tokens,cached_input_tokens,output_tokens,reasoning_output_tokens}}
```

Option 2 on the synthetic bad commit (24.6 s), parsed by zod without error:

```json
{"reviewedSha":"c51c995f...","summary":"The new cache helpers use an incompatible database/schema and interpolate arguments into SQL.",
 "findings":[
  {"id":"f_1","severity":"P1","category":"correctness","title":"Use the existing store and its actual analysis schema",
   "location":{"path":"src/server/lookup.ts","startLine":3,"endLine":7},"confidence":"high","suggestedFix":"Implement these operations through the existing initialized store ..."},
  {"id":"f_2","severity":"P2","category":"security","title":"Bind the lookup key instead of interpolating SQL",
   "location":{"path":"src/server/lookup.ts","startLine":7,"endLine":7},"confidence":"high", ...}]}
```

Option 1 (`exec review`) on the same commit (32.7 s) found the same issues as prose: three
`- [P2] Title — /abs/path/lookup.ts:7-7` bullets plus a free-text intro. A regex pick-up
(`normalizeProseReview`) recovered severity, title, path, start line, but not body, category,
confidence, suggestedFix, and the paths are absolute (worktree-prefixed) and would need rewriting.
It looks regular but is undocumented format; severities were all P2 even for an injection plus a
runtime crash, versus P1/P2 from option 2.

Spot checks:
- Option 1's P2 on `AnalysisBar.tsx:101-103`: the lines exist as quoted (`disabled={loading || checking}` on the Analyze button, input `onBlur={applyModel}`), and the described mechanism (blur starts a cache check that disables the button) is plausible but I did not reproduce the race in a browser. Treat as plausible, unconfirmed.
- Option 2's f_1/f_2 on the synthetic commit: both correct (I wrote the bug; `cache.db`/`key`/`created` do not match the real schema, and the SQL is interpolated). It did not flag `deleteOld`'s interpolated `days` (typed `number`, so arguably fine).
- Option 2 returned empty on `b7490b3` three times and on `f5195e2` once; option 1 returned empty on `f5195e2` and on one of two runs of `b7490b3`. So the "does it find real subtle bugs" question is unsettled: with N=1 real positive from option 1 (long, 196 s run that also executed tests) and 0 from option 2, I cannot claim either is better at depth. Option 2 only ran about 5 shell commands (diff plus cat of touched files) in 17 s; a prompt that tells it to run tests/typecheck would trade time for depth.

Failure modes observed:
- Strict schema violation (property missing from `required`): the run fails fast with `{"type":"error",...invalid_json_schema "'schema.required' is required to include every key in properties. Missing 'b'"}` then `turn.failed`, no retry loop. The schema must list every property in `required` and set `additionalProperties:false` on every object; optional = nullable. `findings.schema.json` follows this and was accepted.
- `codex exec ... "prompt"` with stdin attached to a terminal/pipe that never closes prints "Reading additional input from stdin..." and hangs. Always pass the prompt on stdin with `-` and close it (`run.ts` does).
- `--output-schema` constrains the model API response format, but nothing guarantees correct semantics (SHA, line numbers). The zod parser additionally checks `reviewedSha` equals the expected head and each finding matches it.
- Invalid JSON / schema mismatch from the model did not occur in 7 option-2 runs; `parseReviewerOutput` handles it (returns `{ok:false,error}` formatted for a retry prompt). Not exercised against a real bad model output.
- Nonzero exit was not observed outside the bad-schema test. `exec review` and `exec` both exit 0 with `turn.completed`; a failed turn emits `turn.failed` (check that, not just exit code).

## Comparison

| | 1: `codex review` / `exec review` | 2: `codex exec --output-schema` |
|---|---|---|
| Wall time (b7490b3) | 19 s (exec review), 196 s (bare review; loads user config, ran tests) | 16-19 s |
| Output | prose; findings as `- [P2] Title — path:a-b` bullets (informal) | schema-valid JSON, 3/3 and 1/1 other runs |
| Machine-parseable without LLM | partly; regex gets severity/title/location only; empty-vs-clean ambiguity | yes (zod) |
| Inject plan / prior findings / rulings | no (custom prompt rejected with `--base`; `--commit`/`--uncommitted` untested for prompt) | yes, free-form |
| Read-only sandbox | not selectable on either review command (default observed read-only-like; no writes in my runs, but unverified as a guarantee) | explicit `-s read-only` |
| Ignore user config | only `exec review`; bare `review` hangs/slow with user MCP | `--ignore-user-config` |
| Model selection | `exec review -m`; bare via `-c` | `-m` |
| Progress events | `exec review --json`: same item stream; usage all zeros | item stream with real usage |
| Finding quality | found the injection and schema issues on synthetic; 1 plausible P2 on real (196 s run) | found the same on synthetic with correct P1/P2 and exact ranges; 0 on real change, 3 runs |
| Failure mode | prose may be unparseable; no schema | `turn.failed` on bad schema; invalid output caught by zod, retry once |

## Decision

Use option 2. The decisive factors are structural: it is the only option that accepts the plan,
acceptance criteria, and prior findings/rulings (required by the 3.3 loop), it yields the finding
schema directly with a deterministic parser and no extraction LLM call, and it has an explicit
read-only sandbox and `--ignore-user-config`. Option 1 would need either an extraction call
or a regex over an undocumented prose format, and cannot carry rulings (so it would re-raise
disputed findings). Finding quality was not shown to favour option 1 in this small sample.

## Recommendations for the Phase 1 reviewer adapter

1. Command: `codex exec --sandbox read-only --ignore-user-config --ephemeral --json --output-schema <findings.schema.json> --output-last-message <tmp> [-m model] -` with the rendered prompt on stdin, cwd = run worktree at `head_sha`. Mirror `src/core/llm/codex-cli.ts` (cap detection via `exec --help`, MCP-noise stripping on errors).
2. Read the final message from `-o` file, fall back to the last `agent_message` event (`lastAgentMessage` in `findings.ts`). Validate with `parseReviewerOutput(text, headSha)`.
3. On `ok:false`: one retry that resumes/re-asks with the error string, then fail the stage. Treat `turn.failed` or missing `turn.completed` as failure; do not rely on exit code alone. Never accept an empty parse as "clean" without a successful `turn.completed`.
4. Progress UI: map `item.started` `command_execution` to "running `<cmd>`" lines and `agent_message` to narration; `turn.completed.usage` for cost.
5. Schema rules: every property in `required`, `additionalProperties:false`, nullable instead of optional. Add schema/zod parity test (zod `toJSONSchema` vs the file) so they cannot drift. Fill `{{PRIOR_FINDINGS}}` with id, title, location, resolution/ruling.
6. Prompt: consider adding "run the project's typecheck/tests if cheap" as a knob; the default run is shallow (about 5 commands).
7. Normalize `location.path` to repo-relative; validate it exists in the worktree and lines are in range before showing in the UI.
8. Timeout at ~5 min; `run.ts` has none yet.

## Open issues

- Quality sample is tiny (1 real change plus 1 synthetic). Need an eval over several past PRs with known issues before trusting "no findings" (all three real-change option-2 runs and the `f5195e2` run were empty).
- Whether `--ignore-user-config` is sufficient: user skills under `~/.agents/skills` were still read by codex. Consider a dedicated `CODEX_HOME` with only `auth.json`.
- `exec review` has no `-s`; I could not confirm what sandbox it uses (no writes seen). Moot if option 2 is used.
- Retry-with-error path (invalid JSON from the model) is unit-level only; not observed live.
- `finding.id` uniqueness across rounds is not enforced by the model (always `f_1...`); the adapter must re-mint stable ids.
- `-o` flag worked with `exec review`; I did not test `--output-schema` with `exec review`.
- `--commit`/`--uncommitted` with a custom prompt not tested.
