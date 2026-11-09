import { describe, expect, it } from 'vitest';
import { parsePlan } from './plan.js';

const good = `# My change

## Goal

Do it.

## Approach

1. Step

## Acceptance criteria

- [ ] Thing works [browser]
- [x] Other

## Out of scope

Nothing.
`;

describe('parsePlan', () => {
  it('parses a valid plan', () => {
    const r = parsePlan(good);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.title).toBe('My change');
    expect(r.plan.acceptanceCriteria).toEqual(['Thing works [browser]', 'Other']);
    expect(r.plan.sections['goal']).toBe('Do it.');
    expect(r.plan.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const again = parsePlan(good);
    expect(again.ok && again.plan.contentHash).toBe(r.plan.contentHash);
    const edited = parsePlan(good + '\nmore');
    expect(edited.ok && edited.plan.contentHash).not.toBe(r.plan.contentHash);
  });
  it('reports missing title and sections', () => {
    const r = parsePlan('## Goal\n\nx\n');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toContain('Missing H1 title');
    expect(r.errors).toContain('Missing section: Approach');
    expect(r.errors).toContain('Missing section: Out of scope');
  });
  it('matches headings case-insensitively', () => {
    expect(parsePlan(good.replace('## Goal', '## GOAL')).ok).toBe(true);
  });
  it('requires a checklist item', () => {
    const r = parsePlan(good.replace(/- \[.\].*\n/g, 'plain\n'));
    expect(r.ok).toBe(false);
  });
  it('rejects TODO/TBD whole words in Approach and Acceptance', () => {
    expect(parsePlan(good.replace('1. Step', '1. TODO later')).ok).toBe(false);
    expect(parsePlan(good.replace('Other', 'TBD')).ok).toBe(false);
    expect(parsePlan(good.replace('Do it.', 'TODO')).ok).toBe(true); // not checked in Goal
    expect(parsePlan(good.replace('1. Step', 'TODOS and todo')).ok).toBe(true);
  });
  it('ignores headings and TODOs inside code fences', () => {
    const fenced = good.replace('1. Step', '```md\n## Fake\nTODO\n```\n1. Step');
    const r = parsePlan(fenced);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.sections['fake']).toBeUndefined();
    const hidden = parsePlan('```\n# T\n## Goal\n```\n');
    expect(hidden.ok).toBe(false);
  });
  it('handles nested fences by marker length and char', () => {
    const nested = good.replace(
      '1. Step',
      '````markdown\n## Fake\n```ts\nx\n```\nTODO sample\n````\n1. Step',
    );
    const r = parsePlan(nested);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.sections['fake']).toBeUndefined();
    // ~~~ does not close a ``` fence; closing line with info text does not close.
    const tilde = good.replace('1. Step', '```\n~~~\nTODO\n```x\n```\n1. Step');
    expect(parsePlan(tilde).ok).toBe(true);
    // document-in-a-fence like docs/templates/plan.md
    const doc = '```markdown\n# T\n\n## Goal\n\n- [ ] x\n```\n';
    expect(parsePlan(doc).ok).toBe(false);
    // after a proper close, TODO is caught again
    expect(parsePlan(good.replace('1. Step', '```\nx\n```\nTODO')).ok).toBe(false);
  });
});
