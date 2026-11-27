import { useEffect, useMemo, useRef, useState } from 'react';
import { api, jsonBody } from '../api';
import { defaultVersion, lineDiff, planActions, plannerAttach } from '../lib/plans';
import type { PlanVersion, RunDecision, RunDetail, RunEvent } from '../types';
import { AttachCommand } from './AttachCommand';
import { headingText, sectionHeading } from './AppShell';

const NOTE_MAX = 4000;

const STATUS_LABEL: Record<PlanVersion['status'], string> = {
  draft: 'draft',
  approved: 'approved',
  superseded: 'superseded',
};

const versionLabel = (p: PlanVersion): string =>
  `v${p.version} - ${STATUS_LABEL[p.status]}, ${p.createdBy === 'me' ? 'you' : 'planner'}`;

const DIFF_CLASS = {
  same: '',
  add: 'bg-success-soft text-success',
  del: 'bg-error-soft text-error',
} as const;
const DIFF_MARK = { same: ' ', add: '+', del: '-' } as const;

/** Approve, or request changes with a required note, on the open plan_approval decision. */
function ApprovalControls({
  decision,
  version,
  onChanged,
}: {
  decision: RunDecision;
  version: number;
  onChanged(): void;
}) {
  const [reviseOpen, setReviseOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (choice: 'approve' | 'revise') => {
    setBusy(true);
    setError(null);
    api<{ decision: RunDecision }>(`/api/inbox/${decision.id}/answer`, {
      method: 'POST',
      ...jsonBody({ choice, ...(choice === 'revise' ? { note: note.trim() } : {}) }),
    }).then(
      () => {
        setBusy(false);
        onChanged();
      },
      (e: Error) => {
        // A 409 reopens the decision, so the page reloads to show it.
        setBusy(false);
        setError(e.message);
        onChanged();
      },
    );
  };

  const options = decision.options ?? [];
  const label = (id: string, fallback: string) =>
    options.find((o) => o.id === id)?.label ?? fallback;

  return (
    <div className="mt-3 border-t border-line pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          className="rounded-md bg-accent px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
          onClick={() => submit('approve')}
        >
          {label('approve', 'Approve')} v{version}
        </button>
        <button
          type="button"
          disabled={busy}
          aria-expanded={reviseOpen}
          className="rounded-md border border-line px-3 py-1 text-sm hover:bg-surface-hover disabled:opacity-50"
          onClick={() => setReviseOpen((o) => !o)}
        >
          {label('revise', 'Request changes')}
        </button>
      </div>
      {reviseOpen && (
        <div className="mt-2">
          <label htmlFor="plan-feedback" className="mb-1 block text-sm font-medium">
            What should change? (required)
          </label>
          <textarea
            id="plan-feedback"
            value={note}
            maxLength={NOTE_MAX}
            rows={4}
            disabled={busy}
            onChange={(e) => setNote(e.target.value)}
            className="w-full rounded-md border border-line bg-surface px-2 py-1 text-sm"
          />
          <button
            type="button"
            disabled={busy || note.trim() === ''}
            className="mt-2 rounded-md bg-accent px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
            onClick={() => submit('revise')}
          >
            {busy ? 'Sending…' : 'Send to the planner'}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-error">
          {error}
        </p>
      )}
    </div>
  );
}

/** Whether the panel renders approval controls for the run (see `planActions`). */
export const panelHasControls = (plans: PlanVersion[] | null, open: RunDecision | null): boolean =>
  open !== null && plans !== null && plans.length > 0;

/** Every plan version of a run, the changes between them, and the approval buttons. */
export function PlanPanel({
  run,
  decisions,
  plans,
  error,
  events,
  onChanged,
}: {
  run: RunDetail;
  decisions: RunDecision[];
  plans: PlanVersion[];
  error: string | null;
  events: RunEvent[];
  onChanged(): void;
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const latest = plans.at(-1) ?? null;
  const fallback = defaultVersion(plans);
  // Follows the default until the person picks a version; a new version becomes the default.
  const lastLatest = useRef<number | null>(null);
  useEffect(() => {
    if (latest && latest.version !== lastLatest.current) {
      lastLatest.current = latest.version;
      setPicked(null);
    }
  }, [latest?.version]);
  const selectedVersion =
    picked !== null && plans.some((p) => p.version === picked) ? picked : fallback;
  const selected = plans.find((p) => p.version === selectedVersion) ?? null;
  const previous = selected
    ? (plans.find((p) => p.version === selected.version - 1) ?? null)
    : null;
  const readable =
    selected !== null && previous !== null && selected.text !== null && previous.text !== null;
  const diff = useMemo(
    () => (showDiff && readable ? lineDiff(previous.text!, selected.text!) : null),
    [showDiff, readable, selected, previous],
  );
  const open = planActions(run, decisions);
  const planning = run.stage === 'planning';
  const attach = plannerAttach(events);

  return (
    <section className="mb-8" aria-labelledby="plan">
      <h2 id="plan" className={sectionHeading}>
        Plan
      </h2>
      {planning && (
        <div
          className="mb-3 rounded-md border border-info bg-info-soft px-3 py-2 text-sm"
          role="status"
        >
          <p className="text-info">The planner is writing v{(latest?.version ?? 0) + 1}…</p>
          {attach && <AttachCommand command={attach} />}
        </div>
      )}
      {error && <p className="text-sm text-muted">The plans could not be loaded: {error}</p>}
      {!selected ? (
        !error &&
        !planning && <p className="text-sm text-muted">This run has no plan versions yet.</p>
      ) : (
        <div className="rounded-md border border-line px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="plan-version" className="text-sm text-muted">
              Version
            </label>
            <select
              id="plan-version"
              value={selected.version}
              onChange={(e) => setPicked(Number(e.target.value))}
              className="rounded-md border border-line bg-surface px-2 py-1 text-sm"
            >
              {plans.map((p) => (
                <option key={p.version} value={p.version}>
                  {versionLabel(p)}
                </option>
              ))}
            </select>
            {previous && (
              <button
                type="button"
                className="text-sm text-accent hover:underline"
                aria-expanded={showDiff}
                onClick={() => setShowDiff((s) => !s)}
              >
                Changes from v{previous.version}
              </button>
            )}
          </div>
          <p className="mt-2 font-medium">{selected.title}</p>
          {selected.feedback && (
            <div className="mt-2 rounded-md bg-surface-elevated px-2 py-1.5 text-sm">
              <p className={headingText}>Feedback that produced v{selected.version}</p>
              <p className="whitespace-pre-wrap">{selected.feedback}</p>
            </div>
          )}
          {selected.acceptanceCriteria.length > 0 && (
            <>
              <p className={`mt-3 ${headingText}`}>Acceptance criteria</p>
              <ul className="list-disc space-y-0.5 pl-5 text-sm">
                {selected.acceptanceCriteria.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </>
          )}
          {showDiff && previous && (
            <div className="mt-3">
              {diff ? (
                <pre
                  className="max-h-96 overflow-auto rounded-md bg-code-bg p-2 font-mono text-xs"
                  aria-label={`Changes from v${previous.version} to v${selected.version}`}
                >
                  {diff.map((l, i) => (
                    <div key={i} className={`whitespace-pre-wrap ${DIFF_CLASS[l.kind]}`}>
                      {DIFF_MARK[l.kind]} {l.text}
                    </div>
                  ))}
                </pre>
              ) : (
                <p className="text-sm text-muted">
                  {readable
                    ? 'These versions are too large to diff here.'
                    : 'One of these versions cannot be read.'}
                </p>
              )}
            </div>
          )}
          {selected.text === null ? (
            <p className="mt-3 text-sm text-muted">The text of this version could not be read.</p>
          ) : (
            <pre className="mt-3 max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-md bg-code-bg p-2 font-mono text-xs">
              {selected.text}
            </pre>
          )}
          {open && latest && (
            <ApprovalControls
              key={open.id}
              decision={open}
              version={latest.version}
              onChanged={onChanged}
            />
          )}
          {open && latest && selected.version !== latest.version && (
            <p className="mt-1 text-xs text-muted">
              The buttons answer for v{latest.version}, the latest version.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
