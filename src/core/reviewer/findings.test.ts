import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CategorySchema,
  ReviewerOutputSchema,
  SeveritySchema,
  lastAgentMessage,
  parseEvents,
  parseReviewerOutput,
} from './findings.js';
import { renderReviewPrompt } from './prompt.js';
import { FINDINGS_JSON_SCHEMA, writeFindingsSchema } from './schema.js';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SHA = 'a'.repeat(40);

const finding = {
  id: 'f_1',
  reviewedSha: SHA,
  severity: 'P1',
  category: 'e2e',
  title: 'Broken',
  body: 'It is broken',
  location: { path: 'src/a.ts', startLine: 1, endLine: 2 },
  confidence: 'high',
  suggestedFix: null,
};
const output = { reviewedSha: SHA, summary: 'one issue', findings: [finding] };

describe('parseReviewerOutput', () => {
  it('parses valid output', () => {
    const r = parseReviewerOutput(JSON.stringify(output), SHA);
    expect(r).toMatchObject({ ok: true, value: { summary: 'one issue' } });
  });

  it('tolerates a fenced JSON block', () => {
    const r = parseReviewerOutput(`\`\`\`json\n${JSON.stringify(output)}\n\`\`\``);
    expect(r.ok).toBe(true);
  });

  it('rejects invalid JSON and keeps the raw text', () => {
    const r = parseReviewerOutput('  nope ');
    expect(r).toMatchObject({ ok: false, raw: 'nope' });
    expect(!r.ok && r.error).toMatch(/not valid JSON/);
  });

  it('names the failing path on a schema violation', () => {
    const bad = { ...output, findings: [{ ...finding, severity: 'P9' }] };
    const r = parseReviewerOutput(JSON.stringify(bad));
    expect(!r.ok && r.error).toContain('findings.0.severity');
  });

  it('rejects an expected-sha mismatch', () => {
    const r = parseReviewerOutput(JSON.stringify(output), 'b'.repeat(40));
    expect(!r.ok && r.error).toMatch(/!= expected/);
  });

  it('rejects a finding whose reviewedSha differs from the output', () => {
    const bad = { ...output, findings: [{ ...finding, reviewedSha: 'c'.repeat(40) }] };
    const r = parseReviewerOutput(JSON.stringify(bad));
    expect(!r.ok && r.error).toContain('f_1 has mismatched reviewedSha');
  });

  it('matches short and long SHAs by prefix in both directions', () => {
    expect(parseReviewerOutput(JSON.stringify(output), SHA.slice(0, 7)).ok).toBe(true);
    const short = { ...output, reviewedSha: SHA.slice(0, 8) };
    expect(parseReviewerOutput(JSON.stringify(short), SHA).ok).toBe(true); // long finding sha, short output sha
    const shortAll = {
      ...short,
      findings: [{ ...finding, reviewedSha: SHA.slice(0, 8) }],
    };
    expect(parseReviewerOutput(JSON.stringify(shortAll), SHA).ok).toBe(true);
  });

  it('accepts an empty findings list', () => {
    const r = parseReviewerOutput(JSON.stringify({ ...output, findings: [] }));
    expect(r.ok).toBe(true);
  });
});

describe('parseEvents / lastAgentMessage', () => {
  it('skips non-JSON lines and picks the last agent_message', () => {
    const lines = [
      'warning: something',
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'first' } }),
      '{broken',
      JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', text: 'x' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'second' } }),
      JSON.stringify({ type: 'turn.completed', usage: {} }),
    ].join('\n');
    const events = parseEvents(lines);
    expect(events).toHaveLength(4);
    expect(lastAgentMessage(events)).toBe('second');
  });

  it('returns undefined when there is no agent_message', () => {
    expect(lastAgentMessage(parseEvents('{"type":"turn.completed"}'))).toBeUndefined();
  });
});

type Json = Record<string, unknown>;

/** Collect every object schema (anything with `properties`) reachable from `node`. */
function objectSchemas(node: unknown, out: Json[] = []): Json[] {
  if (Array.isArray(node)) node.forEach((n) => objectSchemas(n, out));
  else if (node && typeof node === 'object') {
    const o = node as Json;
    if (o.properties) out.push(o);
    Object.values(o).forEach((v) => objectSchemas(v, out));
  }
  return out;
}

describe('FINDINGS_JSON_SCHEMA parity', () => {
  it('lists every property as required and forbids additional properties', () => {
    const objects = objectSchemas(FINDINGS_JSON_SCHEMA);
    expect(objects).toHaveLength(3); // root, finding, location
    for (const o of objects) {
      expect([...(o.required as string[])].sort()).toEqual(
        Object.keys(o.properties as Json).sort(),
      );
      expect(o.additionalProperties).toBe(false);
    }
  });

  it('has the same property names and enums as the zod schema', () => {
    const zodSchema = z.toJSONSchema(ReviewerOutputSchema) as unknown as Json;
    const pick = (s: Json) => {
      const item = ((s.properties as Json).findings as Json).items as Json;
      return item.properties as Record<string, Json>;
    };
    const ours = pick(FINDINGS_JSON_SCHEMA as unknown as Json);
    const theirs = pick(zodSchema);
    expect(Object.keys(ours).sort()).toEqual(Object.keys(theirs).sort());
    for (const k of ['severity', 'category', 'confidence'] as const) {
      expect(ours[k]?.enum).toEqual(theirs[k]?.enum);
    }
    expect(ours.severity?.enum).toEqual(SeveritySchema.options);
    expect(ours.category?.enum).toEqual(CategorySchema.options);
    expect(CategorySchema.options).toContain('e2e');
    expect(Object.keys((zodSchema.properties as Json) ?? {}).sort()).toEqual(
      Object.keys((FINDINGS_JSON_SCHEMA as unknown as { properties: Json }).properties).sort(),
    );
  });

  it('writeFindingsSchema writes the schema into the directory', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'bp-schema-')), 'nested');
    const path = await writeFindingsSchema(dir);
    expect(path).toBe(join(dir, 'findings.schema.json'));
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(FINDINGS_JSON_SCHEMA);
  });
});

describe('renderReviewPrompt', () => {
  const base = { planPath: 'plan.md', baseSha: 'b'.repeat(40), headSha: 'h'.repeat(40) };

  it('fills placeholders and renders a first round', () => {
    const p = renderReviewPrompt({ ...base, priorFindings: [] });
    expect(p).toContain('`plan.md`');
    expect(p).toContain(`git diff ${base.baseSha}..${base.headSha}`);
    expect(p).toContain('(none: first round)');
    expect(p).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('renders one bullet per prior finding', () => {
    const p = renderReviewPrompt({
      ...base,
      priorFindings: [
        {
          id: 'f_1_2',
          severity: 'P1',
          title: 'title',
          location: 'src/a.ts:10-14',
          resolution: 'fixed',
          note: 'done',
        },
        {
          id: 'f_1_3',
          severity: 'P2',
          title: 't2',
          location: 'b.ts:1-1',
          resolution: 'skip',
          note: 'n',
        },
      ],
    });
    expect(p).toContain('- [P1] f_1_2 "title" at src/a.ts:10-14 — resolution: fixed — done');
    expect(p).toContain('- [P2] f_1_3 "t2" at b.ts:1-1 — resolution: skip — n');
    expect(p).not.toContain('(none: first round)');
  });

  it('does not re-substitute placeholders found inside values', () => {
    const p = renderReviewPrompt({
      ...base,
      planPath: 'x/{{HEAD_SHA}}/plan.md',
      priorFindings: [],
    });
    expect(p).toContain('x/{{HEAD_SHA}}/plan.md');
    const q = renderReviewPrompt({
      ...base,
      priorFindings: [
        {
          id: 'f',
          severity: 'P3',
          title: '{{BASE_SHA}}',
          location: 'l',
          resolution: 'r',
          note: 'n',
        },
      ],
    });
    expect(q).toContain('"{{BASE_SHA}}"');
  });
});
