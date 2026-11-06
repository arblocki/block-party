import { useMemo } from 'react';
import { itemsLabel } from '../lib/reviewItems';
import type { DiffSection } from '../lib/sections';
import { useReviewState, useVisibleSections } from '../reviewState';
import { useReview } from '../state';
import { fileAnchorId, FileDiff } from './FileDiff';

/**
 * Renders file headers with an arbitrary list of hunks each. The main view passes every file;
 * a group card passes `sectionsFromHunkIds(files, group.hunkIds)`.
 */
export function HunkList({
  sections,
  fileThreadPaths,
}: {
  sections: DiffSection[];
  /** Paths whose file-level discussion this list renders; every path when omitted. */
  fileThreadPaths?: ReadonlySet<string>;
}) {
  return (
    <div className="space-y-4">
      {sections.map((s) => (
        <FileDiff
          key={`${s.file.path}:${s.hunks.map((h) => h.id).join(',')}`}
          file={s.file}
          hunks={s.hunks}
          anchorId={s.anchorId}
          showFileThreads={!fileThreadPaths || fileThreadPaths.has(s.file.path)}
        />
      ))}
    </div>
  );
}

/** Every changed file, with anchors so the file list can scroll to them. */
export function AllFilesDiff() {
  const { files } = useReview();
  const sections = useMemo(
    () => files.map((file) => ({ file, hunks: file.hunks, anchorId: fileAnchorId(file.path) })),
    [files],
  );
  const visible = useVisibleSections(sections);
  if (visible.length === 0 && sections.length > 0) return <AllReviewed sections={sections} />;
  return <HunkList sections={visible} />;
}

export function countHunks(sections: DiffSection[]): number {
  return sections.reduce((n, s) => n + s.hunks.length, 0);
}

/** Shown instead of the diff when "Hide reviewed hunks" leaves nothing to read. */
export function AllReviewed({ sections }: { sections: DiffSection[] }) {
  const { setHideReviewed } = useReviewState();
  const hunks = countHunks(sections);
  const files = sections.length - sections.filter((s) => s.hunks.length > 0).length;
  const count = hunks + files;
  return (
    <div className="rounded-md border border-success/40 bg-success-soft p-3 text-sm text-success">
      All {count} {itemsLabel(count, hunks > 0, files > 0)} {count === 1 ? 'is' : 'are'} reviewed
      and hidden.{' '}
      <button
        type="button"
        className="text-accent hover:underline"
        onClick={() => setHideReviewed(false)}
      >
        Show reviewed
      </button>
    </div>
  );
}
