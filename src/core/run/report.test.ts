import { mkdtemp, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReportObjectSchema, ReportSchema, readReport, type ReadReportResult } from './report.js';

const valid = {
  status: 'done',
  summary: 's',
  acceptance: [{ criterion: 'c', status: 'met', evidence: 'e' }],
  questions: [],
  findingResolutions: [],
};

describe('ReportSchema', () => {
  it('accepts a valid report and rejects extras', () => {
    expect(ReportSchema.safeParse(valid).success).toBe(true);
    expect(ReportSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
  });
  it('requires questions iff blocked', () => {
    expect(ReportSchema.safeParse({ ...valid, status: 'blocked' }).success).toBe(false);
    expect(ReportSchema.safeParse({ ...valid, status: 'blocked', questions: ['q?'] }).success).toBe(
      true,
    );
    expect(ReportSchema.safeParse({ ...valid, questions: ['q?'] }).success).toBe(false);
  });
  it('matches the JSON schema template', () => {
    const json = JSON.parse(
      readFileSync(new URL('../../../docs/templates/report.schema.json', import.meta.url), 'utf8'),
    );
    const shape = ReportObjectSchema.shape;
    expect(Object.keys(shape).sort()).toEqual([...json.required].sort());
    expect(Object.keys(json.properties).sort()).toEqual(Object.keys(shape).sort());
    expect([...shape.status.options]).toEqual(json.properties.status.enum);
    const acc = shape.acceptance.element.shape;
    const accJson = json.properties.acceptance.items;
    expect(Object.keys(acc).sort()).toEqual([...accJson.required].sort());
    expect([...acc.status.options]).toEqual(accJson.properties.status.enum);
    const fr = shape.findingResolutions.element.shape;
    const frJson = json.properties.findingResolutions.items;
    expect(Object.keys(fr).sort()).toEqual([...frJson.required].sort());
    expect([...fr.resolution.options]).toEqual(frJson.properties.resolution.enum);
  });
});

describe('readReport', () => {
  it('handles missing, invalid and valid files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bp-report-'));
    const p = join(dir, 'report.json');
    expect(await readReport(p)).toEqual({ ok: false, missing: true });
    await writeFile(p, '{nope');
    const bad = (await readReport(p)) as Extract<ReadReportResult, { error: string }>;
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/JSON/);
    await writeFile(p, JSON.stringify({ ...valid, status: 'blocked' }));
    expect((await readReport(p)).ok).toBe(false);
    await writeFile(p, JSON.stringify(valid));
    const ok = await readReport(p);
    expect(ok.ok && 'report' in ok && ok.report.status).toBe('done');
  });
});
