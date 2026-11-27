import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import {
  closeNotice,
  resizeFrame,
  terminalSocketUrl,
  terminalTheme,
  type CloseNotice,
} from '../lib/terminal';

type Phase = 'connecting' | 'connected' | 'closed';

const readCssVar = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name);

/**
 * The live agent terminal: xterm.js on a WebSocket to the server, which attaches a terminal
 * to the agent's session. This file is loaded on demand so xterm stays out of the main bundle.
 * `onClosed` reports why the connection ended, so the panel can offer the fallback.
 */
export default function RunTerminal({
  runId,
  role,
  onClosed,
}: {
  runId: string;
  role: 'planner' | 'implementer';
  onClosed: (notice: CloseNotice) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const userClosed = useRef(false);
  const [phase, setPhase] = useState<Phase>('connecting');
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    userClosed.current = false;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: readCssVar('--font-mono') || 'monospace',
      fontSize: 13,
      theme: terminalTheme(readCssVar),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    const refit = () => {
      try {
        fit.fit();
      } catch {
        // The container may be hidden or not laid out yet.
      }
    };
    refit();

    const ws = new WebSocket(terminalSocketUrl(runId, window.location));
    ws.binaryType = 'arraybuffer';
    socketRef.current = ws;
    let opened = false;
    const send = (data: string | Uint8Array<ArrayBuffer>) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    };
    ws.onopen = () => {
      opened = true;
      setPhase('connected');
      send(resizeFrame(term.cols, term.rows));
      term.focus();
    };
    ws.onmessage = (e: MessageEvent<string | ArrayBuffer>) => {
      term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
    };
    ws.onclose = (e) => {
      setPhase('closed');
      onClosedRef.current(
        userClosed.current
          ? { kind: 'ended', message: 'Disconnected. The agent is still running.' }
          : closeNotice(e.code, e.reason, opened),
      );
    };
    const encoder = new TextEncoder();
    const input = term.onData((d) => send(encoder.encode(d)));
    const resized = term.onResize(({ cols, rows }) => send(resizeFrame(cols, rows)));
    const observer = new ResizeObserver(refit);
    observer.observe(el);
    const themeWatch = new MutationObserver(() => {
      term.options.theme = terminalTheme(readCssVar);
    });
    themeWatch.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    return () => {
      userClosed.current = true;
      ws.onclose = null;
      ws.close(1000);
      socketRef.current = null;
      input.dispose();
      resized.dispose();
      observer.disconnect();
      themeWatch.disconnect();
      term.dispose();
    };
  }, [runId]);

  return (
    <div>
      <p className="mb-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
        You&apos;re typing into the {role} for this run. It sees what you type. Opening this may
        resize the session to fit this window.
      </p>
      <div className="mb-2 flex items-center gap-3 text-sm text-muted">
        <span role="status">
          {phase === 'connecting' ? 'Connecting…' : phase === 'connected' ? 'Connected' : 'Closed'}
        </span>
        <span className="flex-1" />
        {phase !== 'closed' && (
          <button
            type="button"
            className="rounded-md border border-line px-2 py-0.5 text-xs hover:bg-surface-hover"
            onClick={() => {
              userClosed.current = true;
              socketRef.current?.close(1000);
            }}
          >
            Disconnect
          </button>
        )}
      </div>
      <div
        ref={host}
        className="h-96 overflow-hidden rounded-md border border-line bg-code-bg p-2"
        aria-label="Agent terminal"
      />
    </div>
  );
}
