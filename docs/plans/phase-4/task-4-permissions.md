# Stronger permission profiles and optional sandbox

## Goal

Agents can do their job without prompts. They can't run arbitrary programs through a broad
allow rule, can't change their own rulings, and never see secrets. Claude Code's sandbox can
be turned on per project (ARCHITECTURE 9 and 13 "Implementer permissions" open question).

## Context

- `src/core/agents/claude-config.ts` builds per-role settings:
  - the implementer `allowedTools` include `Bash(node:*)`, `Bash(find:*)`, `Bash(cat:*)`,
    `Bash(ls:*)`, `Bash(grep:*)`, `Bash(head:*)`, `Bash(tail:*)`, `Bash(wc:*)`, git
    read/commit rules, `pnpm install --frozen-lockfile`, and one `Bash(<check>:*)` per
    check command;
  - `disallowedTools` lists push, curl, wget, `rm -rf`, `pnpm add`, `npm install` and `gh`;
  - the planner has no Bash (`plannerPermissions`).
- Known gap: `inputs/rulings.json` is written by the pipeline (`triage-loop.ts`) and read by
  the implementer and reviewer, but it sits in a directory the agent can edit.
- Agent environment: check what `claude-pane.ts` and `claude-headless.ts` pass as `env`.
  `GITHUB_TOKEN`, `GH_TOKEN` and the block-party session token must not reach agents.
- `.block-party.yaml` `run:` section is parsed by `src/core/run/config.ts`.

## Approach

1. **Implementer profile.** Remove the rules that allow arbitrary execution or reading
   outside the worktree:
   - Remove `Bash(node:*)` (it runs any script) and `Bash(find:*)` (`-exec`/`-delete`).
   - `cat`, `ls`, `grep`, `head`, `tail` and `wc` stay. They read but don't execute, and
     reads outside the worktree are governed by the file-tool rules. Add explicit
     `Read(<worktree>/**)` and `Edit(<worktree>/**)` allows, plus a `Read(~/.ssh/**)`,
     `Read(~/.aws/**)` and `Read(~/.config/gh/**)` deny.
   - Check commands are allowed **exactly**: `Bash(<cmd>)` and `Bash(<cmd> *)` for
     arguments, not a bare prefix rule that would allow `<cmd>; anything`. Verify how
     Claude Code matches `Bash(x:*)` against compound commands. Claude Code already splits
     on `&&`/`;` per its docs; confirm from the docs or a spike and record the finding in the
     report.
   - Git: keep `status`, `diff`, `log`, `show`, `rev-parse`, `add` and `commit`. Deny
     `git push`, `git config`, `git remote`, `git reset --hard`, `git clean`, `git checkout
     --` and `git worktree`.
   - Project extras: `.block-party.yaml` `run.permissions.allow: string[]` and
     `deny: string[]`, validated as Claude Code permission rule strings. They're appended,
     and deny wins.
2. **Reviewer**: unchanged (codex read-only sandbox). Verify it and note it in the report.
3. **Rulings are not agent-writable.**
   - Rulings get a DB home: a `rulings` table or `run_state` JSON. `triage-loop.ts` writes
     them there.
   - Before every implementer turn and review round, the pipeline regenerates
     `inputs/rulings.json` from the DB.
   - Deny `Edit`/`Write` on `<runDir>/inputs/**` in the implementer profile as
     defense-in-depth.
4. **Environment scrubbing.**
   - `agentEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv` in
     `src/core/agents/env.ts` drops `GITHUB_TOKEN`, `GH_TOKEN`, `GH_ENTERPRISE_TOKEN`,
     `BLOCK_PARTY_*` secrets (keep `BLOCK_PARTY_RUN_ID` and anything the hook needs), and
     `*_API_KEY` except `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` when an adapter needs them.
   - Used by pane and headless Claude and codex. herdr panes inherit herdr's env, so pass
     the scrubbed env explicitly in `layout.apply`, or document the limitation if herdr
     can't do it.
5. **Optional sandbox.** `policy.sandbox: 'off' | 'on'` (default `off`). `on` adds Claude
   Code's sandbox settings to the run settings file (`sandbox.enabled: true`, network
   limited to the package registry hosts the setup command needs). Confirm the exact
   setting names from Claude Code's docs, and put the link in the report. The run view's
   header shows "Sandboxed" when on.

## Acceptance criteria

- [ ] The implementer settings contain no `Bash(node:*)` or `Bash(find:*)`. Check commands
      are exact. The project's `allow`/`deny` extras are applied with deny winning
      (`claude-config.test.ts`).
- [ ] An agent edit to `inputs/rulings.json` between turns is overwritten from the DB before
      the next turn and the reviewer (`pipeline.test.ts`).
- [ ] `agentEnv` drops tokens and keeps PATH/HOME and the hook's variables (`env.test.ts`),
      and both Claude adapters use it (adapter tests).
- [ ] `policy.sandbox: on` writes the sandbox settings (`claude-config.test.ts`).
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` and `pnpm build` pass.

## Out of scope

- Containers, VMs, or macOS `sandbox-exec` profiles of our own.
