import { useDrafts, useReview } from '../state';
import type { ParsedFile } from '../types';
import { fileAnchorId } from './FileDiff';
import { ProgressBar } from './ProgressBar';

const STATUS: Record<string, { letter: string; cls: string }> = {
  added: { letter: 'A', cls: 'text-success' },
  removed: { letter: 'D', cls: 'text-error' },
  renamed: { letter: 'R', cls: 'text-accent' },
  copied: { letter: 'C', cls: 'text-accent' },
};

export function scrollToFile(path: string): void {
  document.getElementById(fileAnchorId(path))?.scrollIntoView({ block: 'start' });
}

/** Left-rail list of changed files; clicking scrolls the main column to that file. */
export function FileList({ files }: { files: ParsedFile[] }) {
  const { incomplete } = useReview();
  const drafts = useDrafts();
  const counts = new Map<string, number>();
  for (const d of drafts) if (d.body.trim()) counts.set(d.path, (counts.get(d.path) ?? 0) + 1);

  return (
    <nav className="py-2 text-sm">
      <div className="px-3 pb-1 text-xs font-semibold tracking-wide text-muted uppercase">
        Files ({incomplete ? `${files.length} of ${incomplete.changedFiles}` : files.length})
      </div>
      <ul>
        {files.map((f) => {
          const s = STATUS[f.status] ?? { letter: 'M', cls: 'text-warning' };
          const slash = f.path.lastIndexOf('/');
          const count = counts.get(f.path);
          return (
            <li key={f.path}>
              <button
                type="button"
                title={f.path}
                onClick={() => scrollToFile(f.path)}
                className="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-surface-hover"
              >
                <span className={`w-3 shrink-0 font-mono text-xs font-bold ${s.cls}`}>
                  {s.letter}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-muted">{slash >= 0 ? f.path.slice(0, slash + 1) : ''}</span>
                  <span className="font-medium">{f.path.slice(slash + 1)}</span>
                </span>
                {count ? (
                  <span className="rounded-full bg-accent px-1.5 text-xs text-accent-fg">
                    {count}
                  </span>
                ) : null}
                <span className="shrink-0 font-mono text-xs">
                  <span className="text-success">+{f.additions}</span>{' '}
                  <span className="text-error">−{f.deletions}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <ProgressBar />
    </nav>
  );
}
