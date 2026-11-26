import { useState } from 'react';
import { checksBySha } from '../lib/runView';
import type { ReviewFinding, ReviewRound, RunPlan, StageRow } from '../types';
import { listClass } from './PickerShell';

const SEVERITY_CLASS: Record<ReviewFinding['severity'], string> = {
  P0: 'bg-error-soft text-error',
  P1: 'bg-error-soft text-error',
  P2: 'bg-warning-soft text-warning',
  P3: 'bg-surface-elevated text-muted',
};

export const sectionHeading = 'mb-2 text-sm font-semibold uppercase text-muted';

const short = (sha: string): string => sha.slice(0, 7);

/** The plan's title and acceptance criteria, with the full text behind a toggle. */
export function PlanSection({ plan, error }: { plan: RunPlan | null; error: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="mb-8" aria-labelledby="plan">
      <h2 id="plan" className={sectionHeading}>
        Plan
      </h2>
      {error ? (
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

function FindingsTable({ findings }: { findings: ReviewFinding[] }) {
  if (findings.length === 0) return <p className="mt-1 text-sm text-muted">No findings.</p>;
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase text-muted">
          <tr>
            <th className="py-1 pr-3 font-medium">Severity</th>
            <th className="py-1 pr-3 font-medium">Finding</th>
            <th className="py-1 pr-3 font-medium">Location</th>
            <th className="py-1 font-medium">Resolution</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {findings.map((f) => (
            <tr key={f.id} className="align-top">
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
              </td>
              <td className="py-1.5 pr-3 font-mono text-xs">
                {f.location
                  ? `${f.location.path}:${f.location.startLine}${f.location.endLine !== f.location.startLine ? `-${f.location.endLine}` : ''}`
                  : ''}
              </td>
              <td className="py-1.5 text-xs" title={f.resolutionNote ?? undefined}>
                {f.resolution ?? <span className="text-muted">open</span>}
              </td>
            </tr>
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
}: {
  stages: StageRow[];
  rounds: ReviewRound[] | null;
  findingsError: string | null;
}) {
  const shas = checksBySha(stages);
  return (
    <section className="mb-8" aria-labelledby="evidence">
      <h2 id="evidence" className={sectionHeading}>
        Evidence
      </h2>
      <h3 className="mb-1 text-sm font-medium">Local CI</h3>
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
              <FindingsTable findings={r.findings} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
