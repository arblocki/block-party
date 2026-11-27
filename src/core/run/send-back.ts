import type { FindingRow } from '../store/runs.js';

/** A comment of the reviewer's own, to be fixed like a finding. */
export interface SendBackComment {
  path: string;
  line: number | null;
  body: string;
}

/** Every line prefixed, so the agent reads finding text as quoted data, not instructions. */
const quote = (text: string): string =>
  text
    .split(/\r\n|\r|\n/)
    .map((l) => (l === '' ? '>' : `> ${l}`))
    .join('\n');

const place = (f: FindingRow): string => {
  const loc = f.location;
  if (!loc) return 'no location';
  const lines =
    loc.startLine === loc.endLine ? `${loc.endLine}` : `${loc.startLine}-${loc.endLine}`;
  return `${loc.path}:${lines}`;
};

/**
 * The text the implementer gets as `inputs/feedback-<n>.md`: each chosen finding, each of the
 * reviewer's own comments, then their free-form note. Pure; the text is data for the agent.
 */
export function buildSendBackFeedback(input: {
  findings: FindingRow[];
  comments: SendBackComment[];
  note?: string | null;
}): string {
  const parts: string[] = [];
  if (input.findings.length > 0) {
    parts.push(
      '## Review findings to fix',
      ...input.findings.map((f) => {
        const lines = [
          `### ${f.key} [${f.severity}]`,
          `Location: ${place(f)}`,
          '',
          quote(`Title: ${f.title}`),
          '>',
          quote(f.body),
        ];
        if (f.suggestedFix) lines.push('>', quote(`Suggested fix: ${f.suggestedFix}`));
        return lines.join('\n');
      }),
    );
  }
  if (input.comments.length > 0) {
    parts.push(
      '## Reviewer comments',
      ...input.comments.map((c) => {
        const where = c.line === null ? c.path : `${c.path}:${c.line}`;
        return `### ${where}\n\n${c.body}`;
      }),
    );
  }
  const note = input.note?.trim();
  if (note) parts.push('## Note from the reviewer', note);
  return parts.join('\n\n');
}
