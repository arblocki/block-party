import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { z } from 'zod';

/** Writes a file under runDir; returns its absolute path and sha256 hex of the content. */
export async function writeArtifact(
  runDir: string,
  relPath: string,
  content: string | object,
): Promise<{ path: string; hash: string }> {
  if (isAbsolute(relPath)) throw new Error(`Artifact path must be relative: ${relPath}`);
  const root = resolve(runDir);
  const path = resolve(join(root, relPath));
  const rel = relative(root, path);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Artifact path escapes run directory: ${relPath}`);
  }
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n';
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  return { path, hash: createHash('sha256').update(text).digest('hex') };
}

export async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(JSON.parse(await readFile(path, 'utf8')));
}
