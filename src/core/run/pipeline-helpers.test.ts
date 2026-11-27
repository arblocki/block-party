import { describe, expect, it } from 'vitest';
import type { Finding } from '../reviewer/findings.js';
import type { FindingRow } from '../store/runs.js';
import type { ReviewRoundInput } from './publish.js';
import type { CheckResult } from '../checks/run.js';
import { mergedPriorFindings, renderCiFailures } from './pipeline-helpers.js';

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
    const withRuling = mergedPriorFindings(rounds, rows, [
      { key: 'r1:f_1_1', ruling: 'skip', note: 'later' },
    ]);
    expect(withRuling.map((p) => [p.key, p.ruling, p.rulingNote])).toEqual([
      ['r1:f_1_1', 'skip', 'later'],
      ['r2:f_2_1', undefined, undefined],
    ]);
  });
});

describe('renderCiFailures', () => {
  const local = (name: string, exitCode: number | null): CheckResult => ({
    name,
    command: `pnpm ${name}`,
    cwd: '/w',
    exitCode,
    durationMs: 1,
    timedOut: false,
    logPath: '/l',
  });

  it('lists failed GitHub checks with conclusions and URLs, and the local checks that passed', () => {
    const out = renderCiFailures(
      [
        { name: 'build', status: 'completed', conclusion: 'failure', url: 'https://gh/1' },
        { name: 'lint', status: 'completed', conclusion: 'success', url: 'https://gh/2' },
        { name: 'e2e', status: 'completed', conclusion: 'timed_out', url: 'https://gh/3' },
        { name: 'slow', status: 'in_progress', conclusion: null, url: 'https://gh/4' },
      ],
      'abcdef1234567',
      [local('typecheck', 0), local('test', 1)],
    );
    expect(out).toContain('abcdef1');
    expect(out).toContain('- build: failure (https://gh/1)');
    expect(out).toContain('- e2e: timed_out (https://gh/3)');
    expect(out).not.toContain('lint');
    expect(out).not.toContain('slow');
    expect(out).toContain('- typecheck: `pnpm typecheck`');
    expect(out).not.toContain('pnpm test');
    expect(out).toContain('parity gap');
  });
});
