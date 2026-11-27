import { useState } from 'react';
import { checksBySha } from '../lib/runView';
import { relativeTime, runHref } from '../lib/route';
import { useRunLink } from '../runLink';
import { useDrafts } from '../state';
import { FindingWidget } from './FindingWidget';
import { StageBadge } from './StageBadge';

const head = 'mb-1 text-xs font-semibold uppercase text-muted';
const btn =
  'rounded-md border border-line bg-surface-elevated px-2.5 py-1 text-sm hover:bg-surface-hover disabled:opacity-50';

/** The run behind this PR: criteria, checks, finding counts and the send-to-implementer tray. */
export function RunReviewPanel() {
  const link = useRunLink();
  const drafts = useDrafts();
  const [confirmApprove, setConfirmApprove] = useState(false);
  if (!link) return null;
  const { run, finalReview } = link;

  const withText = drafts.filter((d) => d.body.trim() && !d.pendingDelete);
  const chosenDrafts = withText.filter((d) => link.draftIds.has(d.id));
  const count = link.selected.size + chosenDrafts.length;
  const canSend = !!finalReview && !link.busy && (count > 0 || link.note.trim() !== '');
  const counts = { open: 0, fixed: 0, disputed: 0 };
  for (const f of link.allFindings) {
    if (f.status === 'open') counts.open++;
    else if (f.status === 'fixed') counts.fixed++;
    else if (f.status === 'disputed') counts.disputed++;
  }
  const checks = checksBySha(link.stages).at(-1);
  const lastChecks = checks?.runs.at(-1);

  return (
    <section
      className="space-y-3 border-b border-line p-3 text-sm"
      aria-label="Run"
      data-testid="run-panel"
    >
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={runHref(run.id)}
            className="min-w-0 flex-1 truncate font-medium text-accent hover:underline"
            title={run.title}
          >
            {run.title}
          </a>
          <StageBadge stage={run.stage} />
        </div>
        <p className="text-xs text-muted">Updated {relativeTime(run.updatedAt)}</p>
      </div>

      {link.criteria.length > 0 && (
        <div>
          <h3 className={head}>Acceptance criteria</h3>
          <ul className="list-disc space-y-0.5 pl-4">
            {link.criteria.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h3 className={head}>Local CI</h3>
        {!checks || !lastChecks ? (
          <p className="text-xs text-muted">No local CI yet.</p>
        ) : (
          <div className="text-xs">
            <span className="font-mono" title={checks.sha}>
              {checks.sha.slice(0, 7)}
            </span>{' '}
            <span className="text-muted">
              {lastChecks.state === 'running'
                ? 'running…'
                : lastChecks.passed === null
                  ? lastChecks.state
                  : lastChecks.passed
                    ? 'passed'
                    : 'failed'}
            </span>
            <ul>
              {lastChecks.checks.map((c) => (
                <li key={c.name}>
                  <span className={c.passed ? 'text-success' : 'text-error'}>
                    {c.passed ? 'pass' : 'fail'}
                  </span>{' '}
                  {c.name}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div>
        <h3 className={head}>Codex findings</h3>
        <p className="text-xs">
          {counts.open} open · {counts.fixed} fixed · {counts.disputed} disputed
        </p>
      </div>

      {link.unplaced.length > 0 && (
        <div>
          <h3 className={head}>Not on a line of this diff ({link.unplaced.length})</h3>
          {link.unplaced.map((f) => (
            <FindingWidget key={f.key} finding={f} showLocation flush />
          ))}
        </div>
      )}

      <div className="space-y-2 rounded-md border border-line p-2" data-testid="send-tray">
        <h3 className={head}>Send to implementer</h3>
        {link.selected.size === 0 && withText.length === 0 && (
          <p className="text-xs text-muted">
            Tick “Send to implementer” on a finding, or add a draft comment.
          </p>
        )}
        {[...link.selected].map((key) => (
          <label key={key} className="flex items-start gap-1.5 text-xs">
            <input type="checkbox" checked onChange={() => link.toggleFinding(key)} />
            <span>
              <span className="font-mono">{key}</span>{' '}
              {link.allFindings.find((f) => f.key === key)?.title}
            </span>
          </label>
        ))}
        {withText.map((d) => (
          <label key={d.id} className="flex items-start gap-1.5 text-xs">
            <input
              type="checkbox"
              checked={link.draftIds.has(d.id)}
              onChange={() => link.toggleDraft(d.id)}
            />
            <span>
              Include my comment on{' '}
              <span className="font-mono">
                {d.path}:{d.line}
              </span>
              : <span className="text-muted">{d.body.trim().slice(0, 60)}</span>
            </span>
          </label>
        ))}
        <textarea
          value={link.note}
          rows={2}
          placeholder="Note for the implementer (optional)"
          className="w-full resize-y rounded-md border border-line bg-surface p-1.5 text-sm"
          onChange={(e) => link.setNote(e.target.value)}
        />
        {link.error && (
          <p className="text-xs text-error" role="alert">
            {link.error}
          </p>
        )}
        <button
          type="button"
          className="w-full rounded-md bg-accent px-2.5 py-1 text-sm text-accent-fg hover:bg-accent-hover disabled:opacity-50"
          disabled={!canSend}
          onClick={() =>
            void link.send(
              chosenDrafts.map((d) => ({
                path: d.path,
                line: d.line,
                body:
                  d.side === 'LEFT'
                    ? `(on the old version of the file) ${d.body.trim()}`
                    : d.body.trim(),
              })),
            )
          }
        >
          {link.busy ? 'Sending…' : `Send to implementer${count > 0 ? ` (${count})` : ''}`}
        </button>
        {!finalReview && !link.sent && (
          <p className="text-xs text-muted">The run can take feedback once it waits for review.</p>
        )}
        {link.sent && !finalReview && (
          <p className="text-xs text-success" role="status">
            Sent — fix round started.{' '}
            <a href={runHref(run.id)} className="text-accent hover:underline">
              Open run
            </a>
          </p>
        )}
      </div>

      {finalReview && (
        <div>
          {confirmApprove ? (
            <div className="flex items-center gap-2 text-xs">
              <span>Approve the run?</span>
              <button
                type="button"
                className={btn}
                disabled={link.busy}
                onClick={() => void link.approve().then(() => setConfirmApprove(false))}
              >
                Yes, approve
              </button>
              <button type="button" className={btn} onClick={() => setConfirmApprove(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button type="button" className={btn} onClick={() => setConfirmApprove(true)}>
              Approve run
            </button>
          )}
          <p className="mt-1 text-xs text-muted">Separate from submitting a GitHub review.</p>
        </div>
      )}
    </section>
  );
}
