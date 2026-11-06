import { useState } from 'react';
import { useReview } from '../state';
import type { ReviewThread } from '../types';

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

/** An existing GitHub review thread. Resolved threads start collapsed. */
export function ThreadWidget({
  thread,
  showLocation,
}: {
  thread: ReviewThread;
  showLocation?: boolean;
}) {
  const { replyToThread } = useReview();
  const [open, setOpen] = useState(!thread.isResolved);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = thread.comments[0];

  async function send() {
    if (!reply.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await replyToThread(thread, reply.trim());
      setReply('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={`my-1 mr-2 ml-16 max-w-3xl rounded-md border font-sans text-sm ${
        thread.isResolved ? 'border-line bg-surface-elevated' : 'border-line bg-surface'
      }`}
      data-testid="thread"
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2 py-1 text-left text-xs text-muted"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span>{open ? '▾' : '▸'}</span>
        {thread.isResolved && (
          <span className="rounded-md bg-success-soft px-1.5 text-success">Resolved</span>
        )}
        {thread.isOutdated && (
          <span className="rounded-md bg-surface-elevated px-1.5 text-fg">Outdated</span>
        )}
        {showLocation && (
          <span className="font-mono">
            {thread.path}
            {(thread.line ?? thread.originalLine) ? `:${thread.line ?? thread.originalLine}` : ''}
          </span>
        )}
        {!open && first && (
          <span className="min-w-0 flex-1 truncate">
            <b>{first.author ?? 'ghost'}</b>: {first.body}
          </span>
        )}
        {thread.comments.length > 1 && <span>{thread.comments.length} comments</span>}
      </button>
      {open && (
        <div className="border-t border-line">
          {thread.comments.map((c) => (
            <div key={c.id} className="px-2 py-1.5">
              <div className="text-xs text-muted">
                <b className="text-fg">{c.author ?? 'ghost'}</b>{' '}
                <a href={c.url} target="_blank" rel="noreferrer" className="hover:underline">
                  {when(c.createdAt)}
                </a>
              </div>
              <div className="whitespace-pre-wrap">{c.body}</div>
            </div>
          ))}
          {first?.databaseId ? (
            <div className="border-t border-line p-2">
              <textarea
                value={reply}
                rows={2}
                placeholder="Reply…"
                className="w-full resize-y rounded-md border border-line bg-surface p-1.5"
                onChange={(e) => setReply(e.target.value)}
              />
              {error && <p className="text-xs text-error">{error}</p>}
              <div className="mt-1 flex justify-end">
                <button
                  type="button"
                  disabled={busy || !reply.trim()}
                  className="rounded-md bg-accent px-2.5 py-0.5 text-xs text-accent-fg hover:bg-accent-hover disabled:opacity-50"
                  onClick={() => void send()}
                >
                  {busy ? 'Replying…' : 'Reply'}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
