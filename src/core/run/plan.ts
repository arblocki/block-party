import { createHash } from 'node:crypto';

export interface Plan {
  title: string;
  sections: Record<string, string>;
  acceptanceCriteria: string[];
  contentHash: string;
}

export type ParsePlanResult = { ok: true; plan: Plan } | { ok: false; errors: string[] };

const REQUIRED = ['Goal', 'Approach', 'Acceptance criteria', 'Out of scope'];
const FENCE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;

export function parsePlan(markdown: string): ParsePlanResult {
  const errors: string[] = [];
  const lines = markdown.split(/\r?\n/);

  let title: string | null = null;
  let current: string | null = null;
  const bodies = new Map<string, string[]>();
  const proseBodies = new Map<string, string[]>(); // outside code fences
  let fence: string | null = null;

  for (const line of lines) {
    const f = FENCE.exec(line);
    if (f) {
      const run = f[1]!;
      const rest = f[2]!;
      if (fence === null) {
        // Backtick fences cannot have backticks in the info string.
        if (!(run[0] === '`' && rest.includes('`'))) fence = run;
      } else if (run[0] === fence[0] && run.length >= fence.length && rest.trim() === '') {
        fence = null;
      }
      if (current) bodies.get(current)!.push(line);
      continue;
    }
    if (fence === null) {
      const h1 = /^#\s+(.+?)\s*#*\s*$/.exec(line);
      if (h1 && title === null) {
        title = h1[1]!.trim();
        continue;
      }
      const h2 = /^##\s+(.+?)\s*#*\s*$/.exec(line);
      if (h2) {
        current = h2[1]!.trim().toLowerCase();
        if (!bodies.has(current)) {
          bodies.set(current, []);
          proseBodies.set(current, []);
        }
        continue;
      }
      if (current) proseBodies.get(current)!.push(line);
    }
    if (current) bodies.get(current)!.push(line);
  }

  if (!title) errors.push('Missing H1 title');
  for (const name of REQUIRED) {
    if (!bodies.has(name.toLowerCase())) errors.push(`Missing section: ${name}`);
  }

  const acceptanceCriteria: string[] = [];
  const acc = proseBodies.get('acceptance criteria');
  if (acc) {
    for (const line of acc) {
      const m = /^\s*[-*]\s+\[[ xX]\]\s+(.*\S)\s*$/.exec(line);
      if (m) acceptanceCriteria.push(m[1]!);
    }
    if (acceptanceCriteria.length === 0) {
      errors.push('Acceptance criteria needs at least one "- [ ]" item');
    }
  }

  for (const name of ['Approach', 'Acceptance criteria']) {
    const prose = proseBodies.get(name.toLowerCase());
    if (prose && /\b(TODO|TBD)\b/.test(prose.join('\n'))) {
      errors.push(`Unresolved TODO/TBD in ${name}`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const sections: Record<string, string> = {};
  for (const [k, v] of bodies) sections[k] = v.join('\n').trim();
  return {
    ok: true,
    plan: {
      title: title!,
      sections,
      acceptanceCriteria,
      contentHash: createHash('sha256').update(markdown).digest('hex'),
    },
  };
}
