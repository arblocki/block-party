import { z } from 'zod';

/** Zod mirror of findings.schema.json (ARCHITECTURE 3.3 finding schema + wrapper). */
export const SeveritySchema = z.enum(['P0', 'P1', 'P2', 'P3']);
export const CategorySchema = z.enum([
  'correctness',
  'security',
  'concurrency',
  'data-loss',
  'tests',
  'design',
  'style',
  'other',
]);

export const LocationSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
});

export const FindingSchema = z.object({
  id: z.string().min(1),
  reviewedSha: z.string().min(7),
  severity: SeveritySchema,
  category: CategorySchema,
  title: z.string().min(1),
  body: z.string().min(1),
  location: LocationSchema.nullable(),
  confidence: z.enum(['high', 'medium', 'low']),
  suggestedFix: z.string().nullable(),
});

export const ReviewerOutputSchema = z.object({
  reviewedSha: z.string().min(7),
  summary: z.string(),
  findings: z.array(FindingSchema),
});

export type Finding = z.infer<typeof FindingSchema>;
export type ReviewerOutput = z.infer<typeof ReviewerOutputSchema>;

export type ParseResult =
  { ok: true; value: ReviewerOutput } | { ok: false; error: string; raw: string };

/** Validate the final agent message text (option 2). The error string is fit for a retry prompt. */
export function parseReviewerOutput(text: string, expectedSha?: string): ParseResult {
  const raw = text.trim();
  // The model is told "no fences", but tolerate one fenced block.
  const body = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(raw)?.[1] ?? raw;
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${(e as Error).message}`, raw };
  }
  const parsed = ReviewerOutputSchema.safeParse(json);
  if (!parsed.success) {
    const error = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    return { ok: false, error: error.join('; '), raw };
  }
  const value = parsed.data;
  if (expectedSha && !sameSha(value.reviewedSha, expectedSha)) {
    return {
      ok: false,
      error: `reviewedSha ${value.reviewedSha} != expected ${expectedSha}`,
      raw,
    };
  }
  const stale = value.findings.find((f) => !sameSha(f.reviewedSha, value.reviewedSha));
  if (stale) return { ok: false, error: `finding ${stale.id} has mismatched reviewedSha`, raw };
  return { ok: true, value };
}

function sameSha(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a);
}

interface StreamItem {
  type?: string;
  text?: unknown;
}
interface StreamEvent {
  type?: string;
  item?: StreamItem;
  usage?: Record<string, unknown>;
  error?: { message?: unknown };
  message?: unknown;
}

/** Parse a `codex exec --json` stdout capture into events, skipping non-JSON lines. */
export function parseEvents(stdout: string): StreamEvent[] {
  const out: StreamEvent[] = [];
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      out.push(JSON.parse(t) as StreamEvent);
    } catch {
      /* ignore */
    }
  }
  return out;
}

export function lastAgentMessage(events: StreamEvent[]): string | undefined {
  let last: string | undefined;
  for (const ev of events) {
    if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') {
      if (typeof ev.item.text === 'string') last = ev.item.text;
    }
  }
  return last;
}

/**
 * Option 1 (`codex review`): the result is free prose. We can only wrap it, never turn it into
 * findings without an LLM or a brittle regex. This deliberately does NOT return an empty
 * findings list: callers must treat `unstructured` as "needs extraction", not "clean".
 */
export interface UnstructuredReview {
  unstructured: true;
  text: string;
  /** Best-effort pickup of "[P1] Title - path:10-12" style headings, if the model used them. */
  heuristicFindings: { severity: string; title: string; path?: string; startLine?: number }[];
}

export function normalizeProseReview(text: string): UnstructuredReview {
  const heuristicFindings: UnstructuredReview['heuristicFindings'] = [];
  const re = /^[-*]?\s*\[(P[0-3])\]\s*(.+?)(?:\s+[-—–]\s+(\S+?):(\d+)(?:-\d+)?)?\s*$/gm;
  for (const m of text.matchAll(re)) {
    const [, severity, title, path, line] = m;
    if (!severity || !title) continue;
    heuristicFindings.push({
      severity,
      title,
      ...(path && line ? { path, startLine: Number(line) } : {}),
    });
  }
  return { unstructured: true, text: text.trim(), heuristicFindings };
}
