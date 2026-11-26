import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readJson, writeArtifact } from './artifacts.js';

describe('artifacts', () => {
  it('writes strings and objects, creating parents', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bp-art-'));
    const a = await writeArtifact(dir, 'a/b/c.txt', 'hi');
    expect(await readFile(a.path, 'utf8')).toBe('hi');
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    const o = await writeArtifact(dir, 'x.json', { n: 1 });
    expect(await readFile(o.path, 'utf8')).toContain('\n  "n": 1');
    expect(await readJson(o.path, z.object({ n: z.number() }))).toEqual({ n: 1 });
    await expect(readJson(o.path, z.object({ n: z.string() }))).rejects.toThrow();
  });
  it('rejects absolute and escaping paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bp-art-'));
    await expect(writeArtifact(dir, '/etc/x', 'a')).rejects.toThrow();
    await expect(writeArtifact(dir, '../x', 'a')).rejects.toThrow();
    await expect(writeArtifact(dir, 'a/../../x', 'a')).rejects.toThrow();
  });
});
