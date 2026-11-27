import { describe, expect, it } from 'vitest';
import type { DiffLine, FindingRow, Hunk } from '../types';
import { placeFindings, splitByFile, visibleFindings } from './findingPlacement';

const hunk = (id: string, start: number, lines: DiffLine[]): Hunk => ({
  id,
  path: 'f.ts',
  status: 'modified',
  oldStart: start,
  oldLines: lines.filter((l) => l.type !== 'add').length,
  newStart: start,
  newLines: lines.filter((l) => l.type !== 'del').length,
  header: `@@ -${start} +${start} @@`,
  lines,
});
const add = (n: number, content: string): DiffLine => ({ type: 'add', content, newLine: n });
const ctx = (n: number, content: string): DiffLine => ({
  type: 'context',
  content,
  oldLine: n,
  newLine: n,
});

const finding = (key: string, endLine: number | null, over: Partial<FindingRow> = {}): FindingRow =>
  ({
    runId: 'r',
    round: 1,
    id: key,
    key,
    reviewedSha: 'abc1234',
    severity: 'P1',
    category: 'c',
    title: 't',
    body: 'b',
    location: endLine === null ? null : { path: 'f.ts', startLine: endLine, endLine },
    confidence: 'high',
    suggestedFix: null,
    repeatOf: null,
    triage: 'ask',
    status: 'open',
    resolutionNote: null,
    updatedAt: '',
    ...over,
  }) as FindingRow;

const shown = hunk('h1', 10, [ctx(10, 'a'), add(11, 'b'), ctx(12, 'c')]);
const other = hunk('h2', 50, [add(50, 'x'), add(51, 'y')]);

describe('placeFindings', () => {
  it('puts findings on shown lines inline, others at file level, and locationless unplaced', () => {
    const p = placeFindings(
      [finding('a', 11), finding('b', 30), finding('c', null), finding('d', 12)],
      [shown],
    );
    expect(p.inline.map((f) => f.key)).toEqual(['a', 'd']);
    expect(p.fileLevel.map((f) => f.key)).toEqual(['b']);
    expect(p.unplaced.map((f) => f.key)).toEqual(['c']);
  });

  it('leaves findings on lines of hidden hunks to the card that shows them', () => {
    const p = placeFindings([finding('a', 50), finding('b', 30)], [shown], [other]);
    expect(p.inline).toEqual([]);
    expect(p.fileLevel.map((f) => f.key)).toEqual(['b']);
  });

  it('uses the last line of a range', () => {
    const f = finding('a', 12);
    f.location = { path: 'f.ts', startLine: 2, endLine: 12 };
    expect(placeFindings([f], [shown]).inline).toHaveLength(1);
  });

  it('puts a finding on a whitespace-hidden line at file level', () => {
    expect(placeFindings([finding('a', 11)], []).fileLevel).toHaveLength(1);
  });
});

describe('visibleFindings and splitByFile', () => {
  const paths = new Set(['f.ts']);
  it('keeps current-head findings and still-open older ones in the diff', () => {
    const list = [
      finding('cur', 11),
      finding('old-open', 11, { reviewedSha: 'zzz9999' }),
      finding('old-fixed', 11, { reviewedSha: 'zzz9999', status: 'fixed' }),
      finding('old-elsewhere', 11, {
        reviewedSha: 'zzz9999',
        location: { path: 'g.ts', startLine: 1, endLine: 1 },
      }),
    ];
    expect(visibleFindings(list, 'abc1234def', paths).map((f) => f.key)).toEqual([
      'cur',
      'old-open',
    ]);
  });

  it('splits by file and sends the rest to unplaced', () => {
    const g = finding('g', 1, { location: { path: 'g.ts', startLine: 1, endLine: 1 } });
    const s = splitByFile([finding('a', 11), g, finding('n', null)], paths);
    expect([...s.byPath.keys()]).toEqual(['f.ts']);
    expect(s.unplaced.map((f) => f.key)).toEqual(['g', 'n']);
  });
});
