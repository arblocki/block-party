import type { ReviewRound, StageRow } from '../types';

export interface HeadEvidence {
  head: string | null;
  /** Local CI on the current head; a run still in progress counts as none. */
  checks: 'passed' | 'failed' | 'none';
  /** The latest finished review of the current head. */
  review: { round: number; blocking: number; open: number } | null;
  ci: CiState | 'none';
  /** Evidence that exists only for older heads. */
  stale: {
    checks?: { sha: string; passed: boolean };
    review?: { round: number; sha: string; blocking: number };
    ci?: { sha: string; state: CiState };
  };
}

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const sha = (v: unknown): string | null => {
  const s = record(v);
  return typeof s.headSha === 'string' && s.headSha !== ''
    ? s.headSha
    : typeof s.reviewedSha === 'string' && s.reviewedSha !== ''
      ? s.reviewedSha
      : null;
};

export type CiState = 'success' | 'failure' | 'no_ci' | 'pending' | 'timeout' | 'error';

/** A running wait is pending; a finished one without a known result (cancelled, cut off) is an error. */
const ciOf = (s: StageRow): CiState => {
  const state = record(s.output).state;
  if (state === 'success' || state === 'failure' || state === 'no_ci' || state === 'timeout') {
    return state;
  }
  return s.state === 'running' ? 'pending' : 'error';
};

/**
 * What is proven about `head`, from the stage rows. `rounds` (the findings endpoint) gives the
 * open findings of the review round; without that round, the review stage's blocking count
 * stands in for them.
 */
export function evidenceFor(
  head: string | null,
  stages: readonly StageRow[],
  rounds: readonly ReviewRound[] | null = null,
): HeadEvidence {
  const latest = (kind: StageRow['kind'], usable: (s: StageRow) => boolean) => {
    const rows = stages.filter((s) => s.kind === kind && usable(s));
    return {
      now: rows.filter((s) => head !== null && sha(s.input) === head).at(-1),
      older: rows.filter((s) => sha(s.input) !== head).at(-1),
    };
  };

  const checksDone = (s: StageRow) => typeof record(s.output).passed === 'boolean';
  const checks = latest('checks', checksDone);
  const reviews = latest('review', (s) => s.state !== 'running' && s.output != null);
  // A publish that did not succeed (blocked, failed) opened no PR to wait on.
  const publishes = latest(
    'publish',
    (s) => s.state === 'succeeded' || typeof record(s.output).prNumber === 'number',
  );
  const waits = latest('wait-ci', () => true);

  const out: HeadEvidence = { head, checks: 'none', review: null, ci: 'none', stale: {} };
  // Without a head (still planning) nothing is stale either.
  if (head === null) return out;

  if (checks.now) out.checks = record(checks.now.output).passed === true ? 'passed' : 'failed';
  else if (checks.older) {
    out.stale.checks = {
      sha: sha(checks.older.input) ?? 'unknown',
      passed: record(checks.older.output).passed === true,
    };
  }

  const blockingOf = (s: StageRow): number => {
    const n = record(s.output).blocking;
    return typeof n === 'number' ? n : 0;
  };
  if (reviews.now) {
    const round = rounds?.find((r) => r.round === reviews.now!.round);
    out.review = {
      round: reviews.now.round,
      blocking: blockingOf(reviews.now),
      open: round
        ? round.findings.filter(
            // Recorded (P3) findings never block "clean".
            (f) => f.status === 'open' && (f.triage === 'auto_fix' || f.triage === 'ask'),
          ).length
        : blockingOf(reviews.now),
    };
  } else if (reviews.older) {
    out.stale.review = {
      round: reviews.older.round,
      sha: sha(reviews.older.input) ?? 'unknown',
      blocking: blockingOf(reviews.older),
    };
  }

  if (waits.now) out.ci = ciOf(waits.now);
  else if (publishes.now) out.ci = 'pending';
  else if (waits.older)
    out.stale.ci = { sha: sha(waits.older.input) ?? 'unknown', state: ciOf(waits.older) };
  else if (publishes.older)
    out.stale.ci = { sha: sha(publishes.older.input) ?? 'unknown', state: 'pending' };
  return out;
}

const short = (s: string): string => s.slice(0, 7);

const CI_TEXT: Record<HeadEvidence['ci'], string> = {
  success: 'GitHub CI passed',
  failure: 'GitHub CI failed',
  no_ci: 'no GitHub CI',
  pending: 'GitHub CI pending',
  timeout: 'GitHub CI timed out',
  error: 'GitHub CI did not finish',
  none: 'not published',
};

/** `abc1234 · local CI passed · review r2 clean · GitHub CI pending` */
export function headLine(ev: HeadEvidence): string {
  const parts = [
    ev.head ? short(ev.head) : 'no head yet',
    ev.checks === 'none' ? 'no local CI' : `local CI ${ev.checks}`,
    ev.review
      ? `review r${ev.review.round} ${ev.review.open === 0 ? 'clean' : `${ev.review.open} open`}`
      : 'not reviewed',
    CI_TEXT[ev.ci],
  ];
  return parts.join(' · ');
}

/** Lines for evidence that belongs to older heads only. */
export function staleLines(ev: HeadEvidence): string[] {
  const lines: string[] = [];
  const { checks, review, ci } = ev.stale;
  if (checks) {
    lines.push(
      `local CI ${checks.passed ? 'passed' : 'failed'} on ${short(checks.sha)}, not the current head`,
    );
  }
  if (review) {
    lines.push(`review round ${review.round} was on ${short(review.sha)}, not the current head`);
  }
  if (ci) lines.push(`${CI_TEXT[ci.state]} on ${short(ci.sha)}, not the current head`);
  return lines;
}
