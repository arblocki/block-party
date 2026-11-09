import type { Finding } from './findings.js';

export type Severity = 'P0' | 'P1' | 'P2' | 'P3';

export interface Expectation {
  path: string;
  /** Inclusive [start, end] line range of the planted/real bug. */
  lines?: [number, number];
  /** The finding must be at least this severe (P0 is most severe). */
  minSeverity: Severity;
  /** Matched case-insensitively against title and body. */
  keywords: string[];
}

export interface Match {
  expectation: number;
  findingId: string;
  /** 'lines' when the ranges overlap, else 'keywords'. */
  by: 'lines' | 'keywords';
}

export interface CaseScore {
  matched: Match[];
  /** Indexes into `expected` that no finding satisfied. */
  missed: number[];
  /** Findings that satisfied no expectation. */
  extra: Finding[];
  /** matched / expected, or null when there are no expectations (negative case). */
  recall: number | null;
  /** Negative cases only: findings with severity P0-P2 (a P3 nit is not a false positive). */
  falsePositives: Finding[];
}

const RANK: Record<Severity, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

const normPath = (p: string) => p.replace(/^\.\//, '').replace(/\\/g, '/');

interface Candidate {
  e: number;
  f: number;
  by: Match['by'];
  score: number;
}

function candidate(
  exp: Expectation,
  e: number,
  finding: Finding,
  f: number,
): Candidate | undefined {
  const loc = finding.location;
  if (!loc || normPath(loc.path) !== normPath(exp.path)) return undefined;
  if (RANK[finding.severity] > RANK[exp.minSeverity]) return undefined;
  const overlap =
    exp.lines !== undefined && loc.startLine <= exp.lines[1] && loc.endLine >= exp.lines[0];
  const text = `${finding.title}\n${finding.body}`.toLowerCase();
  const hits = exp.keywords.filter((k) => text.includes(k.toLowerCase())).length;
  // Lenient on purpose: a line overlap OR a keyword hit is enough, because a reviewer often
  // anchors the right bug a few lines off, or describes it correctly without exact lines.
  if (!overlap && hits === 0) return undefined;
  return { e, f, by: overlap ? 'lines' : 'keywords', score: (overlap ? 1000 : 0) + hits };
}

/**
 * Pure scoring of one case. A finding matches an expectation when its path equals the
 * expectation's, its severity is at least `minSeverity`, and either its line range overlaps
 * `lines` or any keyword appears in its title/body. Each finding satisfies at most one
 * expectation and each expectation is satisfied once: candidate pairs are assigned greedily,
 * best score first (line overlap beats keyword-only, then more keyword hits), ties broken by
 * input order.
 */
export function scoreCase(expected: Expectation[], findings: Finding[]): CaseScore {
  const cands: Candidate[] = [];
  expected.forEach((exp, e) =>
    findings.forEach((finding, f) => {
      const c = candidate(exp, e, finding, f);
      if (c) cands.push(c);
    }),
  );
  cands.sort((a, b) => b.score - a.score || a.e - b.e || a.f - b.f);
  const usedE = new Set<number>();
  const usedF = new Set<number>();
  const matched: Match[] = [];
  for (const c of cands) {
    if (usedE.has(c.e) || usedF.has(c.f)) continue;
    usedE.add(c.e);
    usedF.add(c.f);
    matched.push({ expectation: c.e, findingId: findings[c.f]!.id, by: c.by });
  }
  matched.sort((a, b) => a.expectation - b.expectation);
  const extra = findings.filter((_, i) => !usedF.has(i));
  return {
    matched,
    missed: expected.map((_, i) => i).filter((i) => !usedE.has(i)),
    extra,
    recall: expected.length === 0 ? null : matched.length / expected.length,
    falsePositives:
      expected.length === 0 ? findings.filter((f) => RANK[f.severity] <= RANK.P2) : [],
  };
}
