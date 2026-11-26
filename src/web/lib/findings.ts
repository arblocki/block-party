import type { FindingRow } from '../types';

/**
 * The chain of findings that raise the same problem again, oldest first. Starting from any
 * member, it follows `repeatOf` back to the first finding it can find and every finding that
 * repeats a member forward. A `repeatOf` that names a finding not in `rows` ends the chain
 * there.
 */
export function findingHistory(rows: FindingRow[], key: string): FindingRow[] {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const start = byKey.get(key);
  if (!start) return [];
  const seen = new Set<string>([start.key]);
  // Back to the oldest known ancestor.
  const back: FindingRow[] = [];
  for (let cur = start; cur.repeatOf;) {
    const prev = byKey.get(cur.repeatOf);
    if (!prev || seen.has(prev.key)) break;
    seen.add(prev.key);
    back.push(prev);
    cur = prev;
  }
  // Forward: everything that repeats a member of the chain, breadth first.
  const chain = [...back.reverse(), start];
  for (let i = 0; i < chain.length; i++) {
    for (const r of rows) {
      if (r.repeatOf === chain[i]!.key && !seen.has(r.key)) {
        seen.add(r.key);
        chain.push(r);
      }
    }
  }
  return chain.sort((a, b) => a.round - b.round || rows.indexOf(a) - rows.indexOf(b));
}
