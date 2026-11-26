import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PLAN_TEMPLATE,
  TASK_BRIEF_TEMPLATE,
  renderBrief,
  renderPlannerBrief,
  type BriefVars,
} from './brief.js';

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

describe('PLAN_TEMPLATE', () => {
  it('equals the fenced block in docs/templates/plan.md', () => {
    const doc = readFileSync(new URL('../../../docs/templates/plan.md', import.meta.url), 'utf8');
    const m = /```markdown\n([\s\S]*?)\n```\n/.exec(doc);
    expect(m).not.toBeNull();
    expect(PLAN_TEMPLATE).toBe(m![1]);
  });
});

describe('renderPlannerBrief', () => {
  const vars = {
    description: 'Add a widget page.\nWith a list.',
    planPath: '/runs/r1/plans/v1.md',
    templatePath: '/runs/r1/inputs/plan-template.md',
    reportPath: '/runs/r1/report.json',
    reportSchemaPath: '/runs/r1/report.schema.json',
  };

  it('tells the planner to explore read-only and write the plan and report', () => {
    const out = renderPlannerBrief(vars);
    expect(out).toContain('Add a widget page.\nWith a list.');
    expect(out).toContain('`/runs/r1/plans/v1.md`');
    expect(out).toContain('`/runs/r1/inputs/plan-template.md`');
    expect(out).toContain('`/runs/r1/report.json`');
    expect(out).toContain('`status: "done"`');
    expect(out).toContain('`status: "blocked"`');
    expect(out).toContain('read-only');
    expect(out).toContain('Acceptance criteria');
    expect(out).toContain('TODO or TBD');
    expect(out).not.toContain('## Revision');
  });

  it('points a revision at the previous version and the feedback', () => {
    const out = renderPlannerBrief({
      ...vars,
      planPath: '/runs/r1/plans/v2.md',
      feedback: 'Split step 3 in two.',
      previousPlanPath: '/runs/r1/plans/v1.md',
    });
    expect(out).toContain('## Revision');
    expect(out).toContain('`/runs/r1/plans/v1.md`');
    expect(out).toContain('Split step 3 in two.');
    expect(out).toContain('`/runs/r1/plans/v2.md`');
  });
});
