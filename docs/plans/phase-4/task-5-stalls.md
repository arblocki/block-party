# Stall detection and auto-nudges

## Goal

An agent that goes quiet is noticed in minutes, not hours. It gets one gentle nudge, and if
that doesn't help, an inbox item. No LLM is involved in the detection (ARCHITECTURE 5.6
"Stall detection", Phase 4).

## Context

- The recorder (`src/core/run/recorder.ts`) turns hook lines from `events.jsonl` into
  `run_events`. The pane adapter tails them (`src/core/agents/hook-events.ts`).
- With herdr, `pane.agent_status_changed` events report `idle` / `working` / `blocked`
  (`src/core/terminal/herdr.ts`, `herdr-client.ts`). A `blocked` state already raises the
  permission inbox item. Check, and add it if it doesn't.
- `ImplementerAdapter.send(session, message)` types a message into an idle pane, or resumes.
- The headless adapter streams JSON events (`claude-stream.ts`).
- Turns wait in `turnEnded`/`judgeTurn` in `pipeline.ts`.

## Approach

1. **Policy**:
   - `policy.stallAfterMinutes` (default 10): the time with no hook, transcript or stream
     event during a turn.
   - `policy.idleNudgeMinutes` (default 3): herdr says `idle`, no `Stop` with an empty
     `background_tasks` arrived, and no report.
   - `policy.maxNudges` (default 1) per turn.
2. **Watcher** `createStallWatcher({ now, setTimer, policy, onNudge, onStall })` in
   `src/core/run/stall.ts`:
   - `activity()` resets the timer, `agentState(s)` tracks the herdr state, and `stop()`
     clears it.
   - A pure, timer-injected module, so tests use a fake clock.
3. **Wiring.**
   - During every implementer, fixer and planner turn, the pipeline creates a watcher. It
     feeds `activity()` from recorder events and stream events, and `agentState` from herdr.
   - On the first trigger, while nudges remain, it sends the nudge with `adapter.send`:
     "Status check from block-party: if you're finished, write the report at <path>. If
     you're stuck or need a decision, say so in one line and stop." It records
     `implementer.nudged { reason, minutes }`.
   - On the next trigger, it opens a `stalled` decision. The title is "Agent may be stuck",
     the body has the reason, the last event time and the attach command. Options: `nudge`
     ("Nudge again"), `wait` ("Keep waiting"), `stop` ("Stop the run → blocked"). The run
     stays in its stage, so the turn continues while I decide.
   - Any new activity closes an open `stalled` decision automatically (resolved, note "the
     agent resumed").
   - Headless runs use only the silence timer. A nudge there is a resume with the message
     after interrupting, or just the inbox item if the process is still running. Decide in
     the implementation and record it in the report.
4. **UI**:
   - `summarizeEvent` covers `implementer.nudged` and `stalled`.
   - The run view's activity header shows "Last activity 4 min ago", updated every 30 s.

## Acceptance criteria

- [ ] Fake clock: silence past `stallAfterMinutes` → one nudge. More silence → the `stalled`
      decision. Activity in between resets the timer (`stall.test.ts`).
- [ ] herdr `idle` with no report past `idleNudgeMinutes` → nudge (`stall.test.ts`).
- [ ] Pipeline with a fake adapter that goes silent:
  - the nudge message reaches `adapter.send`;
  - the decision opens;
  - `stop` blocks the run;
  - activity after the decision resolves it (`pipeline.test.ts`).
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` and `pnpm build` pass.

## Out of scope

- LLM-based progress judgement. Stall detection for the reviewer (it has its own timeout).
