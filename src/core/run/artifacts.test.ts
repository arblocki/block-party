import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readJson, writeArtifact } from './artifacts.js';

describe('artifacts links and atomic writes', () => {
  it('replaces a file whole and leaves no temp file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bp-art-'));
    await writeArtifact(dir, 'inputs/x.json', 'one');
    await writeArtifact(dir, 'inputs/x.json', 'two');
    expect(await readFile(join(dir, 'inputs', 'x.json'), 'utf8')).toBe('two');
    expect(await readdir(join(dir, 'inputs'))).toEqual(['x.json']);
  });

  it('refuses a symbolic link at the target and writes nothing through it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bp-art-'));
    const elsewhere = join(await mkdtemp(join(tmpdir(), 'bp-out-')), 'victim.txt');
    await writeFile(elsewhere, 'keep');
    await mkdir(join(dir, 'inputs'));
    await symlink(elsewhere, join(dir, 'inputs', 'rulings.json'));
    await expect(writeArtifact(dir, 'inputs/rulings.json', '[]')).rejects.toThrow(/symbolic link/);
    expect(await readFile(elsewhere, 'utf8')).toBe('keep');
  });

  it('refuses a parent directory that is a link out of the run directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bp-art-'));
    const outside = await mkdtemp(join(tmpdir(), 'bp-out-'));
    await symlink(outside, join(dir, 'inputs'));
    await expect(writeArtifact(dir, 'inputs/rulings.json', '[]')).rejects.toThrow(/outside/);
    expect(await readdir(outside)).toEqual([]);
  });
});

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
