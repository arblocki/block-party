import { useCallback, useEffect, useRef, useState } from 'react';
import { isResting, isTerminal } from '../../core/run/machine';
import { api, openStream } from '../api';
import { runProject } from '../lib/home';
import { prHref, relativeTime } from '../lib/route';
import { isNoisyEvent, stageStrip, summarizeEvent, type StripState } from '../lib/runView';
import type {
  ReviewRound,
  RunDetailResponse,
  RunEvent,
  RunFindings,
  RunPlan,
  StageRow,
} from '../types';
import { headingText, linkButton, sectionHeading, TopBar } from './AppShell';
import { DecisionItem } from './DecisionItem';
import { listClass } from './PickerShell';
import { EvidenceSection, PlanSection } from './RunEvidence';
import { StageBadge } from './StageBadge';

const EVENT_PAGE = 2000;
/** Run-event types after which stage rows or decisions have likely changed. */
const REFETCH_TYPES = new Set([
  'stage',
  'checks.result',
  'review.result',
  'pr',
  'publish.stopped',
  'run.interrupted',
  'question',
]);

const STRIP_CLASS: Record<StripState, string> = {
  pending: 'border-line text-muted',
  skipped: 'border-line text-muted opacity-60',
  running: 'border-info bg-info-soft text-info',
  done: 'border-success bg-success-soft text-success',
  failed: 'border-error bg-error-soft text-error',
  blocked: 'border-error bg-error-soft text-error',
  cancelled: 'border-line bg-surface-elevated text-muted',
  stopped: 'border-line bg-surface-elevated text-muted',
};

const clock = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour12: false });
};

/** Review and review-fix executions, so the findings are refetched when one changes. */
const reviewSignature = (stages: StageRow[]): string =>
  stages
    .filter((s) => s.kind === 'review' || s.kind === 'review-fix')
    .map((s) => `${s.id}:${s.state}`)
    .join(',');

function Strip({ detail }: { detail: RunDetailResponse }) {
  const items = stageStrip(detail.stages, detail.run);
  return (
    <ol className="mb-6 flex flex-wrap gap-2" aria-label="Stages">
      {items.map((i) => (
        <li
          key={i.key}
          className={`rounded-md border px-2.5 py-1 text-sm ${STRIP_CLASS[i.state]}`}
          data-state={i.state}
        >
          <span className="font-medium">{i.label}</span>{' '}
          <span className="text-xs">
            {i.state}
            {i.count > 1 ? ` x${i.count}` : ''}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Activity({ events }: { events: RunEvent[] }) {
  const [showAgent, setShowAgent] = useState(false);
  const noisy = events.filter((e) => isNoisyEvent(e.type)).length;
  const shown = showAgent ? events : events.filter((e) => !isNoisyEvent(e.type));
  return (
    <section className="mb-8" aria-labelledby="activity">
      <div className="mb-2 flex items-baseline gap-3">
        <h2 id="activity" className={headingText}>
          Activity
        </h2>
        <span className="flex-1" />
        {noisy > 0 && (
          <button
            type="button"
            className="text-sm text-accent hover:underline"
            aria-expanded={showAgent}
            onClick={() => setShowAgent((s) => !s)}
          >
            {showAgent ? 'Hide' : 'Show'} {noisy} agent event{noisy === 1 ? '' : 's'}
          </button>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="rounded-md border border-line px-3 py-3 text-sm text-muted">
          No activity yet.
        </p>
      ) : (
        <ol className={listClass}>
          {shown.map((e) => (
            <li
              key={e.id}
              className={`flex flex-wrap items-baseline gap-x-3 px-3 py-1 text-sm ${isNoisyEvent(e.type) ? 'text-muted' : ''}`}
            >
              <time className="font-mono text-xs text-muted" dateTime={e.ts} title={e.ts}>
                {clock(e.ts)}
              </time>
              <span className="font-mono text-xs text-muted">{e.type}</span>
              <span className="min-w-0 break-words">{summarizeEvent(e)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** One run in full: loaded once, then kept live by the run's event stream. */
export function RunView({ id }: { id: string }) {
  const [detail, setDetail] = useState<RunDetailResponse | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [plan, setPlan] = useState<RunPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [rounds, setRounds] = useState<ReviewRound[] | null>(null);
  const [findingsError, setFindingsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelNote, setCancelNote] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const refetchRef = useRef<() => void>(() => {});
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    const alive = () => !ctrl.signal.aborted;
    let lastEventId = 0;
    let signature: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // A response older than the newest request must not overwrite a newer one.
    let findingsSeq = 0;
    let detailSeq = 0;

    const loadFindings = () => {
      const seq = ++findingsSeq;
      return api<RunFindings>(`/api/runs/${id}/findings`).then(
        (f) => {
          if (!alive() || seq !== findingsSeq) return;
          setRounds(f.rounds);
          setFindingsError(null);
        },
        (e: Error) => alive() && seq === findingsSeq && setFindingsError(e.message),
      );
    };

    const loadDetail = () => {
      const seq = ++detailSeq;
      return api<RunDetailResponse>(`/api/runs/${id}`).then(
        (d) => {
          if (!alive() || seq !== detailSeq) return;
          setDetail(d);
          setError(null);
          const sig = reviewSignature(d.stages);
          if (sig !== signature) {
            signature = sig;
            void loadFindings();
          }
        },
        (e: Error) => alive() && seq === detailSeq && setError(e.message),
      );
    };

    // Several triggers close together (a stage frame and a run frame) cost one fetch.
    refetchRef.current = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void loadDetail(), 100);
    };

    const start = async () => {
      setError(null);
      try {
        const seq = ++detailSeq;
        const first = await api<RunDetailResponse>(`/api/runs/${id}`);
        if (!alive()) return;
        if (seq === detailSeq) setDetail(first);
        signature = reviewSignature(first.stages);
        void loadFindings();
        api<RunPlan>(`/api/runs/${id}/plan`).then(
          (p) => {
            if (!alive()) return;
            setPlan(p);
            setPlanError(null);
          },
          (e: Error) => alive() && setPlanError(e.message),
        );
        const all: RunEvent[] = [];
        for (;;) {
          const page = await api<{ events: RunEvent[]; lastId: number }>(
            `/api/runs/${id}/events?after=${lastEventId}&limit=${EVENT_PAGE}`,
          );
          all.push(...page.events);
          lastEventId = page.lastId;
          if (page.events.length < EVENT_PAGE) break;
        }
        if (!alive()) return;
        setEvents(all);
      } catch (e) {
        if (alive()) setError((e as Error).message);
        return;
      }
      // Resumes after the loaded events, so none is missed or repeated.
      void openStream(
        `/api/runs/${id}/stream?after=${lastEventId}`,
        (msg) => {
          if (msg.event === 'run-event') {
            const ev = JSON.parse(msg.data) as RunEvent;
            if (ev.id <= lastEventId) return;
            lastEventId = ev.id;
            setEvents((cur) => [...cur, ev]);
            if (REFETCH_TYPES.has(ev.type)) refetchRef.current();
          } else if (msg.event === 'run') {
            refetchRef.current();
          }
        },
        ctrl.signal,
      );
    };
    void start();

    return () => {
      ctrl.abort();
      clearTimeout(timer);
      refetchRef.current = () => {};
    };
  }, [id, reloadKey]);

  const run = detail?.run;
  useEffect(() => {
    if (!run) return;
    document.title = `${run.title} - block-party`;
    return () => {
      document.title = 'block-party';
    };
  }, [run?.title]);

  const dismiss = useCallback((decisionId: number) => {
    api<{ changed: boolean }>(`/api/inbox/${decisionId}/dismiss`, { method: 'POST' }).then(
      () => refetchRef.current(),
      (e: Error) => setError(e.message),
    );
  }, []);

  const cancel = () => {
    setCancelling(true);
    setCancelNote(null);
    api<{ cancelled: boolean }>(`/api/runs/${id}/cancel`, { method: 'POST' }).then(
      (r) => {
        setCancelling(false);
        if (!r.cancelled) {
          setCancelNote('This run is not running in this server, so it cannot be cancelled here.');
        }
        refetchRef.current();
      },
      (e: Error) => {
        setCancelling(false);
        setError(e.message);
      },
    );
  };

  if (!detail || !run) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-6">
        <TopBar />
        {error ? (
          <p role="alert" className="rounded-md bg-error-soft px-3 py-2 text-sm text-error">
            {error}{' '}
            <button type="button" className="underline" onClick={() => setReloadKey((k) => k + 1)}>
              Retry
            </button>
          </p>
        ) : (
          <p className="text-muted">Loading…</p>
        )}
      </div>
    );
  }

  const project = runProject(run);
  const open = detail.decisions.filter((d) => d.status === 'open');
  const answered = detail.decisions.filter((d) => d.status === 'answered' && d.options !== null);

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <TopBar />
      {error && (
        <p role="alert" className="mb-3 rounded-md bg-error-soft px-3 py-2 text-sm text-error">
          {error}{' '}
          <button type="button" className="underline" onClick={() => setReloadKey((k) => k + 1)}>
            Retry
          </button>
        </p>
      )}
      <header className="mb-5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-xl font-semibold">{run.title}</h1>
          <StageBadge stage={run.stage} />
          <span className="flex-1" />
          {!isTerminal(run.stage) && !isResting(run.stage) && (
            <button type="button" className={linkButton} disabled={cancelling} onClick={cancel}>
              {cancelling ? 'Cancelling…' : 'Cancel run'}
            </button>
          )}
        </div>
        {run.stageNote && <p className="mt-1 text-sm text-muted">{run.stageNote}</p>}
        {cancelNote && <p className="mt-1 text-sm text-warning">{cancelNote}</p>}
        <div className="mt-1 flex flex-wrap gap-x-3 text-sm text-muted">
          {project && (
            <span>
              {project.owner}/{project.repo}
            </span>
          )}
          <span className="font-mono text-xs">{run.branch}</span>
          {project && run.prNumber !== null && (
            <a href={prHref(project, run.prNumber)} className="text-accent hover:underline">
              PR #{run.prNumber}
            </a>
          )}
          <span title={run.createdAt}>created {relativeTime(run.createdAt)}</span>
          <span title={run.updatedAt}>updated {relativeTime(run.updatedAt)}</span>
        </div>
      </header>
      <Strip detail={detail} />
      {open.length > 0 && (
        <section className="mb-8" aria-labelledby="needs-you">
          <h2 id="needs-you" className={sectionHeading}>
            Needs you
          </h2>
          <ul className={listClass}>
            {open.map((d) => (
              <DecisionItem
                key={d.id}
                d={d}
                hideRunLink
                onDismiss={() => dismiss(d.id)}
                onAnswered={() => refetchRef.current()}
              />
            ))}
          </ul>
        </section>
      )}
      {answered.length > 0 && (
        <section className="mb-8" aria-labelledby="answered">
          <h2 id="answered" className={sectionHeading}>
            Answered
          </h2>
          <ul className={listClass}>
            {answered.map((d) => (
              <DecisionItem key={d.id} d={d} hideRunLink onDismiss={() => dismiss(d.id)} />
            ))}
          </ul>
        </section>
      )}
      <PlanSection plan={plan} error={planError} />
      <EvidenceSection stages={detail.stages} rounds={rounds} findingsError={findingsError} />
      <Activity events={events} />
    </div>
  );
}
