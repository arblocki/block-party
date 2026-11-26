import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, openStream } from '../api';
import { orderRuns, runProject } from '../lib/home';
import { NEW_RUN_HREF, prHref, relativeTime, runHref } from '../lib/route';
import type { InboxDecision, RunSummary } from '../types';
import { sectionHeading, TopBar } from './AppShell';
import { DecisionItem } from './DecisionItem';
import { listClass } from './PickerShell';
import { StageBadge } from './StageBadge';

function RunRow({ run }: { run: RunSummary }) {
  const project = runProject(run);
  const repoLabel = project ? `${project.owner}/${project.repo}` : null;
  return (
    <li className="relative px-3 py-2.5 hover:bg-surface-hover">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <a href={runHref(run.id)} className="font-medium after:absolute after:inset-0">
          {run.title}
        </a>
        <StageBadge stage={run.stage} />
        {run.openDecisions > 0 && (
          <span className="text-xs text-warning">
            {run.openDecisions} open decision{run.openDecisions === 1 ? '' : 's'}
          </span>
        )}
        <span className="flex-1" />
        <span className="text-xs text-muted" title={run.updatedAt}>
          {relativeTime(run.updatedAt)}
        </span>
      </div>
      <div className="mt-0.5 flex flex-wrap gap-x-3 text-sm text-muted">
        {repoLabel && <span>{repoLabel}</span>}
        {run.stageNote && <span>{run.stageNote}</span>}
        {project && run.prNumber !== null && (
          <a
            href={prHref(project, run.prNumber)}
            className="relative z-10 text-accent hover:underline"
          >
            PR #{run.prNumber}
          </a>
        )}
      </div>
    </li>
  );
}

/** Runs and the decision inbox, loaded once and then kept live by `/api/stream`. */
export function Home() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [inbox, setInbox] = useState<InboxDecision[] | null>(null);
  const [openCount, setOpenCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Once the stream has spoken, a slower initial response must not overwrite it.
  const fullFetch = useRef(0);
  const streamed = useRef({ runs: false, inbox: false });

  const load = useCallback(() => {
    setError(null);
    api<{ runs: RunSummary[] }>('/api/runs').then(
      (r) => {
        if (!streamed.current.runs) setRuns(r.runs);
      },
      (e: Error) => setError(e.message),
    );
    api<{ decisions: InboxDecision[] }>('/api/inbox').then(
      (r) => {
        if (streamed.current.inbox) return;
        setInbox(r.decisions);
        setOpenCount(r.decisions.length);
      },
      (e: Error) => setError(e.message),
    );
  }, []);

  useEffect(() => {
    load();
    const ctrl = new AbortController();
    void openStream(
      '/api/stream',
      (msg) => {
        if (msg.event === 'runs') {
          const data = JSON.parse(msg.data) as { runs: RunSummary[] };
          streamed.current.runs = true;
          setRuns(data.runs);
          setError(null);
        } else if (msg.event === 'inbox') {
          const data = JSON.parse(msg.data) as { openCount: number; decisions: InboxDecision[] };
          streamed.current.inbox = true;
          setInbox(data.decisions);
          setOpenCount(data.openCount);
          setError(null);
          // Any frame supersedes a full fetch still in flight.
          const seq = ++fullFetch.current;
          // The frame carries only the newest decisions; fetch the rest.
          if (data.openCount > data.decisions.length) {
            api<{ decisions: InboxDecision[] }>('/api/inbox').then(
              (r) => {
                if (seq === fullFetch.current) setInbox(r.decisions);
              },
              () => {},
            );
          }
        }
      },
      ctrl.signal,
    );
    return () => ctrl.abort();
  }, [load]);

  useEffect(() => {
    document.title = openCount > 0 ? `(${openCount}) block-party` : 'block-party';
    return () => {
      document.title = 'block-party';
    };
  }, [openCount]);

  const ordered = useMemo(() => orderRuns(runs ?? []), [runs]);

  const dismiss = (id: number) => {
    api<{ changed: boolean }>(`/api/inbox/${id}/dismiss`, { method: 'POST' }).then(
      () => {
        setInbox((cur) => (cur ?? []).filter((d) => d.id !== id));
        setOpenCount((n) => Math.max(0, n - 1));
      },
      (e: Error) => setError(e.message),
    );
  };

  const decisions = [...(inbox ?? [])].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id - a.id,
  );

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <TopBar />
      {error && (
        <p role="alert" className="mb-3 rounded-md bg-error-soft px-3 py-2 text-sm text-error">
          {error}{' '}
          <button type="button" className="underline" onClick={load}>
            Retry
          </button>
        </p>
      )}
      <section className="mb-8" aria-labelledby="needs-you">
        <h2 id="needs-you" className={sectionHeading}>
          Needs you
        </h2>
        {inbox === null ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : decisions.length === 0 ? (
          <p className="rounded-md border border-line px-3 py-3 text-sm text-muted">
            Nothing needs you.
          </p>
        ) : (
          <ul className={listClass}>
            {decisions.map((d) => (
              <DecisionItem key={d.id} d={d} onDismiss={() => dismiss(d.id)} />
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="runs">
        <h2 id="runs" className={sectionHeading}>
          Runs
        </h2>
        {runs === null ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : ordered.length === 0 ? (
          <p className="rounded-md border border-line px-3 py-3 text-sm text-muted">
            No runs yet. Start one with{' '}
            <a href={NEW_RUN_HREF} className="text-accent hover:underline">
              New run
            </a>
            .
          </p>
        ) : (
          <ul className={listClass}>
            {ordered.map((r) => (
              <RunRow key={r.id} run={r} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
