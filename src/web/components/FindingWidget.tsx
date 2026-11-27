import { useState } from 'react';
import { findingHistory } from '../lib/findings';
import { useRunLink } from '../runLink';
import type { FindingRow } from '../types';
import { SEVERITY_CLASS } from './RunEvidence';

/** A Codex finding under the line it names (or in a file's discussion, with its location). */
export function FindingWidget({
  finding,
  showLocation,
  flush,
}: {
  finding: FindingRow;
  showLocation?: boolean;
  /** No left indent (outside the diff, where there is no gutter to line up with). */
  flush?: boolean;
}) {
  const link = useRunLink();
  const [open, setOpen] = useState(finding.status === 'open');
  const [showHistory, setShowHistory] = useState(false);
  if (!link) return null;
  const history = findingHistory(link.allFindings, finding.key);
  const loc = finding.location;
  const inTray = link.selected.has(finding.key);

  return (
    <div
      className={`my-1 mr-2 ${flush ? 'ml-0' : 'ml-16'} max-w-3xl rounded-md border border-warning/40 bg-surface font-sans text-sm`}
      data-testid="finding"
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2 py-1 text-left text-xs"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className="text-muted">{open ? '▾' : '▸'}</span>
        <span
          className={`rounded-md px-1.5 py-0.5 font-medium ${SEVERITY_CLASS[finding.severity]}`}
        >
          {finding.severity}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">{finding.title}</span>
        {showLocation && loc && (
          <span className="font-mono text-muted">
            {loc.path}:{loc.endLine}
          </span>
        )}
        <span className="text-muted">Codex · {finding.status.replaceAll('_', ' ')}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-line px-2 py-1.5">
          <div className="whitespace-pre-wrap">{finding.body}</div>
          {finding.suggestedFix && (
            <div className="whitespace-pre-wrap rounded-md bg-surface-elevated p-1.5 text-xs">
              <b>Suggested fix: </b>
              {finding.suggestedFix}
            </div>
          )}
          {finding.resolutionNote && (
            <p className="text-xs text-muted">Implementer: {finding.resolutionNote}</p>
          )}
          <div className="flex flex-wrap items-center gap-3 text-xs">
            {history.length > 1 && (
              <button
                type="button"
                className="text-accent hover:underline"
                aria-expanded={showHistory}
                onClick={() => setShowHistory(!showHistory)}
              >
                History ({history.length})
              </button>
            )}
            <label className="ml-auto flex cursor-pointer items-center gap-1">
              <input
                type="checkbox"
                checked={inTray}
                onChange={() => link.toggleFinding(finding.key)}
              />
              Send to implementer
            </label>
          </div>
          {showHistory && (
            <ul className="space-y-0.5 text-xs text-muted">
              {history.map((h) => (
                <li key={h.key}>
                  <span className="font-mono">{h.key}</span> {h.severity} · {h.status} · {h.title}
                  {h.key === finding.key ? ' (this one)' : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
