import { useCallback, useMemo, useRef, useState } from 'react';
import { api, ApiError, jsonBody } from '../api';
import { cloneState, filterNewRunRepos } from '../lib/newRunRepos';
import { relativeTime } from '../lib/route';
import type { NewRunRepo, Project } from '../types';
import { useListNav } from '../useListNav';
import { useLoader } from '../useLoader';
import { linkButton } from './AppShell';
import { listClass, rowClass } from './PickerShell';

const badge = 'shrink-0 rounded-md border border-line px-1.5 text-xs text-muted';

type Prep =
  | { state: 'idle' }
  | { state: 'working'; repo: NewRunRepo; cloning: boolean }
  | { state: 'ready'; repo: NewRunRepo; project: Project }
  | { state: 'failed'; repo: NewRunRepo; message: string; command: string | null };

/**
 * "Which repo?": the viewer's GitHub repos, with the ones already on this computer marked.
 * Picking one gets it ready (cloning it when needed) and reports the result to `onReady`.
 */
export function RepoChooser({ onReady }: { onReady(project: Project | null): void }) {
  const fetcher = useCallback(
    () => api<{ repos: NewRunRepo[]; cloneRoot: string }>('/api/new-run/repos'),
    [],
  );
  const { data, error, loading, reload } = useLoader(fetcher);
  const [query, setQuery] = useState('');
  const [prep, setPrep] = useState<Prep>({ state: 'idle' });
  // The copy chosen for a repo that has several.
  // Only the latest pick may report back.
  const latest = useRef(0);
  const [copies, setCopies] = useState<Record<string, string>>({});

  const entries = useMemo(() => filterNewRunRepos(data?.repos ?? [], query), [data, query]);
  const idOf = (r: NewRunRepo) => `${r.owner}/${r.repo}`;

  const pick = async (repo: NewRunRepo) => {
    const mine = ++latest.current;
    onReady(null);
    setPrep({ state: 'working', repo, cloning: repo.clones.length === 0 });
    try {
      const clonePath = repo.clones.length > 1 ? (copies[idOf(repo)] ?? repo.clones[0]) : undefined;
      const { project } = await api<{ project: Project }>('/api/new-run/prepare', {
        method: 'POST',
        ...jsonBody({ owner: repo.owner, repo: repo.repo, ...(clonePath ? { clonePath } : {}) }),
      });
      if (mine !== latest.current) return;
      setPrep({ state: 'ready', repo, project });
      onReady(project);
    } catch (e) {
      if (mine !== latest.current) return;
      const command =
        e instanceof ApiError && typeof e.body.command === 'string' ? e.body.command : null;
      setPrep({
        state: 'failed',
        repo,
        message: e instanceof Error ? e.message : String(e),
        command,
      });
    }
  };

  const { current, setActive, listRef, onKeyDown } = useListNav(entries.length, (i) => {
    const row = i === null ? undefined : entries[i];
    if (row) void pick(row);
  });

  const chosen = prep.state === 'idle' ? null : prep.repo;

  return (
    <div>
      {error && (
        <p className="mb-2 text-sm text-error" role="alert">
          Could not list your repositories: {error}{' '}
          <button type="button" className="underline" onClick={() => void reload()}>
            Retry
          </button>
        </p>
      )}
      <input
        type="search"
        autoFocus
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        placeholder="Filter your repos — ↑/↓ to move, Enter to choose"
        aria-label="Filter your repos"
        className="mb-2 w-full rounded-md border border-line bg-surface px-3 py-1.5 text-sm"
      />
      {loading && !data && <p className="text-sm text-muted">Loading your repos…</p>}
      {data && entries.length === 0 && (
        <p className="text-sm text-muted">
          {data.repos.length === 0
            ? 'No repos found on your GitHub account.'
            : 'No repos match that filter.'}
        </p>
      )}
      {data && entries.length > 0 && (
        <ul ref={listRef} className={`${listClass} max-h-80 overflow-y-auto`} aria-label="Repos">
          {entries.map((r, i) => {
            const selected = chosen !== null && idOf(chosen) === idOf(r);
            return (
              <li key={idOf(r)} data-index={i} className={selected ? 'bg-accent-soft' : undefined}>
                <button
                  type="button"
                  aria-pressed={selected}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => void pick(r)}
                  className={`w-full text-left ${rowClass(i === current)}`}
                >
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="min-w-0 truncate font-mono text-sm font-medium">
                      {idOf(r)}
                    </span>
                    {r.private && <span className={badge}>private</span>}
                    <span className="flex-1" />
                    {r.lastUsedAt && (
                      <span className="shrink-0 text-xs text-muted" title={r.lastUsedAt}>
                        used {relativeTime(r.lastUsedAt)}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted">{cloneState(r, data.cloneRoot)}</div>
                </button>
                {r.clones.length > 1 && (
                  <div className="px-3 pb-2 text-sm">
                    <label className="mr-2 text-muted" htmlFor={`copy-${idOf(r)}`}>
                      Which copy?
                    </label>
                    <select
                      id={`copy-${idOf(r)}`}
                      className="rounded-md border border-line bg-surface px-2 py-0.5 text-sm"
                      value={copies[idOf(r)] ?? r.clones[0]}
                      onChange={(e) => setCopies({ ...copies, [idOf(r)]: e.target.value })}
                    >
                      {r.clones.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-2 text-sm" aria-live="polite">
        {prep.state === 'working' && (
          <p className="text-muted">
            {prep.cloning ? `Cloning ${idOf(prep.repo)}…` : `Getting ${idOf(prep.repo)} ready…`}
          </p>
        )}
        {prep.state === 'ready' && <p className="text-success">{idOf(prep.repo)} is ready.</p>}
        {prep.state === 'failed' && (
          <div className="rounded-md bg-error-soft px-3 py-2 text-error" role="alert">
            <p>{prep.message}</p>
            {prep.command && (
              <p className="mt-1">
                You can do it yourself by running: <code className="font-mono">{prep.command}</code>
              </p>
            )}
            <button
              type="button"
              className={`${linkButton} mt-2`}
              onClick={() => void pick(prep.repo)}
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
