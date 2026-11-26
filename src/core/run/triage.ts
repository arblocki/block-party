import { z } from 'zod';
import type { DiffFile } from '../git/index.js';
import type { Finding } from '../reviewer/findings.js';
import type { DecisionOption, FindingStatus, FindingTriage } from '../store/runs.js';
import type { RunConfig } from './config.js';

/** What the owner decided about a finding, as the implementer and the reviewer see it. */
export const RULING_KINDS = ['fix', 'skip', 'defer', 'uphold', 'accept_dispute'] as const;
export type RulingKind = (typeof RULING_KINDS)[number];

export const RulingSchema = z.object({
  /** `r<round>:<id>` */
  key: z.string().min(1),
  ruling: z.enum(RULING_KINDS),
  note: z.string(),
});
export type Ruling = z.infer<typeof RulingSchema>;

export const TRIAGE_OPTIONS: DecisionOption[] = [
  { id: 'fix', label: 'Fix it' },
  { id: 'skip', label: 'Skip' },
  { id: 'defer', label: 'Defer' },
];

export const DISPUTE_OPTIONS: DecisionOption[] = [
  { id: 'accept_dispute', label: 'Agree, leave it' },
  { id: 'uphold', label: 'Fix it anyway' },
];

export const BROAD_FIX_OPTIONS: DecisionOption[] = [
  { id: 'accept', label: 'Keep the fix' },
  { id: 'stop', label: 'Stop the run' },
];

/** Rulings that mean the reviewer should not raise the finding again. */
export const FINAL_RULINGS: readonly RulingKind[] = ['skip', 'defer', 'accept_dispute'];

/** The status a ruling leaves a finding in (`fix` and `uphold` leave it open). */
export function statusForRuling(r: RulingKind): FindingStatus {
  switch (r) {
    case 'skip':
      return 'skipped';
    case 'defer':
      return 'deferred';
    case 'accept_dispute':
      return 'wont_fix';
    default:
      return 'open';
  }
}

/** `auto_fix` if the severity is in `autoFix`, else `ask` if it is in `ask`, else `record`. */
export function triageOf(
  policy: RunConfig['policy'],
  severity: Finding['severity'],
): FindingTriage {
  if (policy.autoFix.includes(severity)) return 'auto_fix';
  if (policy.ask.includes(severity)) return 'ask';
  return 'record';
}

/** Replaces the ruling for a key (one per finding, the latest wins). */
export function withRuling(rulings: Ruling[], next: Ruling): Ruling[] {
  return [...rulings.filter((r) => r.key !== next.key), next];
}

export function parseRulings(raw: unknown): Ruling[] {
  const parsed = z.array(RulingSchema).safeParse(raw);
  return parsed.success ? parsed.data : [];
}

function where(f: Finding): string {
  if (!f.location) return 'n/a';
  const { path, startLine, endLine } = f.location;
  return `${path}:${startLine}-${endLine}`;
}

function findingLines(f: Finding): string[] {
  return [
    `${f.severity} ${f.title}`,
    `Location: ${where(f)}`,
    '',
    f.body,
    ...(f.suggestedFix ? ['', `Suggested fix: ${f.suggestedFix}`] : []),
  ];
}

export function triageBody(f: Finding): string {
  return findingLines(f).join('\n');
}

export function disputeBody(key: string, f: Finding, note: string): string {
  return [
    `The implementer disputes ${key}.`,
    '',
    ...findingLines(f),
    '',
    `Implementer's note: ${note || '(no note)'}`,
  ].join('\n');
}

export interface FixAssessment {
  files: number;
  lines: number;
  deletedFiles: string[];
  outsideFiles: string[];
  lineBudget: number;
  broad: boolean;
  reasons: string[];
}

/**
 * Whether a fix turn was much broader than the findings it answered: more lines than the
 * per-finding budget allows, a deleted file, or more than `broadFixFiles` files outside the
 * paths the findings point at.
 */
export function assessFix(
  files: DiffFile[],
  fixSet: Finding[],
  policy: RunConfig['policy'],
): FixAssessment {
  const paths = new Set(fixSet.flatMap((f) => (f.location ? [f.location.path] : [])));
  const lines = files.reduce((n, f) => n + f.added + f.deleted, 0);
  const lineBudget = policy.maxFixLinesPerFinding * fixSet.length;
  const deletedFiles = files.filter((f) => f.status === 'D').map((f) => f.path);
  const outsideFiles = files.filter((f) => !paths.has(f.path)).map((f) => f.path);
  const reasons: string[] = [];
  if (lines > lineBudget) reasons.push(`${lines} lines changed, over the budget of ${lineBudget}`);
  if (deletedFiles.length > 0) reasons.push(`deleted ${deletedFiles.length} file(s)`);
  if (outsideFiles.length > policy.broadFixFiles) {
    reasons.push(
      `touched ${outsideFiles.length} files outside the findings' paths (limit ${policy.broadFixFiles})`,
    );
  }
  return {
    files: files.length,
    lines,
    deletedFiles,
    outsideFiles,
    lineBudget,
    broad: reasons.length > 0,
    reasons,
  };
}

export function broadFixBody(a: FixAssessment, files: DiffFile[], findings: number): string {
  return [
    `The fix for ${findings} finding(s) changed ${a.files} file(s) and ${a.lines} line(s): ${a.reasons.join('; ')}.`,
    '',
    'Files:',
    ...files.map((f) => `- ${f.status} ${f.path} (+${f.added} -${f.deleted})`),
  ].join('\n');
}
