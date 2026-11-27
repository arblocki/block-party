import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
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
  // An agent can create files in the run directory: never write through a link it planted,
  // whether at the target or as a parent directory that points elsewhere.
  const realRoot = await realpath(root);
  const realDir = await realpath(dirname(path));
  const within = relative(realRoot, realDir);
  if (within.startsWith('..') || isAbsolute(within)) {
    throw new Error(`Artifact directory is outside the run directory: ${relPath}`);
  }
  const existing = await lstat(path).catch(() => null);
  if (existing?.isSymbolicLink()) throw new Error(`Artifact path is a symbolic link: ${relPath}`);
  // Write whole, then move into place, so a reader never sees half a file.
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, path);
  return { path, hash: createHash('sha256').update(text).digest('hex') };
}

export async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(JSON.parse(await readFile(path, 'utf8')));
}
