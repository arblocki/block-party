import { useRef, useState } from 'react';
import { api } from '../api';
import { clipNote, decisionLabel, needsNote } from '../lib/home';
import { relativeTime, runHref } from '../lib/route';
import type { DecisionAnswer, RunDecision } from '../types';
import { AttachCommand } from './AttachCommand';

const BODY_LINES = 6;

/** A decision as the inbox lists it; `runTitle` is absent when it is shown on its own run. */
export type DecisionItemData = RunDecision & { runTitle?: string | null };

const NOTE_MAX = 4000;

/** One button per option, an optional note, and the chosen label once answered. */
function AnswerControls({ d, onAnswered }: { d: DecisionItemData; onAnswered?(): void }) {
  const options = d.options ?? [];
  const [answer, setAnswer] = useState<DecisionAnswer | null>(d.answer);
  const [noteOpen, setNoteOpen] = useState(false);
  // An option that needs a note waits here until the note is written.
  const [pending, setPending] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  // A ref as well as `busy`: a double click lands before the re-render disables the buttons.
  const sending = useRef(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The server's copy wins when it shows an answer (another tab, or after a reload).
  const shown = answer ?? d.answer;
  const chosen = shown ? options.find((o) => o.id === shown.choice) : undefined;

  const submit = (choice: string) => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    api<{ decision: RunDecision }>(`/api/inbox/${d.id}/answer`, {
      method: 'POST',
      body: JSON.stringify({ choice, note: note.trim() || undefined }),
    }).then(
      (r) => {
        sending.current = false;
        setBusy(false);
        setAnswer(r.decision.answer ?? { choice, note: note.trim() || null });
        onAnswered?.();
      },
      (e: Error) => {
        sending.current = false;
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
            onClick={() => {
              if (!needsNote(o.id)) return submit(o.id);
              // Open the note box first; the answer is sent with the note.
              setPending(o.id);
              setNoteOpen(true);
            }}
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
      {shown === null && pending !== null && (
        <div className="mt-1 flex items-center gap-2 text-sm">
          <button
            type="button"
            disabled={busy || note.trim() === ''}
            className="rounded-md border border-accent bg-accent-soft px-2.5 py-1 font-medium disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => submit(pending)}
          >
            Send: {options.find((o) => o.id === pending)?.label ?? pending}
          </button>
          {note.trim() === '' && <span className="text-muted">Write what to change first.</span>}
        </div>
      )}
      {shown && (
        <p className="mt-1 whitespace-pre-wrap text-sm text-muted" role="status">
          Answered: <span className="font-medium text-fg">{chosen?.label ?? shown.choice}</span>
          {shown.note && (
            <>
              {' - '}
              {showAll || !clipNote(shown.note).clipped
                ? shown.note
                : `${clipNote(shown.note).text}…`}
              {clipNote(shown.note).clipped && (
                <>
                  {' '}
                  <button
                    type="button"
                    className="text-accent hover:underline"
                    onClick={() => setShowAll((v) => !v)}
                  >
                    {showAll ? 'Show less' : 'Show more'}
                  </button>
                </>
              )}
            </>
          )}
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
      {d.attach && <AttachCommand command={d.attach} />}
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
