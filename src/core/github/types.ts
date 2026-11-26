import type { PrRef, RepoRef } from '../pr-ref.js';
import type { RawFile, Side } from '../diff/types.js';

export interface PrMeta {
  title: string;
  body: string;
  author: string;
  state: 'open' | 'closed' | 'merged';
  url: string;
  baseSha: string;
  baseRef: string;
  headSha: string;
  headRef: string;
  additions: number;
  deletions: number;
  changedFiles: number;
}

/** A repository the viewer can access. */
export interface RepoSummary {
  owner: string;
  name: string;
  description: string;
  private: boolean;
  archived: boolean;
  fork: boolean;
  url: string;
  pushedAt: string;
}

/** One row of a repository's open pull request list. */
export interface PrSummary {
  number: number;
  title: string;
  author: string;
  draft: boolean;
  url: string;
  headRef: string;
  baseRef: string;
  createdAt: string;
  updatedAt: string;
  labels: string[];
  /** Logins of users whose review is requested. */
  requestedReviewers: string[];
}

export interface ThreadComment {
  id: string;
  databaseId: number | null;
  author: string | null;
  body: string;
  createdAt: string;
  url: string;
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  originalLine: number | null;
  diffSide: Side;
  startLine: number | null;
  comments: ThreadComment[];
}

export interface PrCommit {
  sha: string;
  message: string;
  author: string | null;
  date: string | null;
}

/** Result of comparing two commits: the commits between them and the files they touch. */
export interface CompareResult {
  commits: PrCommit[];
  files: string[];
  /** Commits between the two, as GitHub counts them (may exceed `commits.length`). */
  totalCommits: number;
  /** `commits` is capped (see MAX_COMPARE_COMMITS) and does not list them all. */
  commitsTruncated?: boolean;
  /** The file list hit GitHub's 300-file limit for this endpoint, so it may be incomplete. */
  filesTruncated?: boolean;
}

export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

export interface ReviewComment {
  path: string;
  body: string;
  line: number;
  side: Side;
  start_line?: number;
  start_side?: Side;
}

export interface SubmitReviewInput {
  headSha: string;
  event: ReviewEvent;
  body: string;
  comments: ReviewComment[];
}

export interface SubmittedReview {
  id: number;
  url: string;
}

/** A pull request as the publish flow sees it. */
export interface PublishedPr {
  number: number;
  headSha: string;
  url: string;
  draft: boolean;
  /** Absent means open. */
  state?: 'open' | 'closed' | 'merged';
}

export interface CreatePrInput {
  head: string;
  base: string;
  title: string;
  body: string;
  draft: true;
}

export interface CiCheck {
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
}

export interface CiStatus {
  state: 'pending' | 'success' | 'failure' | 'none';
  checks: CiCheck[];
}

/** Everything the app needs from GitHub. Implemented by the Octokit client; faked in tests. */
export interface GitHubClient {
  /** Repositories the viewer owns, collaborates on, or can see through an org; latest push first. */
  listRepos(): Promise<RepoSummary[]>;
  /** Open pull requests, most recently updated first (capped). */
  listOpenPrs(repo: RepoRef): Promise<PrSummary[]>;
  fetchPr(ref: PrRef): Promise<PrMeta>;
  /** Changed files, with `patch` filled in via the full-diff fallback where GitHub omitted it. */
  fetchFiles(ref: PrRef): Promise<RawFile[]>;
  fetchFileContent(ref: PrRef, path: string, sha: string): Promise<string>;
  fetchReviewThreads(ref: PrRef): Promise<ReviewThread[]>;
  fetchCommits(ref: PrRef): Promise<PrCommit[]>;
  /**
   * `GET /compare/{base}...{head}`. Resolves to undefined when GitHub cannot compare the
   * commits (404/422), e.g. `base` was force-pushed away.
   */
  compareCommits(ref: PrRef, base: string, head: string): Promise<CompareResult | undefined>;
  getViewerLogin(): Promise<string>;
  submitReview(ref: PrRef, input: SubmitReviewInput): Promise<SubmittedReview>;
  replyToComment(ref: PrRef, commentId: number, body: string): Promise<{ id: number; url: string }>;
  /** The open PR whose head is `branch` in the same repo, if any. */
  findOpenPrForBranch(repo: RepoRef, branch: string): Promise<PublishedPr | undefined>;
  createPr(repo: RepoRef, input: CreatePrInput): Promise<PublishedPr>;
  /** Replaces the title and body of an existing PR. */
  updatePr(
    repo: RepoRef,
    number: number,
    input: { title: string; body: string },
  ): Promise<PublishedPr>;
  getPr(repo: RepoRef, number: number): Promise<PublishedPr>;
  /** Check runs and commit statuses for `sha`, combined into one state. */
  getCiStatus(repo: RepoRef, sha: string): Promise<CiStatus>;
}

/** Minimal REST surface (an adapter over Octokit's `request`); trivially fakeable. */
export interface RestLike {
  request(route: string, params?: Record<string, unknown>): Promise<{ data: unknown }>;
}

export type GraphqlLike = (query: string, variables: Record<string, unknown>) => Promise<unknown>;
