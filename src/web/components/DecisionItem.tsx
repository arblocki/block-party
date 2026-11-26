import { useRef, useState, type RefObject } from 'react';
import { decisionLabel } from '../lib/home';
import { relativeTime, runHref } from '../lib/route';
import type { RunDecision } from '../types';

function CopyButton({ text, codeRef }: { text: string; codeRef: RefObject<HTMLElement | null> }) {
  const [copied, setCopied] = useState(false);
  const selectText = () => {
    const el = codeRef.current;
    if (el) window.getSelection()?.selectAllChildren(el);
  };
  return (
    <button
      type="button"
      className="rounded-md border border-line px-2 py-0.5 text-xs hover:bg-surface-hover"
      onClick={() => {
        // navigator.clipboard is missing on insecure origins (plain-http tailnet).
        let write: Promise<void> | undefined;
        try {
          write = navigator.clipboard?.writeText(text);
        } catch {
          write = undefined;
        }
        if (!write) return selectText();
        write.then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }, selectText);
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

const BODY_LINES = 6;

/** A decision as the inbox lists it; `runTitle` is absent when it is shown on its own run. */
export type DecisionItemData = RunDecision & { runTitle?: string | null };

export function DecisionItem({
  d,
  onDismiss,
  hideRunLink = false,
}: {
  d: DecisionItemData;
  onDismiss(): void;
  /** Leaves out the "Open run" link, for the run's own page. */
  hideRunLink?: boolean;
}) {
  const lines = d.body.split('\n');
  const body = lines.slice(0, BODY_LINES).join('\n');
  const codeRef = useRef<HTMLElement>(null);
  return (
    <li className="px-3 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="rounded-md bg-warning-soft px-1.5 py-0.5 text-xs font-medium text-warning">
          {decisionLabel(d.kind)}
        </span>
        <span className="font-medium">{d.title}</span>
        {d.runTitle && <span className="text-sm text-muted">{d.runTitle}</span>}
        <span className="flex-1" />
        <span className="text-xs text-muted" title={d.createdAt}>
          {relativeTime(d.createdAt)}
        </span>
      </div>
      {body && (
        <p className="mt-1 whitespace-pre-wrap text-sm text-muted">
          {body}
          {lines.length > BODY_LINES ? '\n…' : ''}
        </p>
      )}
      {d.attach && (
        <div className="mt-2 flex items-center gap-2">
          <code
            ref={codeRef}
            className="min-w-0 flex-1 overflow-x-auto rounded-md bg-code-bg px-2 py-1 font-mono text-xs"
          >
            {d.attach}
          </code>
          <CopyButton text={d.attach} codeRef={codeRef} />
        </div>
      )}
      <div className="mt-2 flex gap-3 text-sm">
        {!hideRunLink && (
          <a href={runHref(d.runId)} className="text-accent hover:underline">
            Open run
          </a>
        )}
        <button type="button" className="text-muted hover:underline" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </li>
  );
}
