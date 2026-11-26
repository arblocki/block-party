import type { ParsedFile, Side } from '../core/diff/types';
import type { DecisionKind } from '../core/store/runs';
import type { RunStage } from '../core/run/machine';
import type { PrMeta, ReviewEvent } from '../core/github/types';

export type { Hunk, DiffLine, ParsedFile, Side, LineRange } from '../core/diff/types';
export type {
  PrMeta,
  PrSummary,
  RepoSummary,
  ReviewThread,
  ThreadComment,
  ReviewEvent,
} from '../core/github/types';
export type { PrRef, RepoRef } from '../core/pr-ref';

/** The PR a review page is showing. */
export interface SessionInfo {
  label: string;
  pr: { owner: string; repo: string; number: number };
}

/** GET /api/session: the repository and PR the server was started with, if any. */
export interface AppSession {
  label: string;
  repo: { owner: string; repo: string } | null;
  pr: { owner: string; repo: string; number: number } | null;
}

export interface PrResponse {
  pr: PrMeta;
  files: ParsedFile[];
  diffHash: string;
  viewer: string;
  isSelfReview: boolean;
  /** Set when GitHub truncated the file list (3,000-file limit). */
  incomplete?: Incomplete;
}

export interface Incomplete {
  fetchedFiles: number;
  changedFiles: number;
  reason: string;
}

/** Draft as stored by the server. */
export interface Draft {
  id: string;
  path: string;
  side: Side;
  line: number;
  startLine?: number;
  startSide?: Side;
  body: string;
  hunkId?: string;
  headSha: string;
  /** The diff moved and the line no longer maps; goes into the review body. */
  outdated: boolean;
  updatedAt: string;
  revision: number;
}

export type DraftStatus = 'new' | 'dirty' | 'saving' | 'saved' | 'error';

/** A draft being edited locally; `persisted` once the server has a copy. */
export interface LocalDraft extends Omit<Draft, 'updatedAt' | 'revision'> {
  status: DraftStatus;
  persisted: boolean;
  /** Why the last save or delete failed (status 'error'). */
  error?: string;
  /** Deleted in the UI but the server still has it; the delete is retried on sync. */
  pendingDelete?: boolean;
}

export interface SubmitResult {
  reviewUrl: string;
  fallbacks: Draft[];
  /** Drafts written against an older head; they went into the review body. */
  outdated: Draft[];
  /** Ids of drafts edited during submission, so kept rather than deleted. */
  keptDrafts: string[];
}

export type { ReviewEvent as SubmitEvent };

export type { Analysis, AnalysisGroup, GroupKind } from '../core/group/types';
export type { Risk } from '../core/risk/types';

/** GET /api/analysis */
export interface AnalysisResponse {
  analysis: import('../core/group/types').Analysis;
  cached: boolean;
  shared?: boolean;
  /** The PR head and diff hash the analysis was computed for (absent from older servers). */
  headSha?: string;
  diffHash?: string;
  /** Problem with .block-party.yaml (it was ignored). */
  configWarning?: string;
  /** The PR changes .block-party.yaml: the base branch's rules were used instead. */
  configNotice?: string;
}

/** GET /api/providers */
export interface ProvidersResponse {
  current: { provider: string; model: string };
  available: string[];
  models: Record<string, string>;
}

/** GET /api/review-state */
export interface ReviewStateResponse {
  reviewedHunkIds: string[];
  reviewedAt: Record<string, { reviewedAt: string; headSha: string }>;
  verifyChecks: Record<string, { index: number; itemHash: string }[]>;
  reviewBaselineHeadSha?: string;
}

/** GET /api/interdiff */
export interface InterdiffResponse {
  /** Head the reviewer is caught up to; the banner compares from here. */
  reviewBaselineHeadSha: string | null;
  currentHeadSha: string;
  newCommits: { sha: string; message: string; author?: string | null; date?: string | null }[];
  changedFiles: string[];
  newHunkIds: string[];
  compareAvailable: boolean;
  totalCommits: number;
  commitsTruncated: boolean;
  filesTruncated: boolean;
}

/** A run as GET /api/runs and the global stream list it. */
export interface RunSummary {
  id: string;
  title: string;
  stage: RunStage;
  stageNote: string | null;
  owner: string | null;
  repo: string | null;
  branch: string;
  prNumber: number | null;
  createdAt: string;
  updatedAt: string;
  openDecisions: number;
}

/** An inbox item (GET /api/inbox) with the run it belongs to. */
export interface InboxDecision {
  id: number;
  runId: string;
  kind: DecisionKind;
  status: 'open' | 'resolved' | 'dismissed';
  title: string;
  body: string;
  attach: string | null;
  createdAt: string;
  resolvedAt: string | null;
  runTitle: string | null;
  runStage: RunStage | null;
}

/** An inbox decision without the run it was listed with (GET /api/runs/:id). */
export type RunDecision = Omit<InboxDecision, 'runTitle' | 'runStage'>;

export type StageKind =
  'implement' | 'check-fix' | 'review-fix' | 'checks' | 'review' | 'publish' | 'wait-ci';

export type StageState = 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled';

/** One stage execution of a run (GET /api/runs/:id `stages`). */
export interface StageRow {
  id: number;
  runId: string;
  kind: StageKind;
  round: number;
  state: StageState;
  input: unknown;
  output: unknown;
  startedAt: string;
  endedAt: string | null;
}

/** The run row plus its summary fields (GET /api/runs/:id `run`). */
export interface RunDetail extends RunSummary {
  baseRef: string;
  baseSha: string;
  headSha: string | null;
}

export interface RunDetailResponse {
  run: RunDetail;
  stages: StageRow[];
  decisions: RunDecision[];
}

/** One line of a run's event log (GET /api/runs/:id/events and the stream's `run-event`). */
export interface RunEvent {
  id: number;
  runId: string;
  stageId: number | null;
  ts: string;
  type: string;
  payload: unknown;
}

/** GET /api/runs/:id/plan */
export interface RunPlan {
  text: string;
  title: string;
  acceptanceCriteria: string[];
}

export interface ReviewFinding {
  id: string;
  reviewedSha: string;
  severity: 'P0' | 'P1' | 'P2' | 'P3';
  category: string;
  title: string;
  body: string;
  location: { path: string; startLine: number; endLine: number } | null;
  confidence: 'high' | 'medium' | 'low';
  suggestedFix: string | null;
  /** What the implementer answered ('fixed', 'disputed', 'deferred'), when known. */
  resolution: string | null;
  resolutionNote: string | null;
}

export interface ReviewRound {
  round: number;
  reviewedSha: string;
  summary: string;
  findings: ReviewFinding[];
}

/** GET /api/runs/:id/findings */
export interface RunFindings {
  rounds: ReviewRound[];
}
