import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** JSON Schema handed to `codex exec --output-schema`. Mirrors the zod schemas in findings.ts. */
export const FINDINGS_JSON_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'ReviewerOutput',
  type: 'object',
  additionalProperties: false,
  required: ['reviewedSha', 'summary', 'findings'],
  properties: {
    reviewedSha: {
      type: 'string',
    },
    summary: {
      type: 'string',
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'reviewedSha',
          'severity',
          'category',
          'title',
          'body',
          'location',
          'confidence',
          'suggestedFix',
          'repeatOf',
        ],
        properties: {
          id: {
            type: 'string',
          },
          reviewedSha: {
            type: 'string',
          },
          severity: {
            type: 'string',
            enum: ['P0', 'P1', 'P2', 'P3'],
          },
          category: {
            type: 'string',
            enum: [
              'correctness',
              'security',
              'concurrency',
              'data-loss',
              'tests',
              'design',
              'style',
              'e2e',
              'other',
            ],
          },
          title: {
            type: 'string',
          },
          body: {
            type: 'string',
          },
          location: {
            anyOf: [
              {
                type: 'object',
                additionalProperties: false,
                required: ['path', 'startLine', 'endLine'],
                properties: {
                  path: {
                    type: 'string',
                  },
                  startLine: {
                    type: 'integer',
                  },
                  endLine: {
                    type: 'integer',
                  },
                },
              },
              {
                type: 'null',
              },
            ],
          },
          confidence: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
          },
          suggestedFix: {
            type: ['string', 'null'],
          },
          repeatOf: {
            type: ['string', 'null'],
          },
        },
      },
    },
  },
} as const;

/** Write the schema as `findings.schema.json` into `dir` (created if needed); returns its path. */
export async function writeFindingsSchema(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'findings.schema.json');
  await writeFile(path, `${JSON.stringify(FINDINGS_JSON_SCHEMA, null, 2)}\n`);
  return path;
}
