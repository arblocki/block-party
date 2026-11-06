import { useState } from 'react';
import { useDraft, useReview } from '../state';

const STATUS_LABEL = {
  new: 'Not saved yet',
  dirty: 'Unsaved changes…',
  saving: 'Saving…',
  saved: 'Draft saved',
  error: 'Save failed, will retry on edit',
} as const;

/** Inline editor for one draft comment; autosaves via the review store. */
export function DraftComposer({ draftId, inline }: { draftId: string; inline: boolean }) {
  const draft = useDraft(draftId);
  const { updateDraftBody, deleteDraft } = useReview();
  // Local text keeps typing snappy; the store debounces the PUT.
  const [body, setBody] = useState(draft?.body ?? '');
  if (!draft) return null;

  const range =
    draft.startLine !== undefined && draft.startLine !== draft.line
      ? `lines ${draft.startLine}–${draft.line}`
      : `line ${draft.line}`;
  const empty = body.trim() === '';
  const status = draft.error
    ? draft.error
    : empty && draft.status !== 'saved' && !draft.persisted
      ? 'Write something to save'
      : STATUS_LABEL[draft.status];

  return (
    <div
      className="my-1 mr-2 ml-16 max-w-3xl rounded-md border border-accent/40 bg-surface p-2 font-sans text-sm shadow-sm"
      data-testid="draft-composer"
    >
      <div className="mb-1 flex items-center justify-between text-xs text-muted">
        <span>
          Draft comment on {draft.side === 'LEFT' ? 'old ' : ''}
          {range}
        </span>
        <span data-testid="draft-status">{status}</span>
      </div>
      {draft.outdated && (
        <p
          className="mb-1 rounded-md bg-warning-soft px-2 py-1 text-xs text-warning"
          data-testid="draft-outdated"
        >
          <span className="mr-1 rounded-md bg-warning px-1 font-semibold text-accent-fg uppercase">
            outdated
          </span>
          The code under this comment changed in a newer push. It will be added to the review body
          as <code>path:line — comment</code> instead of inline.
        </p>
      )}
      {!inline && !draft.outdated && (
        <p className="mb-1 rounded-md bg-warning-soft px-2 py-1 text-xs text-warning">
          This line is outside the diff, so GitHub can't show it inline. The comment will be added
          to the review body as <code>path:line — comment</code>.
        </p>
      )}
      <textarea
        autoFocus={draft.status === 'new'}
        value={body}
        rows={3}
        placeholder="Leave a comment"
        className="w-full resize-y rounded-md border border-line bg-surface p-1.5 font-sans"
        onChange={(e) => {
          setBody(e.target.value);
          updateDraftBody(draftId, e.target.value);
        }}
      />
      <div className="mt-1 flex justify-end">
        <button
          type="button"
          className="rounded-md px-2 py-0.5 text-xs text-error hover:bg-error-soft"
          onClick={() => void deleteDraft(draftId)}
        >
          {draft.persisted ? 'Delete draft' : 'Cancel'}
        </button>
      </div>
    </div>
  );
}
