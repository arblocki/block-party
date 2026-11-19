import type { RepoRef } from '../pr-ref.js';
import type { ChecksRunResult } from '../checks/run.js';
import type { Git } from '../git/index.js';
import type { CiCheck, GitHubClient } from '../github/types.js';
import type { Finding } from '../reviewer/findings.js';
import type { Plan } from './plan.js';
import type { Report } from './report.js';

export type ResolutionKind = 'fixed' | 'disputed' | 'deferred' | 'open';

export interface ReviewRoundInput {
  round: number;
  reviewedSha: string;
  summary: string;
  findings: Finding[];
  resolutions: Record<string, { resolution: ResolutionKind; note?: string }>;
}

export interface PrBodyInput {
  plan: Plan;
  report: Report;
  checks: ChecksRunResult;
  reviewRounds: ReviewRoundInput[];
  runId: string;
}

/** Stops `@name` from pinging anyone: inserts a zero-width space after the `@`. */
export function neutraliseMentions(text: string): string {
  return text.replace(/@(?=\w)/g, '@​');
}

/** Agent text for a table cell: neutralised, single line, `|` escaped. */
function cell(text: string): string {
  return neutraliseMentions(text)
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

/** Agent text for a list item or paragraph: neutralised, newlines collapsed. */
function inline(text: string): string {
  return neutraliseMentions(text)
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .trim();
}

function isBlocking(f: Finding): boolean {
  return f.severity === 'P0' || f.severity === 'P1';
}

function resolutionOf(round: ReviewRoundInput, f: Finding): ResolutionKind {
  return round.resolutions[f.id]?.resolution ?? 'open';
}

/**
 * Unresolved blocking findings (Phase 1 rule): every P0/P1 finding of the LAST round (it was
 * never fixed and re-reviewed), plus P0/P1 findings of earlier rounds whose resolution is
 * disputed, deferred or open. Earlier P0/P1 findings marked `fixed` count as resolved,
 * including when the last round found nothing. Deduplicated by finding id.
 */
export function unresolvedBlocking(rounds: ReviewRoundInput[]): Finding[] {
  const out = new Map<string, Finding>();
  rounds.forEach((round, i) => {
    const isLast = i === rounds.length - 1;
    for (const f of round.findings) {
      if (!isBlocking(f)) continue;
      if (isLast || resolutionOf(round, f) !== 'fixed') out.set(f.id, f);
    }
  });
  return [...out.values()];
}

const STATUS_LABEL = { met: 'met', not_met: 'NOT met', unsure: 'unsure' } as const;

function location(f: Finding): string {
  if (!f.location) return '-';
  const { path, startLine, endLine } = f.location;
  return `${path}:${startLine}${endLine !== startLine ? `-${endLine}` : ''}`;
}

export function renderPrBody(input: PrBodyInput): string {
  const { plan, report, checks, reviewRounds, runId } = input;
  const out: string[] = [];

  out.push('## Summary', '', inline(report.summary), '');

  out.push('## Acceptance criteria', '');
  const reported = new Set(report.acceptance.map((a) => a.criterion.trim()));
  for (const a of report.acceptance) {
    const ev = a.evidence.trim() ? ` - ${inline(a.evidence)}` : '';
    out.push(`- ${STATUS_LABEL[a.status]}: ${inline(a.criterion)}${ev}`);
  }
  for (const c of plan.acceptanceCriteria) {
    if (!reported.has(c.trim())) out.push(`- not reported: ${inline(c)}`);
  }
  out.push('');

  out.push(`## Local CI (on \`${checks.headSha.slice(0, 7)}\`)`, '');
  if (checks.results.length === 0) out.push('No checks configured.');
  else {
    out.push('| Check | Result |', '| --- | --- |');
    for (const r of checks.results) {
      const result = r.timedOut
        ? 'timed out'
        : r.exitCode === 0
          ? 'passed'
          : `failed (exit ${r.exitCode ?? 'signal'})`;
      out.push(`| ${cell(r.name)} | ${result} |`);
    }
  }
  out.push('');

  out.push('## Codex review', '');
  if (reviewRounds.length === 0) out.push('No review rounds ran.', '');
  for (const round of reviewRounds) {
    const sha = round.reviewedSha.slice(0, 7);
    out.push(`### Round ${round.round} (reviewed \`${sha}\`)`, '');
    if (round.summary.trim()) out.push(inline(round.summary), '');
    if (round.findings.length === 0) {
      out.push(`Codex found nothing on \`${sha}\`.`, '');
      continue;
    }
    out.push('| Severity | Title | Location | Resolution |', '| --- | --- | --- | --- |');
    for (const f of round.findings) {
      out.push(
        `| ${f.severity} | ${cell(f.title)} | ${cell(location(f))} | ${resolutionOf(round, f)} |`,
      );
    }
    out.push('');
  }

  const unresolved = unresolvedBlocking(reviewRounds);
  if (unresolved.length > 0) {
    out.push('## ⚠ Unresolved blocking findings', '');
    for (const f of unresolved) {
      out.push(
        `- **${f.severity}** ${inline(f.title)} (${inline(location(f))}): ${inline(f.body)}`,
      );
    }
    out.push('');
  }

  out.push(`Run: ${runId}`, '');
  return out.join('\n');
}

export type PublishErrorCode =
  | 'push_failed'
  | 'remote_mismatch'
  | 'head_mismatch'
  | 'interrupted'
  /** A plain error (network, git) after the push; `done` still records what happened. */
  | 'unexpected';

export class PublishError extends Error {
  constructor(
    readonly code: PublishErrorCode,
    message: string,
    /** What had already happened externally when publishing stopped. */
    readonly done: { pushed: boolean; prNumber?: number } = { pushed: false },
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'PublishError';
  }
}

export interface PublishOptions {
  git: Pick<Git, 'pushBranch' | 'remoteBranchSha' | 'headSha'>;
  github: Pick<GitHubClient, 'findOpenPrForBranch' | 'createPr' | 'getPr'>;
  repo: RepoRef;
  worktree: string;
  branch: string;
  base: string;
  title: string;
  body: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** How long to wait for GitHub to show the pushed head on the PR. Default 30 s. */
  headTimeoutMs?: number;
  headPollMs?: number;
  /** Checked before the push, before creating the PR and while polling the head. */
  signal?: AbortSignal;
}

export interface PublishResult {
  prNumber: number;
  url: string;
  headSha: string;
  created: boolean;
}

/** Pushes (never forced), confirms the remote head, ensures a draft PR and confirms its head. */
export async function publishRun(opts: PublishOptions): Promise<PublishResult> {
  const { git, github, repo, worktree, branch } = opts;
  const signal = opts.signal;
  const sleep = opts.sleep ?? ((ms: number) => abortableSleep(ms, signal));
  const done: { pushed: boolean; prNumber?: number } = { pushed: false };
  const interrupted = (): PublishError =>
    new PublishError('interrupted', 'Publishing interrupted', { ...done });
  const checkAbort = () => {
    if (signal?.aborted) throw interrupted();
  };
  const now = opts.now ?? Date.now;
  const local = await git.headSha(worktree);

  checkAbort();
  try {
    await git.pushBranch(worktree, branch);
  } catch (e) {
    throw new PublishError('push_failed', `Pushing ${branch} failed: ${(e as Error).message}`);
  }
  done.pushed = true;

  const afterPush = async (): Promise<PublishResult> => {
    const remote = await git.remoteBranchSha(worktree, branch);
    if (remote !== local) {
      throw new PublishError(
        'remote_mismatch',
        `Remote ${branch} is at ${remote ?? 'nothing'}, expected ${local}`,
      );
    }

    checkAbort();
    let pr = await github.findOpenPrForBranch(repo, branch);
    const created = pr === undefined;
    checkAbort();
    pr ??= await github.createPr(repo, {
      head: branch,
      base: opts.base,
      title: opts.title,
      body: opts.body,
      draft: true,
    });

    done.prNumber = pr.number;
    const deadline = now() + (opts.headTimeoutMs ?? 30_000);
    for (;;) {
      if (pr.headSha === local) {
        return { prNumber: pr.number, url: pr.url, headSha: local, created };
      }
      if (now() >= deadline) {
        throw new PublishError(
          'head_mismatch',
          `PR #${pr.number} head is ${pr.headSha}, expected ${local}`,
        );
      }
      await sleep(opts.headPollMs ?? 1000);
      checkAbort();
      pr = await github.getPr(repo, pr.number);
    }
  };

  try {
    return await afterPush();
  } catch (e) {
    if (e instanceof PublishError) throw e;
    // Anything failing once the signal has aborted (an aborted sleep, a cancelled call) is
    // an interrupt, not an unexpected failure.
    if (signal?.aborted) throw interrupted();
    const reason = e instanceof Error ? e.message : String(e);
    throw new PublishError(
      'unexpected',
      `Publishing ${branch} failed after the push: ${reason}`,
      { ...done },
      { cause: e },
    );
  }
}

/** Sleeps `ms`; rejects (and clears its timer) as soon as `signal` aborts. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason as Error);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason as Error);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export type CiWaitState = 'success' | 'failure' | 'no_ci' | 'timeout';

export interface WaitForCiOptions {
  github: Pick<GitHubClient, 'getCiStatus'>;
  repo: RepoRef;
  sha: string;
  timeoutMs?: number;
  intervalMs?: number;
  noCiGraceMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Abort stops polling promptly; waitForCi then rejects with an AbortError. */
  signal?: AbortSignal;
}

/**
 * Polls CI until it succeeds, fails or times out. Time for `none` is counted from the first
 * poll: if every poll within `noCiGraceMs` is `none` the result is `no_ci`; once any check
 * has appeared, `none` can no longer produce `no_ci`.
 */
export async function waitForCi(
  opts: WaitForCiOptions,
): Promise<{ state: CiWaitState; checks: CiCheck[] }> {
  const timeoutMs = opts.timeoutMs ?? 30 * 60_000;
  const intervalMs = opts.intervalMs ?? 20_000;
  const graceMs = opts.noCiGraceMs ?? 60_000;
  const signal = opts.signal;
  const sleep = opts.sleep ?? ((ms: number) => abortableSleep(ms, signal));
  const now = opts.now ?? Date.now;
  const start = now();
  let seenChecks = false;
  for (;;) {
    signal?.throwIfAborted();
    const status = await opts.github.getCiStatus(opts.repo, opts.sha);
    const { checks } = status;
    if (status.state === 'success' || status.state === 'failure') {
      return { state: status.state, checks };
    }
    if (status.state === 'pending') seenChecks = true;
    const elapsed = now() - start;
    if (status.state === 'none' && !seenChecks && elapsed >= graceMs) {
      return { state: 'no_ci', checks };
    }
    if (elapsed >= timeoutMs) return { state: 'timeout', checks };
    await sleep(intervalMs);
    signal?.throwIfAborted();
  }
}
