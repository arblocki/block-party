import { describe, expect, it } from 'vitest';
import type { FindingRow } from '../types';
import { findingHistory } from './findings';

function row(round: number, id: string, repeatOf: string | null = null): FindingRow {
  return {
    runId: 'r1',
    round,
    id,
    key: `r${round}:${id}`,
    reviewedSha: 'abcdef1',
    severity: 'P1',
    category: 'correctness',
    title: `t ${id}`,
    body: 'b',
    location: null,
    confidence: 'high',
    suggestedFix: null,
    repeatOf,
    triage: 'auto_fix',
    status: 'open',
    resolutionNote: null,
    updatedAt: '',
  };
}

describe('findingHistory', () => {
  const rows = [
    row(1, 'f_1_1'),
    row(1, 'f_1_2'),
    row(2, 'f_2_1', 'r1:f_1_1'),
    row(3, 'f_3_1', 'r2:f_2_1'),
    row(3, 'f_3_2'),
  ];

  it('returns the chain oldest first from any member', () => {
    const keys = ['r1:f_1_1', 'r2:f_2_1', 'r3:f_3_1'];
    for (const k of keys) expect(findingHistory(rows, k).map((r) => r.key)).toEqual(keys);
  });

  it('returns just the finding when it neither repeats nor is repeated', () => {
    expect(findingHistory(rows, 'r1:f_1_2').map((r) => r.key)).toEqual(['r1:f_1_2']);
  });

  it('stops at a missing link', () => {
    const broken = [row(2, 'f_2_1', 'r1:gone'), row(3, 'f_3_1', 'r2:f_2_1')];
    expect(findingHistory(broken, 'r3:f_3_1').map((r) => r.key)).toEqual(['r2:f_2_1', 'r3:f_3_1']);
  });

  it('is empty for an unknown key and survives a cycle', () => {
    expect(findingHistory(rows, 'r9:nope')).toEqual([]);
    const loop = [row(1, 'a', 'r2:b'), row(2, 'b', 'r1:a')];
    expect(findingHistory(loop, 'r1:a')).toHaveLength(2);
  });
});
