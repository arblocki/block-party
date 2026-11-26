import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TASK_BRIEF_TEMPLATE, renderBrief, type BriefVars } from './brief.js';

const base: BriefVars = {
  runTitle: 'Add widget',
  worktreePath: '/wt/x',
  branch: 'bp/x',
  baseRef: 'main',
  baseSha: 'abc123',
  runDir: '/runs/r1',
  planPath: '/runs/r1/plan.md',
  planVersion: 2,
  extraBoundaries: '- extra rule',
  subagentList: 'implementer, explorer',
  checkCommands: '- `pnpm test`',
  stage: 'implement',
};

describe('TASK_BRIEF_TEMPLATE', () => {
  it('equals the fenced block in docs/templates/task-brief.md', () => {
    const doc = readFileSync(
      new URL('../../../docs/templates/task-brief.md', import.meta.url),
      'utf8',
    );
    const m = /```markdown\n([\s\S]*?)\n```\n/.exec(doc);
    expect(m).not.toBeNull();
    expect(TASK_BRIEF_TEMPLATE).toBe(m![1]);
  });
});

describe('renderBrief', () => {
  it('renders the implement stage without the fix section', () => {
    const out = renderBrief(base);
    expect(out).toContain('# Task brief: Add widget');
    expect(out).toContain('version 2');
    expect(out).toContain('- extra rule');
    expect(out).not.toContain('Fix round');
    expect(out).not.toContain('fix rounds');
    expect(out).not.toContain('{{');
    expect(out).toContain("## When you're done");
  });

  it('renders the fix stage with the marker removed', () => {
    const out = renderBrief({
      ...base,
      stage: 'fix',
      round: 3,
      findingsPath: '/runs/r1/findings.json',
      rulingsPath: '/runs/r1/rulings.json',
    });
    expect(out).toContain('## Fix round\n');
    expect(out).not.toContain('_(fix rounds)_');
    expect(out).toContain('This is fix round 3.');
    expect(out).toContain('/runs/r1/findings.json');
    expect(out).toContain('/runs/r1/rulings.json');
  });

  it('inserts values literally without recursive substitution', () => {
    const out = renderBrief({ ...base, extraBoundaries: '- keep {{runTitle}} and $& literal' });
    expect(out).toContain('- keep {{runTitle}} and $& literal');
  });

  it('errors when a fix-stage variable is missing', () => {
    expect(() => renderBrief({ ...base, stage: 'fix' })).toThrow(/round/);
  });
});
