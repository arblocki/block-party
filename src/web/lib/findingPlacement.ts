import type { FindingRow, Hunk } from '../types';
import { findChangeKey, findHunk, toRdvHunks } from './diffModel';

export interface FindingPlacement {
  /** Findings whose last line is in a rendered hunk; the diff shows them under that line. */
  inline: FindingRow[];
  /** Findings on this file that can't attach to a rendered line. */
  fileLevel: FindingRow[];
  /** Findings with no usable location (no path or lines). */
  unplaced: FindingRow[];
}

/**
 * Splits one file's findings like `placeThreads` does threads: by path and end line on the new
 * side. A finding with no location is `unplaced`. One on a line of a `hidden` hunk (shown by
 * another card) is dropped, since it renders there. Lines hidden by whitespace filtering are in
 * neither list, so they fall to the file level.
 */
export function placeFindings(
  findings: FindingRow[],
  shown: Hunk[],
  hidden: Hunk[] = [],
): FindingPlacement {
  const rdv = toRdvHunks(shown);
  const placement: FindingPlacement = { inline: [], fileLevel: [], unplaced: [] };
  for (const f of findings) {
    if (!f.location) {
      placement.unplaced.push(f);
      continue;
    }
    const pos = { side: 'RIGHT' as const, line: f.location.endLine };
    if (findChangeKey(rdv, pos)) placement.inline.push(f);
    else if (!findHunk(hidden, pos)) placement.fileLevel.push(f);
  }
  return placement;
}

/**
 * Findings to show on the review page: those reviewed on the PR's current head, plus findings
 * from earlier rounds that are still open and whose file is in the diff.
 */
export function visibleFindings(
  findings: FindingRow[],
  headSha: string,
  diffPaths: ReadonlySet<string>,
): FindingRow[] {
  return findings.filter(
    (f) =>
      sameSha(f.reviewedSha, headSha) ||
      (f.status === 'open' && !!f.location && diffPaths.has(f.location.path)),
  );
}

/** Findings by file path for files in the diff; the rest (no location, other files) are unplaced. */
export function splitByFile(
  findings: FindingRow[],
  diffPaths: ReadonlySet<string>,
): { byPath: Map<string, FindingRow[]>; unplaced: FindingRow[] } {
  const byPath = new Map<string, FindingRow[]>();
  const unplaced: FindingRow[] = [];
  for (const f of findings) {
    const path = f.location?.path;
    if (path === undefined || !diffPaths.has(path)) {
      unplaced.push(f);
      continue;
    }
    byPath.set(path, [...(byPath.get(path) ?? []), f]);
  }
  return { byPath, unplaced };
}

/** Full and abbreviated SHAs of the same commit compare equal. */
function sameSha(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a.startsWith(b) || b.startsWith(a);
}
