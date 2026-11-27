import { useState } from 'react';
import { findingHistory } from '../lib/findings';
import { checksBySha } from '../lib/runView';
import type { AcceptanceItem, ReviewFinding, ReviewRound, RunPlan, StageRow } from '../types';
import { sectionHeading } from './AppShell';
import { listClass } from './PickerShell';

export const SEVERITY_CLASS: Record<ReviewFinding['severity'], string> = {
  P0: 'bg-error-soft text-error',
  P1: 'bg-error-soft text-error',
  P2: 'bg-warning-soft text-warning',
  P3: 'bg-surface-elevated text-muted',
};

const short = (sha: string): string => sha.slice(0, 7);

/** The plan's title and acceptance criteria, with the full text behind a toggle. */
export function PlanSection({
  plan,
  error,
  planning = false,
  attach = null,
}: {
  plan: RunPlan | null;
  error: string | null;
  /** The run is in setup or planning: no plan exists yet, which is not an error. */
  planning?: boolean;
  attach?: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="mb-8" aria-labelledby="plan">
      <h2 id="plan" className={sectionHeading}>
        Plan
      </h2>
      {!plan && planning ? (
        <div className="rounded-md border border-info bg-info-soft px-3 py-2 text-sm" role="status">
          <p className="text-info">The planner is writing the plan…</p>
          {attach && <p className="mt-1 text-muted">To watch it work, run this in a terminal:</p>}
          {attach && (
            <code className="mt-1 block overflow-x-auto rounded-md bg-code-bg px-2 py-1 font-mono text-xs">
              {attach}
            </code>
          )}
        </div>
      ) : error ? (
        <p className="text-sm text-muted">The plan could not be loaded: {error}</p>
      ) : !plan ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <div className="rounded-md border border-line px-3 py-2.5">
          <p className="font-medium">{plan.title}</p>
          {plan.acceptanceCriteria.length > 0 && (
            <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-sm">
              {plan.acceptanceCriteria.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className="mt-2 text-sm text-accent hover:underline"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? 'Hide plan text' : 'Show plan text'}
          </button>
          {open && (
            <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-code-bg p-2 font-mono text-xs">
              {plan.text}
            </pre>
          )}
        </div>
      )}
    </section>
  );
}

const ACCEPTANCE_LABEL: Record<AcceptanceItem['status'], string> = {
  met: 'met',
  not_met: 'not met',
  unsure: 'unsure',
  unverified: 'unverified',
};

const ACCEPTANCE_CLASS: Record<AcceptanceItem['status'], string> = {
  met: 'bg-success-soft text-success',
  not_met: 'bg-error-soft text-error',
  unsure: 'bg-warning-soft text-warning',
  unverified: 'bg-surface-elevated text-muted',
};

/** Each acceptance criterion of the approved plan with its latest status and evidence. */
export function AcceptanceSection({ items }: { items: AcceptanceItem[] | null }) {
  if (!items || items.length === 0) return null;
  return (
    <section className="mb-8" aria-labelledby="acceptance">
      <h2 id="acceptance" className={sectionHeading}>
        Acceptance
      </h2>
      <ul className={listClass}>
        {items.map((a, i) => (
          <li key={i} className="px-3 py-2.5">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span
                className={`rounded-md px-1.5 py-0.5 text-xs font-medium ${ACCEPTANCE_CLASS[a.status]}`}
              >
                {ACCEPTANCE_LABEL[a.status]}
              </span>
              <span className="min-w-0 break-words text-sm">{a.criterion}</span>
              {a.extra && <span className="text-xs text-muted">not in the plan</span>}
            </div>
            {a.evidence && <p className="mt-1 break-words text-sm text-muted">{a.evidence}</p>}
            {a.fromReport && (
              <p className="mt-0.5 font-mono text-xs text-muted">from {a.fromReport}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

const TRIAGE_LABEL: Record<ReviewFinding['triage'], string> = {
  auto_fix: 'auto-fix',
  ask: 'ask',
  record: 'record',
};

const locationText = (f: ReviewFinding): string =>
  f.location
    ? `${f.location.path}:${f.location.startLine}${f.location.endLine !== f.location.startLine ? `-${f.location.endLine}` : ''}`
    : '';

/** One finding's row, with a toggle for its history when it repeats or was repeated. */
function FindingItem({ f, all }: { f: ReviewFinding; all: ReviewFinding[] }) {
  const [open, setOpen] = useState(false);
  const history = findingHistory(all, f.key);
  return (
    <>
      <tr className="align-top">
        <td className="py-1.5 pr-3">
          <span
            className={`rounded-md px-1.5 py-0.5 text-xs font-medium ${SEVERITY_CLASS[f.severity]}`}
          >
            {f.severity}
          </span>
        </td>
        <td className="py-1.5 pr-3">
          {f.title}
          <span className="ml-2 text-xs text-muted">{f.category}</span>
          {history.length > 1 && (
            <button
              type="button"
              className="ml-2 text-xs text-accent hover:underline"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
            >
              history ({history.length})
            </button>
          )}
        </td>
        <td className="py-1.5 pr-3 font-mono text-xs">{locationText(f)}</td>
        <td className="py-1.5 pr-3 text-xs text-muted">{TRIAGE_LABEL[f.triage]}</td>
        <td className="py-1.5 text-xs" title={f.resolutionNote ?? undefined}>
          {f.status}
        </td>
      </tr>
      {open && (
        <tr>
          <td />
          <td colSpan={4} className="pb-2 pr-3">
            <ol className="space-y-0.5 border-l border-line pl-3 text-xs">
              {history.map((h) => (
                <li key={h.key} className={h.key === f.key ? 'font-medium' : undefined}>
                  <span className="font-mono">{h.key}</span> {h.severity} {h.status}
                  {h.resolutionNote ? ` — ${h.resolutionNote}` : ''}
                </li>
              ))}
            </ol>
          </td>
        </tr>
      )}
    </>
  );
}

function FindingsTable({ findings, all }: { findings: ReviewFinding[]; all: ReviewFinding[] }) {
  if (findings.length === 0) return <p className="mt-1 text-sm text-muted">No findings.</p>;
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase text-muted">
          <tr>
            <th className="py-1 pr-3 font-medium">Severity</th>
            <th className="py-1 pr-3 font-medium">Finding</th>
            <th className="py-1 pr-3 font-medium">Location</th>
            <th className="py-1 pr-3 font-medium">Your call</th>
            <th className="py-1 font-medium">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {findings.map((f) => (
            <FindingItem key={f.key} f={f} all={all} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Local CI per head SHA and the review rounds with their findings. */
export function EvidenceSection({
  stages,
  rounds,
  findingsError,
  headSummary,
}: {
  stages: StageRow[];
  rounds: ReviewRound[] | null;
  findingsError: string | null;
  /** The current-head line and the evidence that belongs to older heads. */
  headSummary: { line: string; stale: string[] };
}) {
  const shas = checksBySha(stages);
  const allFindings = (rounds ?? []).flatMap((r) => r.findings);
  return (
    <section className="mb-8" aria-labelledby="evidence">
      <h2 id="evidence" className={sectionHeading}>
        Evidence
      </h2>
      <p className="mb-1 text-sm font-medium" data-testid="head-line">
        Current head: <span className="font-mono">{headSummary.line}</span>
      </p>
      {headSummary.stale.length > 0 && (
        <ul className="mb-3 space-y-0.5 text-xs text-muted">
          {headSummary.stale.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      <h3 className="mb-1 mt-3 text-sm font-medium">Local checks</h3>
      {shas.length === 0 ? (
        <p className="mb-4 text-sm text-muted">No local CI yet.</p>
      ) : (
        <ul className={`${listClass} mb-4`}>
          {shas.map((g) => (
            <li key={g.sha} className="px-3 py-2.5">
              <span className="font-mono text-sm" title={g.sha}>
                {short(g.sha)}
              </span>
              {g.runs.map((r, i) => (
                <div key={i} className="mt-1">
                  <span className="text-xs text-muted">
                    {r.state === 'running'
                      ? 'running…'
                      : r.passed === null
                        ? r.state
                        : r.passed
                          ? 'passed'
                          : 'failed'}
                  </span>
                  <ul className="mt-0.5 space-y-0.5 text-sm">
                    {r.checks.map((c) => (
                      <li key={c.name} className="flex flex-wrap items-baseline gap-x-2">
                        <span className={c.passed ? 'text-success' : 'text-error'}>
                          {c.passed ? 'pass' : 'fail'}
                        </span>
                        <span>{c.name}</span>
                        {c.logPath && (
                          <code className="min-w-0 break-all text-xs text-muted">{c.logPath}</code>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </li>
          ))}
        </ul>
      )}
      <h3 className="mb-1 text-sm font-medium">Codex review</h3>
      {findingsError ? (
        <p className="text-sm text-muted">Findings could not be loaded: {findingsError}</p>
      ) : rounds === null ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : rounds.length === 0 ? (
        <p className="text-sm text-muted">No review rounds yet.</p>
      ) : (
        <ul className={listClass}>
          {rounds.map((r) => (
            <li key={r.round} className="px-3 py-2.5">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">Round {r.round}</span>
                <span className="font-mono text-xs text-muted" title={r.reviewedSha}>
                  reviewed {short(r.reviewedSha)}
                </span>
              </div>
              {r.summary && <p className="mt-1 text-sm text-muted">{r.summary}</p>}
              <FindingsTable findings={r.findings} all={allFindings} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
