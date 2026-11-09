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
