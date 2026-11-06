import type { KeyboardEvent, ReactNode } from 'react';

const btn =
  'rounded-md border border-line bg-surface-elevated px-2.5 py-1 text-sm hover:bg-surface-hover disabled:opacity-50';

/** Row styling shared by the pickers' list items. */
export function rowClass(active: boolean): string {
  return `block px-3 py-2 ${active ? 'bg-accent-soft' : 'hover:bg-surface-hover'}`;
}

export const listClass = 'divide-y divide-line rounded-md border border-line';

/** Page frame for the repository and PR pickers: title row, filter box, error, then the list. */
export function PickerShell(props: {
  title: string;
  /** Shown before the title, e.g. a link back to the previous picker. */
  back?: ReactNode;
  /** Shown after the title. */
  subtitle?: ReactNode;
  loading: boolean;
  onRefresh(): void;
  query: string;
  onQuery(q: string): void;
  onKeyDown(e: KeyboardEvent): void;
  placeholder: string;
  filterLabel: string;
  error: string | null;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {props.back}
        <h1 className="text-lg font-semibold">{props.title}</h1>
        {props.subtitle}
        <span className="flex-1" />
        <button type="button" className={btn} disabled={props.loading} onClick={props.onRefresh}>
          {props.loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>
      <input
        type="search"
        autoFocus
        value={props.query}
        onChange={(e) => props.onQuery(e.target.value)}
        onKeyDown={props.onKeyDown}
        placeholder={props.placeholder}
        aria-label={props.filterLabel}
        className="mb-3 w-full rounded-md border border-line bg-surface px-3 py-1.5 text-sm"
      />
      {props.error && (
        <p role="alert" className="mb-3 rounded-md bg-error-soft px-3 py-2 text-sm text-error">
          {props.error}
        </p>
      )}
      {props.children}
    </div>
  );
}
