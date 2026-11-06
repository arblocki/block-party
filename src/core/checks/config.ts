import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import type { ChecksProposal, ProposedCheck } from './propose.js';

const checkSchema = z.object({
  name: z.string().trim().min(1),
  run: z.string().trim().min(1),
  /** Reference to the mirrored CI step: `ci.yml#<job>` or `ci.yml#<job>/<step>`. */
  ci: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
});

export const checksSchema = z.object({
  setup: z.string().trim().min(1).optional(),
  required: z.array(checkSchema).default([]),
  optional: z.array(checkSchema).optional(),
  ciParity: z
    .object({
      workflows: z.array(z.string().min(1)).optional(),
      ignore: z.array(z.string().min(1)).optional(),
    })
    .optional(),
});

export type CheckConfig = z.infer<typeof checkSchema>;
export type ChecksConfig = z.infer<typeof checksSchema>;

/** Parses the text of a .block-party.yaml and returns its `checks:` section, if any. */
export function parseChecksConfig(text: string): ChecksConfig | undefined {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new Error(`invalid YAML: ${(err as Error).message.split('\n')[0]}`, { cause: err });
  }
  const section =
    typeof raw === 'object' && raw !== null ? (raw as { checks?: unknown }).checks : undefined;
  if (section === undefined || section === null) return undefined;
  const parsed = checksSchema.safeParse(section);
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues
        .map((i) => `checks.${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; '),
    );
  }
  return parsed.data;
}

function scalar(s: string): string {
  // Multi-line strings stay inside the flow mapping as a double-quoted scalar with \n escapes.
  if (s.includes('\n')) return JSON.stringify(s);
  return stringifyYaml(s, { lineWidth: 0 }).trimEnd();
}

function renderCheck(c: ProposedCheck): string {
  const parts = [`name: ${scalar(c.name)}`, `run: ${scalar(c.run)}`];
  if (c.ci) parts.push(`ci: ${scalar(c.ci)}`);
  if (c.workingDirectory) parts.push(`cwd: ${scalar(c.workingDirectory)}`);
  return `{ ${parts.join(', ')} }`;
}

/**
 * Renders a proposal as `.block-party.yaml` text for the user to review. Checks that need review
 * are commented out with the reason so they cannot be accepted by accident.
 */
export function renderChecksYaml(p: ChecksProposal): string {
  const lines: string[] = [];
  for (const w of p.warnings) lines.push(`# ${w}`);
  lines.push('checks:');
  if (p.setup) lines.push(`  setup: ${scalar(p.setup)}`);
  lines.push(p.checks.some((c) => !c.needsReview) ? '  required:' : '  required: []');
  for (const c of p.checks) {
    for (const n of c.notes ?? []) lines.push(`    # ${n}`);
    if (c.needsReview) {
      lines.push(`    # NEEDS REVIEW: ${c.needsReview}`);
      lines.push(`    # - ${renderCheck(c)}`);
    } else {
      lines.push(`    - ${renderCheck(c)}`);
    }
  }
  if (p.source === 'workflows') {
    lines.push('  ciParity:');
    lines.push(
      `    workflows: ${stringifyYaml(p.workflows, { collectionStyle: 'flow', lineWidth: 0 }).trimEnd()}`,
    );
    lines.push('    ignore: []');
  }
  return `${lines.join('\n')}\n`;
}
