# Embedded terminal in the run view

## Goal

The run view can show the live agent's terminal, and I can type into it, without copying an
attach command into another window (ARCHITECTURE 5.2 "Attach", 8 "Run view", Phase 4).

## Context

- Pane sessions record an attach command (`implementer.session` event `attach`;
  `ClaudePaneAdapter.attachCommand`; herdr `attachCommand(pane)` in
  `src/core/terminal/herdr.ts`). It is shown with a copy button in `RunView.tsx`.
- Server: Hono on Node (`src/server/index.ts`, `app.ts`). The token guard and Host/Origin
  guard live in `src/server/security.ts`.
- New dependencies are allowed for this task only: `node-pty` (server), `@xterm/xterm` and
  `@xterm/addon-fit` (web), plus `ws` or `@hono/node-ws` for the upgrade. Pick the one that
  fits the existing Node server wiring and say why in the report. `node-pty` is native.
  Make sure `pnpm install` builds it (pnpm `onlyBuiltDependencies` if needed) and the
  server still starts if it fails to load, with the terminal panel showing "Embedded
  terminal unavailable: <reason>" and the copy-attach fallback.

## Approach

1. **Server** `src/server/terminal.ts`:
   - WebSocket at `GET /api/runs/:id/terminal`.
   - Auth: the session token, sent the same way as the SSE endpoints (cookie or query
     token, whichever SSE uses), and the same Host/Origin checks. Reject otherwise.
   - It looks up the run and its latest pane session, and refuses runs that are headless or
     have no live pane (`4404` close code with a reason).
   - It spawns the attach command **built on the server** from the recorded pane
     label/session through the terminal host adapter (`attachArgv(pane): string[]`, added to
     `TerminalHost`). It never uses a string from the client, never uses a shell, and the
     argv is exec'd by `node-pty`. The pane's cwd is the run's worktree, and the env goes
     through task 4's `agentEnv` scrub.
   - Messages: binary or text frames are terminal data in both directions. A JSON control
     frame `{ type: 'resize', cols, rows }` is validated (1–500).
   - On socket close it kills the pty. That detaches the viewer only: the herdr pane and
     the agent keep running (verify with herdr's attach semantics).
   - Limits: at most 2 terminals per run and 8 total. Idle sockets are closed after 30 min
     without input or output.
2. **Web** `src/web/components/RunTerminal.tsx`:
   - xterm with the fit addon, sized to its container, and the theme from the app's CSS
     variables in light and dark.
   - Lazy-loaded (`import()`), so the review page bundle doesn't grow.
   - Run view: a "Terminal" tab or collapsible panel next to Activity, only for pane runs
     with a live session. "Open terminal" connects. A banner says "You're typing into the
     agent's session. It sees what you type."
   - "Disconnect" closes the socket. Reconnect is manual.
   - The copy-attach command stays as the fallback.
3. **Docs**: a Security section note (ARCHITECTURE 9) on the endpoint and its argv rule.

## Acceptance criteria

- [ ] The WebSocket rejects a missing token, a foreign Origin, an unknown run, a headless
      run, and a run with no live pane (`terminal.test.ts` with a fake pty factory and a fake
      terminal host).
- [ ] The spawned argv comes from `attachArgv` for the run's pane. A client message can't
      change it, and a resize frame outside 1–500 is ignored (`terminal.test.ts`).
- [ ] Closing the socket kills the pty and not the pane (fake host records no `close`).
- [ ] The server starts when `node-pty` fails to load, and the panel shows the fallback
      (test with an injected loader).
- [ ] In a browser, a live run's terminal shows the Claude session, and a typed message
      reaches it. [browser]
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` and `pnpm build` pass.

## Out of scope

- Terminals for headless runs, the reviewer, or arbitrary shells in the worktree.
