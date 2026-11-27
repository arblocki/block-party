import { isTerminal, type RunStage } from '../../core/run/machine';
import type { RunEvent } from '../types';

/** Which agent's terminal the run view can show, and the command to watch it from elsewhere. */
export interface LiveSession {
  role: 'planner' | 'implementer';
  /** The copy-and-paste command recorded for the session; the fallback when embedding fails. */
  attach: string | null;
}

/**
 * The session the Terminal panel shows: the planner's while the run is planning, otherwise the
 * implementer's. Only a session that runs in a terminal ("pane" mode) counts, and not for a
 * finished run. The server makes the final call (the agent may have stopped).
 */
export function liveSession(stage: RunStage, events: readonly RunEvent[]): LiveSession | null {
  if (isTerminal(stage)) return null;
  const type = stage === 'planning' ? 'planner.session' : 'implementer.session';
  let last: { mode: unknown; attach: unknown } | null = null;
  for (const e of events) {
    if (e.type !== type) continue;
    const p = (e.payload ?? {}) as { mode?: unknown; attach?: unknown };
    last = { mode: p.mode, attach: p.attach };
  }
  if (!last || last.mode !== 'pane') return null;
  return {
    role: stage === 'planning' ? 'planner' : 'implementer',
    attach: typeof last.attach === 'string' ? last.attach : null,
  };
}

/** The WebSocket address of a run's terminal, on the same host and scheme as the page. */
export function terminalSocketUrl(runId: string, loc: { protocol: string; host: string }): string {
  const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${loc.host}/api/runs/${encodeURIComponent(runId)}/terminal`;
}

/** The control message that tells the server the terminal's new size. */
export function resizeFrame(cols: number, rows: number): string {
  return JSON.stringify({ type: 'resize', cols, rows });
}

export interface CloseNotice {
  /** `ended` is a normal end; `unavailable` means the embedded terminal can't be used. */
  kind: 'ended' | 'unavailable';
  message: string;
}

/** What to tell the person when the socket closes, from its close code and reason. */
export function closeNotice(code: number, reason: string, opened: boolean): CloseNotice {
  const why = reason.trim();
  if (code === 1000) return { kind: 'ended', message: 'The terminal session ended.' };
  if (code === 1001) return { kind: 'ended', message: 'Disconnected: block-party is stopping.' };
  if (code === 4408) {
    return { kind: 'ended', message: 'Disconnected after 30 minutes without activity.' };
  }
  if (code === 4501 || code === 4404 || code === 4429 || code === 4500) {
    const text = why || 'it could not be started';
    return {
      kind: 'unavailable',
      message: text.startsWith('Embedded terminal unavailable')
        ? text
        : `Embedded terminal unavailable: ${text}`,
    };
  }
  return opened
    ? { kind: 'ended', message: 'The connection to the terminal was lost.' }
    : {
        kind: 'unavailable',
        message:
          'Embedded terminal unavailable: could not connect. Reload the page and sign in again if this keeps happening.',
      };
}

/** The colours the terminal uses, read from the app's CSS variables so it follows the theme. */
export function terminalTheme(read: (name: string) => string): {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
} {
  const v = (name: string, fallback: string) => read(name).trim() || fallback;
  return {
    background: v('--color-code-bg', '#0c1011'),
    foreground: v('--color-text', '#eff5f2'),
    cursor: v('--color-accent', '#69d5bc'),
    cursorAccent: v('--color-code-bg', '#0c1011'),
    selectionBackground: v('--color-accent-soft', '#203e37'),
  };
}
