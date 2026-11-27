import { describe, expect, it } from 'vitest';
import type { FindingRow } from '../store/runs.js';
import { buildSendBackFeedback } from './send-back.js';

const row = (over: Partial<FindingRow>): FindingRow =>
  ({
    key: 'r1:f_1',
    severity: 'P1',
    title: 'Title',
    body: 'line one\n\n## Heading in body\nline two',
    suggestedFix: 'fix it\nthen test',
    location: { path: 'a.ts', startLine: 1, endLine: 2 },
    ...over,
  }) as FindingRow;

describe('buildSendBackFeedback', () => {
  it('blockquotes the title, body and suggested fix, every line', () => {
    const text = buildSendBackFeedback({ findings: [row({})], comments: [] });
    expect(text).toContain('### r1:f_1 [P1]');
    expect(text).toContain('> Title: Title');
    expect(text).toContain('> line one\n>\n> ## Heading in body\n> line two');
    expect(text).toContain('> Suggested fix: fix it\n> then test');
    expect(text).not.toMatch(/^## Heading in body/m);
  });
});
