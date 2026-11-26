import { describe, expect, it } from 'vitest';
import type { Finding } from '../reviewer/findings.js';
import type { FindingRow } from '../store/runs.js';
import type { ReviewRoundInput } from './publish.js';
import { mergedPriorFindings } from './pipeline-helpers.js';

const finding = (id: string): Finding => ({
  id,
  reviewedSha: 'abcdef1',
  severity: 'P1',
  category: 'correctness',
  title: `t ${id}`,
  body: 'b',
  location: { path: 'a.ts', startLine: 1, endLine: 2 },
  confidence: 'high',
  suggestedFix: null,
  repeatOf: null,
});

describe('mergedPriorFindings', () => {
  it('uses rows for rounds that have them and the round file for the rest', () => {
    const rounds: ReviewRoundInput[] = [
      {
        round: 1,
        reviewedSha: 'abcdef1',
        summary: '',
        findings: [finding('f_1_1')],
        resolutions: { f_1_1: { resolution: 'fixed', note: 'done' } },
      },
      {
        round: 2,
        reviewedSha: 'abcdef2',
        summary: '',
        findings: [finding('f_2_1')],
        resolutions: {},
      },
    ];
    const rows = [
      {
        ...finding('f_2_1'),
        runId: 'r',
        round: 2,
        key: 'r2:f_2_1',
        triage: 'auto_fix',
        status: 'disputed',
        resolutionNote: 'no',
        updatedAt: '',
      } as FindingRow,
    ];
    expect(mergedPriorFindings(rounds, rows).map((p) => [p.key, p.status, p.note])).toEqual([
      ['r1:f_1_1', 'fixed', 'done'],
      ['r2:f_2_1', 'disputed', 'no'],
    ]);
  });
});
