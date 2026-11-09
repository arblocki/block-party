import { randomUUID as nodeRandomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { worktreesRoot } from '../run/paths.js';
import { HerdrError } from '../terminal/herdr-client.js';
import type { PaneRef, TerminalHost } from '../terminal/types.js';
import { scrubbedEnv } from './claude-headless.js';
import { readHookEvents, waitForTurnEnd, type HookWatcher } from './hook-events.js';
import type {
  ImplementerAdapter,
  ImplementerSession,
  ImplementerStartInput,
  TurnOutcome,
} from './types.js';

export interface PaneClaudeTiming {
  /** Passed to waitForTurnEnd. */
  settleMs?: number;
  pollMs?: number;
  /** Cadence of the trust-dialog / hook-event polling loops. */
  loopMs?: number;
  trustMaxMs?: number;
  idlePollMs?: number;
  idleMaxMs?: number;
  confirmMs?: number;
  stopWaitMs?: number;
}

export interface PaneClaudeOptions {
  host: TerminalHost;
  /** Creates a watcher over `eventsPath` that only emits events after byte `fromOffset`. */
  watcherFactory: (eventsPath: string, fromOffset: number) => HookWatcher;
  randomUUID?: () => string;
  claudeBin: string;
  now?: () => number;
  onEvent?: (event: { type: string; data: Record<string, unknown> }) => void;
  timing?: PaneClaudeTiming;
}

const MAX_MESSAGE_CHARS = 2000;

interface SessionState {
  pane: PaneRef;
  runId: string;
  runDir: string;
  eventsPath: string;
  resumes: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function fileSize(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

async function real(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return path.resolve(p);
  }
}

async function isInside(child: string, root: string): Promise<boolean> {
  const rel = path.relative(await real(root), await real(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function stringEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(scrubbedEnv())) if (v !== undefined) out[k] = v;
  return out;
}

export function createPaneClaude(opts: PaneClaudeOptions): ImplementerAdapter {
  const { host, claudeBin } = opts;
  const uuid = opts.randomUUID ?? nodeRandomUUID;
  const now = opts.now ?? Date.now;
  const t = {
    settleMs: opts.timing?.settleMs,
    pollMs: opts.timing?.pollMs,
    loopMs: opts.timing?.loopMs ?? 250,
    trustMaxMs: opts.timing?.trustMaxMs ?? 20_000,
    idlePollMs: opts.timing?.idlePollMs ?? 500,
    idleMaxMs: opts.timing?.idleMaxMs ?? 60_000,
    confirmMs: opts.timing?.confirmMs ?? 5_000,
    stopWaitMs: opts.timing?.stopWaitMs ?? 10_000,
  };
  const emit = (type: string, data: Record<string, unknown>) => opts.onEvent?.({ type, data });
  const sessions = new Map<string, SessionState>();

  function flags(input: ImplementerStartInput): string[] {
    return [
      '--model',
      input.model,
      '--permission-mode',
      input.permissionMode,
      '--settings',
      input.settingsPath,
      '--agents',
      input.agentsPath,
      ...(input.allowedTools.length ? ['--allowedTools', ...input.allowedTools] : []),
      ...(input.disallowedTools.length ? ['--disallowedTools', ...input.disallowedTools] : []),
    ];
  }

  async function alive(pane: PaneRef): Promise<boolean> {
    try {
      return await host.isAlive(pane);
    } catch (e) {
      if (
        e instanceof HerdrError &&
        (e.code === 'pane_not_found' || e.code === 'server_not_running')
      )
        return false;
      throw e;
    }
  }

  function hasEvent(eventsPath: string, offset: number, sessionId: string, name: string): boolean {
    return readHookEvents(eventsPath, offset).events.some(
      (e) => e.session_id === sessionId && e.hook_event_name === name,
    );
  }

  async function waitEvent(
    eventsPath: string,
    offset: number,
    sessionId: string,
    name: string,
    maxMs: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const deadline = now() + maxMs;
    for (;;) {
      if (hasEvent(eventsPath, offset, sessionId, name)) return true;
      if (now() >= deadline || signal?.aborted) return false;
      await sleep(t.loopMs);
    }
  }

  /** Launches a pane, deals with the folder-trust dialog, and waits for the turn to end. */
  async function launch(
    st: SessionState | undefined,
    input: ImplementerStartInput,
    sessionId: string,
    label: string,
    sessionArgs: string[],
    prompt: string,
  ): Promise<{ pane: PaneRef; outcome: TurnOutcome }> {
    const offset = fileSize(input.eventsPath);
    const pane = await host.open({
      label,
      cwd: input.cwd,
      argv: [claudeBin, ...sessionArgs, ...flags(input), '--', prompt],
      env: stringEnv(),
    });
    if (st) st.pane = pane;
    emit('agent.pane_opened', { label, sessionId });

    const deadline = now() + t.trustMaxMs;
    let answered = false;
    while (!hasEvent(input.eventsPath, offset, sessionId, 'SessionStart')) {
      if (now() >= deadline || input.signal?.aborted) break;
      if (!answered) {
        let text = '';
        try {
          text = await host.read(pane, 40);
        } catch {
          // diagnostics only
        }
        if (text.includes('trust this folder')) {
          if (!(await isInside(input.cwd, worktreesRoot()))) {
            return { pane, outcome: { kind: 'permission', message: 'folder trust dialog' } };
          }
          await host.sendKeys(pane, ['Down', 'Enter']);
          answered = true;
          emit('agent.trust_dialog_accepted', { cwd: input.cwd, sessionId });
        }
      }
      await sleep(t.loopMs);
    }

    const watcher = opts.watcherFactory(input.eventsPath, offset);
    const outcome = await waitForTurnEnd({
      watcher,
      sessionId,
      reportPath: input.reportPath,
      agentState: () => host.agentState(pane),
      settleMs: t.settleMs,
      pollMs: t.pollMs,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    });
    return { pane, outcome };
  }

  async function waitIdle(pane: PaneRef, signal?: AbortSignal): Promise<boolean> {
    const deadline = now() + t.idleMaxMs;
    for (;;) {
      if ((await host.agentState(pane)) === 'idle') return true;
      if (now() >= deadline || signal?.aborted) return false;
      await sleep(t.idlePollMs);
    }
  }

  async function saveFinal(st: SessionState): Promise<void> {
    try {
      const text = await host.read(st.pane, 200);
      const dir = path.join(st.runDir, 'agent');
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'pane-final.txt'), text);
    } catch {
      // pane already gone or unreadable; nothing to save
    }
  }

  return {
    async start(input) {
      const sessionId = uuid();
      const label = `bp-${input.runId}-impl`;
      const st: SessionState = {
        pane: { session: '', label, cwd: input.cwd },
        runId: input.runId,
        runDir: input.runDir,
        eventsPath: input.eventsPath,
        resumes: 1,
      };
      const { pane, outcome } = await launch(
        st,
        input,
        sessionId,
        label,
        ['--session-id', sessionId],
        input.prompt,
      );
      st.pane = pane;
      sessions.set(sessionId, st);
      const session: ImplementerSession = {
        mode: 'pane',
        sessionId,
        cwd: input.cwd,
        paneLabel: pane.label,
      };
      return { session, outcome };
    },

    async send(session, input, message) {
      if (message.length > MAX_MESSAGE_CHARS) {
        throw new Error(
          `message too long for a pane (${message.length} > ${MAX_MESSAGE_CHARS} chars); send a pointer to a file`,
        );
      }
      let st = sessions.get(session.sessionId);
      if (!st) {
        st = {
          pane: {
            session: '',
            label: session.paneLabel ?? `bp-${input.runId}-impl`,
            cwd: session.cwd,
          },
          runId: input.runId,
          runDir: input.runDir,
          eventsPath: input.eventsPath,
          resumes: 1,
        };
        sessions.set(session.sessionId, st);
      } else {
        st.runDir = input.runDir;
        st.eventsPath = input.eventsPath;
      }

      if (!(await alive(st.pane))) {
        st.resumes += 1;
        const label = `bp-${st.runId}-impl-r${st.resumes}`;
        const { outcome } = await launch(
          st,
          input,
          session.sessionId,
          label,
          ['--resume', session.sessionId],
          message,
        );
        session.paneLabel = label;
        return outcome;
      }

      const pane = st.pane;
      if (!(await waitIdle(pane, input.signal))) return { kind: 'timeout' };
      const offset = fileSize(input.eventsPath);
      let submitted = false;
      for (let attempt = 0; attempt < 2 && !submitted; attempt++) {
        await host.sendText(pane, message, { submit: true });
        submitted = await waitEvent(
          input.eventsPath,
          offset,
          session.sessionId,
          'UserPromptSubmit',
          t.confirmMs,
          input.signal,
        );
        if (!submitted) emit('agent.send_unconfirmed', { attempt: attempt + 1 });
      }
      if (!submitted) {
        return { kind: 'no_report', detail: 'message not confirmed by UserPromptSubmit hook' };
      }
      return waitForTurnEnd({
        watcher: opts.watcherFactory(input.eventsPath, offset),
        sessionId: session.sessionId,
        reportPath: input.reportPath,
        agentState: () => host.agentState(pane),
        settleMs: t.settleMs,
        pollMs: t.pollMs,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
      });
    },

    async stop(session, stopOpts) {
      const st = sessions.get(session.sessionId);
      if (!st) return;
      const { pane } = st;
      await saveFinal(st);
      let ended = false;
      if (!stopOpts?.force && (await alive(pane))) {
        const offset = fileSize(st.eventsPath);
        try {
          await host.sendText(pane, '/exit', { submit: true });
          ended = await waitEvent(
            st.eventsPath,
            offset,
            session.sessionId,
            'SessionEnd',
            t.stopWaitMs,
          );
        } catch {
          ended = false;
        }
      }
      if (ended && !(await alive(pane))) return;
      if (await alive(pane)) await saveFinal(st);
      try {
        await host.close(pane);
      } catch (e) {
        if (!(e instanceof HerdrError && e.code === 'pane_not_found')) throw e;
      }
    },

    describe(session) {
      const st = sessions.get(session.sessionId);
      if (!st) return `claude --resume ${session.sessionId}`;
      return `${host.attachCommand(st.pane)} (workspace ${session.paneLabel ?? st.pane.label})`;
    },
  };
}
