/**
 * Task brief template: must stay equal to the fenced block in docs/templates/task-brief.md
 * (a test enforces this).
 */
export const TASK_BRIEF_TEMPLATE = `# Task brief: {{runTitle}}

You are the implementation driver for one block-party run. You own the final state of
the branch. block-party (not you) handles pushing, PRs, CI, and review.

## Where you are

- Working directory: \`{{worktreePath}}\` (a git worktree; stay inside it)
- Branch: \`{{branch}}\`, created from \`{{baseRef}}\` at \`{{baseSha}}\`
- Run directory (for reports and inputs): \`{{runDir}}\`

## What to build

Read the approved plan at \`{{planPath}}\` (version {{planVersion}}). It is the source of
truth. If the plan and this brief disagree, follow the plan and mention it in your report.

## Boundaries

- Change only what the plan needs. The plan's "Out of scope" section is binding.
- Do not add or upgrade dependencies, edit CI configuration, or change lockfiles unless
  the plan says so.
- Do not push, open PRs, rebase onto other branches, or rewrite existing history.
- Never write outside the working directory, except \`{{runDir}}/report.json\`.
{{extraBoundaries}}

## How to work

- Use your subagents for bounded pieces of work: {{subagentList}}.
- When you run subagents in parallel, give each one exclusive ownership of specific files
  or modules, and say so in its instructions. Two subagents must never edit the same file
  at the same time.
- You integrate their work and are responsible for the result being coherent.
- Commit in logical steps with clear messages. Everything must be committed when you
  finish: no uncommitted or untracked files left behind.

## Checks

Run these before reporting done, and fix what fails:

{{checkCommands}}

block-party re-runs them independently; your report doesn't count as proof.

## Fix round _(fix rounds)_

This is fix round {{round}}. Findings to address are in \`{{findingsPath}}\`. For each one:

- **fixed**: change the code, and add or adjust a test when the finding is about behavior.
- **disputed**: if you believe the finding is wrong, don't change the code; explain why,
  with evidence. Your human will rule on it.
- **deferred**: only for findings the plan puts out of scope.

Prior rulings by your human are in \`{{rulingsPath}}\`; don't relitigate them.

## When you're done

Write \`{{runDir}}/report.json\` matching \`report.schema.json\`, then stop and wait.

- \`status: "done"\`: all plan steps implemented, checks pass, everything committed.
- \`status: "blocked"\`: you need a decision you can't make from the plan. Put the question
  in \`questions\` and stop. Don't guess on product or architecture decisions.
- \`status: "partial"\`: you made progress but couldn't finish for a reason other than a
  decision (e.g. a check you can't get passing). Explain in \`summary\`.

Be accurate in \`acceptance\`. "unsure" is better than a wrong "met".`;

export interface BriefVars {
  runTitle: string;
  worktreePath: string;
  branch: string;
  baseRef: string;
  baseSha: string;
  runDir: string;
  planPath: string;
  planVersion: number | string;
  extraBoundaries: string;
  subagentList: string;
  checkCommands: string;
  stage: 'implement' | 'fix';
  round?: number;
  findingsPath?: string;
  rulingsPath?: string;
}

const FIX_MARKER = ' _(fix rounds)_';
const FIX_HEADING = `## Fix round${FIX_MARKER}`;

/** Drops the fix-round section (heading through the line before the next `## ` heading). */
function removeFixSection(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (line === FIX_HEADING) {
      skipping = true;
      continue;
    }
    if (skipping && line.startsWith('## ')) skipping = false;
    if (!skipping) out.push(line);
  }
  return out.join('\n');
}

/**
 * Renders the brief. Substitution is a single pass, so inserted values are literal and
 * never re-scanned. A placeholder with no value is an error.
 */
export function renderBrief(vars: BriefVars): string {
  let text = TASK_BRIEF_TEMPLATE;
  text =
    vars.stage === 'implement' ? removeFixSection(text) : text.replace(FIX_HEADING, '## Fix round');
  const values = vars as unknown as Record<string, unknown>;
  return text.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    const v = values[name];
    if (v === undefined || v === null)
      throw new Error(`Unknown or missing brief variable: ${name}`);
    return String(v);
  });
}

/**
 * Plan template the planner is pointed at: must stay equal to the fenced block in
 * docs/templates/plan.md (a test enforces this).
 */
export const PLAN_TEMPLATE = `# <Short title of the change>

## Goal

<One or two paragraphs: what should be true when this is done, and why it matters. Written
for someone who hasn't seen the conversation that produced the plan.>

## Context

<What exists today that this builds on or changes. Link files as \`path/to/file.ts:123\`.
Mention relevant prior decisions, constraints, and anything surprising you found while
exploring.>

## Approach

<How to build it. Break into numbered steps when order matters. Name the files and modules
each step touches. When parts can be built in parallel, say so and give each part a clear
file/module owner, so Sonnet subagents don't collide.>

1. ...
2. ...

## Acceptance criteria

<Observable, checkable statements. Each one becomes a row in the verify stage's evidence
and in the final review. Prefer "running X shows Y" over "X is implemented". Tag criteria
that can only be checked a certain way, e.g. \`[browser]\`, \`[mcp]\`, \`[db]\`, \`[manual]\`.>

- [ ] ...
- [ ] ...

## Tests

<Which unit/integration tests to add or change, and what they must cover (edge cases,
failure paths).>

## Out of scope

<Things a reasonable implementer might be tempted to do but must not, e.g. refactors,
dependency upgrades, unrelated fixes.>

## Risks and open questions (optional)

<Anything the reviewer should look at extra carefully, and anything still undecided. An
open question that blocks implementation means the plan isn't ready to approve.>`;

export interface PlannerBriefVars {
  /** What the person wants built, as they wrote it. */
  description: string;
  /** Where the plan goes (the planner may write only here, and to `reportPath`). */
  planPath: string;
  /** The plan template, a file the planner reads. */
  templatePath: string;
  reportPath: string;
  /** The JSON Schema of the report. */
  reportSchemaPath: string;
  /** The note that asked for this version (a revision). */
  feedback?: string | null;
  /** The version the feedback is about (a revision). */
  previousPlanPath?: string | null;
}

/** Brief for one planner turn: a first plan, or a revision of the previous version. */
export function renderPlannerBrief(v: PlannerBriefVars): string {
  const revising = Boolean(v.feedback && v.previousPlanPath);
  const lines = [
    '# Planning brief',
    '',
    'You are the planner for one block-party run. You explore the repository read-only and',
    'write an implementation plan; a different agent will implement it once your human',
    'approves it. You do not implement anything.',
    '',
    '## What to plan',
    '',
    v.description,
    '',
  ];
  if (revising) {
    lines.push(
      '## Revision',
      '',
      `Your human read the previous version at \`${v.previousPlanPath}\` and asked for changes:`,
      '',
      v.feedback!,
      '',
      'Write the next version as a complete plan (not a diff), addressing every point. Keep',
      'what the feedback did not question.',
      '',
    );
  }
  lines.push(
    '## How to work',
    '',
    '- Explore the repository first: read the code the change touches, its tests, and any',
    '  docs that constrain it. Cite files as `path/to/file.ts:123` in the plan.',
    '- You are read-only. Do not create, change or delete any file in the repository, and do',
    '  not run git add or git commit. The only files you may write are the plan and the report',
    '  named below; anything else stops the run until a human approves it.',
    '- Ask nothing interactively. If you cannot plan without an answer from your human, write',
    '  the report with `status: "blocked"` and the questions, and stop.',
    '',
    '## The plan',
    '',
    `Write the plan to \`${v.planPath}\`, in the format of the template at`,
    `\`${v.templatePath}\`. Read the template first. block-party validates the plan and sends`,
    'it back to you once if it fails:',
    '',
    '- It has an H1 title and the H2 sections Goal, Approach, Acceptance criteria and Out of',
    '  scope.',
    '- Acceptance criteria has at least one `- [ ]` item; each is observable and checkable.',
    '- No unresolved TODO or TBD in Approach or Acceptance criteria. Decide, or ask in the',
    '  report instead.',
    '',
    'Be specific enough that an implementer who has not seen this conversation can build it:',
    'name files and modules, and say which parts can be built in parallel and who owns each.',
    '',
    '## When you are done',
    '',
    `Write \`${v.reportPath}\` matching \`${v.reportSchemaPath}\`, then stop and wait.`,
    '',
    '- `status: "done"`: the plan is written. Put a short summary in `summary`, and leave',
    '  `acceptance`, `findingResolutions` and `questions` empty.',
    '- `status: "blocked"`: you need an answer first. Put the questions in `questions`.',
  );
  return lines.join('\n');
}
