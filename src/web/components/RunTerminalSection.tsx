import { lazy, Suspense, useState } from 'react';
import type { RunStage } from '../../core/run/machine';
import { liveSession, type CloseNotice } from '../lib/terminal';
import type { RunEvent } from '../types';
import { AttachCommand } from './AttachCommand';
import { headingText } from './AppShell';

// xterm is large; it loads only when someone opens the terminal.
const RunTerminal = lazy(() => import('./RunTerminal'));

/**
 * "Terminal" panel of the run view: watch and type into the live agent from the browser.
 * Only shown for runs whose agent runs in a terminal. The copy-and-paste command stays as the
 * fallback whenever the embedded terminal is closed or unavailable.
 */
export function RunTerminalSection({
  runId,
  stage,
  events,
}: {
  runId: string;
  stage: RunStage;
  events: readonly RunEvent[];
}) {
  const live = liveSession(stage, events);
  // Bumped on every "Open terminal" so a reopened terminal starts fresh.
  const [session, setSession] = useState<number | null>(null);
  const [notice, setNotice] = useState<CloseNotice | null>(null);
  if (!live) return null;
  const who = live.role === 'planner' ? 'planner' : 'agent';
  return (
    <section className="mb-8" aria-labelledby="terminal">
      <div className="mb-2 flex items-baseline gap-3">
        <h2 id="terminal" className={headingText}>
          Terminal
        </h2>
      </div>
      {session === null ? (
        <div>
          {notice && (
            <p
              role={notice.kind === 'unavailable' ? 'alert' : 'status'}
              className={`mb-2 rounded-md px-3 py-2 text-sm ${
                notice.kind === 'unavailable' ? 'bg-error-soft text-error' : 'bg-surface text-muted'
              }`}
            >
              {notice.message}
            </p>
          )}
          <button
            type="button"
            className="rounded-md border border-line px-3 py-1 text-sm hover:bg-surface-hover"
            onClick={() => {
              setNotice(null);
              setSession((s) => (s ?? 0) + 1);
            }}
          >
            {notice?.kind === 'ended' ? 'Reconnect' : 'Open terminal'}
          </button>
          <span className="ml-2 text-sm text-muted">Watch the {who} live and type to it.</span>
          {live.attach && <AttachCommand command={live.attach} />}
        </div>
      ) : (
        <Suspense fallback={<p className="text-sm text-muted">Loading terminal…</p>}>
          <RunTerminal
            key={session}
            runId={runId}
            onClosed={(n) => {
              setNotice(n);
              setSession(null);
            }}
          />
        </Suspense>
      )}
    </section>
  );
}
