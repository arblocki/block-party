import { readFile } from 'node:fs/promises';
import { z } from 'zod';

export const ReportObjectSchema = z.strictObject({
  status: z.enum(['done', 'blocked', 'partial']),
  summary: z.string().min(1).max(4000),
  acceptance: z.array(
    z.strictObject({
      criterion: z.string().min(1),
      status: z.enum(['met', 'not_met', 'unsure']),
      evidence: z.string(),
    }),
  ),
  questions: z.array(z.string().min(1)),
  /** Only for a turn that answers send-back feedback: whether any code was changed. */
  feedbackOutcome: z.enum(['changed', 'no_changes']).optional(),
  findingResolutions: z.array(
    z.strictObject({
      findingId: z.string().min(1),
      resolution: z.enum(['fixed', 'disputed', 'deferred']),
      note: z.string(),
    }),
  ),
});

export const ReportSchema = ReportObjectSchema.superRefine((r, ctx) => {
  if (r.status === 'blocked' && r.questions.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['questions'],
      message: 'questions must be non-empty when status is blocked',
    });
  }
  if (r.status !== 'blocked' && r.questions.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['questions'],
      message: 'questions must be empty unless status is blocked',
    });
  }
});

export type Report = z.infer<typeof ReportSchema>;

export type ReadReportResult =
  { ok: true; report: Report } | { ok: false; error: string } | { ok: false; missing: true };

export async function readReport(path: string): Promise<ReadReportResult> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, missing: true };
    return { ok: false, error: `Cannot read report: ${(e as Error).message}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` };
  }
  const parsed = ReportSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; '),
    };
  }
  return { ok: true, report: parsed.data };
}

/** The kinds of stage that produce an implementer report, in their fallback order. */
export const TURN_KINDS: readonly string[] = ['implement', 'check-fix', 'review-fix', 'feedback'];

/**
 * Puts reports in turn order: the order of the run's stage rows, then any report the rows do
 * not list by kind and round. Each stage row's report is used once.
 */
export function orderTurns<T extends { kind: string; round: number }>(
  reports: readonly T[],
  stages: readonly { kind: string; round: number }[],
): T[] {
  const found = new Map(reports.map((r) => [`${r.kind}-${r.round}`, r]));
  const ordered: T[] = [];
  for (const st of stages) {
    const key = `${st.kind}-${st.round}`;
    const turn = found.get(key);
    if (turn) {
      ordered.push(turn);
      found.delete(key);
    }
  }
  const rest = [...found.values()].sort(
    (a, b) => TURN_KINDS.indexOf(a.kind) - TURN_KINDS.indexOf(b.kind) || a.round - b.round,
  );
  return [...ordered, ...rest];
}
