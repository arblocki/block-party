import { useRef, useState, type RefObject } from 'react';
import { api } from '../api';
import { decisionLabel } from '../lib/home';
import { relativeTime, runHref } from '../lib/route';
import type { DecisionAnswer, RunDecision } from '../types';

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

const NOTE_MAX = 4000;

/** One button per option, an optional note, and the chosen label once answered. */
function AnswerControls({ d, onAnswered }: { d: DecisionItemData; onAnswered?(): void }) {
  const options = d.options ?? [];
  const [answer, setAnswer] = useState<DecisionAnswer | null>(d.answer);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The server's copy wins when it shows an answer (another tab, or after a reload).
  const shown = answer ?? d.answer;
  const chosen = shown ? options.find((o) => o.id === shown.choice) : undefined;

  const submit = (choice: string) => {
    setBusy(true);
    setError(null);
    api<{ decision: RunDecision }>(`/api/inbox/${d.id}/answer`, {
      method: 'POST',
      body: JSON.stringify({ choice, note: note.trim() || undefined }),
    }).then(
      (r) => {
        setBusy(false);
        setAnswer(r.decision.answer ?? { choice, note: note.trim() || null });
        onAnswered?.();
      },
      (e: Error) => {
        setBusy(false);
        setError(e.message);
      },
    );
  };

  return (
    <div className="mt-2">
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            disabled={busy || shown !== null}
            aria-pressed={shown?.choice === o.id}
            className={`rounded-md border px-2.5 py-1 text-sm disabled:cursor-not-allowed ${
              shown?.choice === o.id
                ? 'border-accent bg-accent-soft font-medium'
                : 'border-line hover:bg-surface-hover disabled:opacity-60 disabled:hover:bg-transparent'
            }`}
            onClick={() => submit(o.id)}
          >
            {o.label}
          </button>
        ))}
      </div>
      {shown === null &&
        (noteOpen ? (
          <textarea
            aria-label="Note"
            value={note}
            maxLength={NOTE_MAX}
            rows={3}
            disabled={busy}
            onChange={(e) => setNote(e.target.value)}
            className="mt-2 w-full rounded-md border border-line bg-surface px-2 py-1 text-sm"
          />
        ) : (
          <button
            type="button"
            className="mt-1 text-sm text-muted hover:underline"
            onClick={() => setNoteOpen(true)}
          >
            Add a note
          </button>
        ))}
      {shown && (
        <p className="mt-1 text-sm text-muted" role="status">
          Answered: <span className="font-medium text-fg">{chosen?.label ?? shown.choice}</span>
          {shown.note ? ` - ${shown.note}` : ''}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-1 text-sm text-error">
          {error}
        </p>
      )}
    </div>
  );
}

export function DecisionItem({
  d,
  onDismiss,
  onAnswered,
  hideRunLink = false,
}: {
  d: DecisionItemData;
  onDismiss(): void;
  /** Called after an answer was recorded, so the page can reload. */
  onAnswered?(): void;
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
      {d.options && d.options.length > 0 && <AnswerControls d={d} onAnswered={onAnswered} />}
      <div className="mt-2 flex gap-3 text-sm">
        {!hideRunLink && (
          <a href={runHref(d.runId)} className="text-accent hover:underline">
            Open run
          </a>
        )}
        {!(d.options && d.options.length > 0) && (
          <button type="button" className="text-muted hover:underline" onClick={onDismiss}>
            Dismiss
          </button>
        )}
      </div>
    </li>
  );
}
