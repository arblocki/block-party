/**
 * Matching of implementer report entries to plan criteria. Plans are Markdown and reports
 * often repeat a criterion without its formatting, so both sides are normalized first.
 */

/** Text comparable across Markdown: no code ticks or emphasis, plain quotes, no trailing period. */
export function normalizeCriterion(text: string): string {
  return text
    .replace(/[`*_]/g, '')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\.+$/, '')
    .trim();
}

const words = (text: string): Set<string> =>
  new Set(
    normalizeCriterion(text)
      .split(' ')
      .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
      .filter(Boolean),
  );

/** Jaccard overlap of the words of two criteria, 0 to 1. */
export function wordOverlap(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / (wa.size + wb.size - shared);
}

export const FUZZY_THRESHOLD = 0.8;

/**
 * Pairs plan criteria with report criteria: exact on normalized text first, then the
 * best word overlap of at least 0.8. Each side is used once. Returns criterion index to
 * report text index.
 */
export function matchCriteria(
  planned: readonly string[],
  reported: readonly string[],
): Map<number, number> {
  const out = new Map<number, number>();
  const usedReport = new Set<number>();
  const reportKeys = reported.map(normalizeCriterion);
  planned.forEach((p, i) => {
    const key = normalizeCriterion(p);
    const j = reportKeys.findIndex((k, idx) => k === key && !usedReport.has(idx));
    if (j >= 0) {
      out.set(i, j);
      usedReport.add(j);
    }
  });
  const pairs: { i: number; j: number; score: number }[] = [];
  planned.forEach((p, i) => {
    if (out.has(i)) return;
    reported.forEach((r, j) => {
      if (usedReport.has(j)) return;
      const score = wordOverlap(p, r);
      if (score >= FUZZY_THRESHOLD) pairs.push({ i, j, score });
    });
  });
  pairs.sort((a, b) => b.score - a.score || a.i - b.i || a.j - b.j);
  for (const { i, j } of pairs) {
    if (out.has(i) || usedReport.has(j)) continue;
    out.set(i, j);
    usedReport.add(j);
  }
  return out;
}
