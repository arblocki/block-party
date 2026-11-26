import { closeSync, constants, openSync, realpathSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, sep } from 'node:path';
import type { Readable } from 'node:stream';

export const MAX_HOOK_STDIN_BYTES = 1024 * 1024;

/** Reads the stream; returns null if it exceeds `cap` bytes. */
export async function readCapped(
  stream: Readable,
  cap: number = MAX_HOOK_STDIN_BYTES,
): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buf.length;
    if (size > cap) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Returns a refusal reason, or null when `eventsPath` may be written. */
export function checkEventsPath(eventsPath: string, root: string): string | null {
  if (!isAbsolute(eventsPath)) return 'events path must be absolute';
  if (basename(eventsPath) !== 'events.jsonl') return 'events path must end in /events.jsonl';
  try {
    const dir = realpathSync(dirname(eventsPath));
    const realRoot = realpathSync(root);
    if (!dir.startsWith(realRoot + sep)) return 'events path is outside the runs directory';
  } catch {
    return 'events directory does not exist';
  }
  return null;
}

/**
 * Appends one hook payload to the events file. Never throws: returns an error message
 * (for stderr) on refusal or failure, null on success.
 */
export function appendHookEvent(opts: {
  eventsPath: string;
  runsRoot: string;
  stdin: string | null;
  now?: () => Date;
}): string | null {
  const refusal = checkEventsPath(opts.eventsPath, opts.runsRoot);
  if (refusal) return `block-party hook: refusing: ${refusal}`;
  if (opts.stdin === null) return 'block-party hook: stdin exceeds 1 MiB; event dropped';
  let payload: unknown;
  try {
    payload = JSON.parse(opts.stdin);
  } catch {
    return 'block-party hook: stdin is not valid JSON; event dropped';
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return 'block-party hook: payload is not a JSON object; event dropped';
  }
  const ts = (opts.now?.() ?? new Date()).toISOString();
  try {
    // O_NOFOLLOW: refuse an events.jsonl that is itself a symlink (it could point outside).
    const fd = openSync(
      opts.eventsPath,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeSync(fd, JSON.stringify({ ts, payload }) + '\n');
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    return `block-party hook: append failed: ${(err as Error).message}`;
  }
  return null;
}
