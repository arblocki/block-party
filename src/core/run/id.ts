import { randomBytes } from 'node:crypto';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** `r<yyyyMMdd>-<6 lowercase hex>`, date in UTC. */
export function newRunId(
  now: Date = new Date(),
  rand: (size: number) => Buffer = randomBytes,
): string {
  const date = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  return `r${date}-${rand(3).toString('hex')}`;
}

export function slugify(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || 'run';
}

export function branchName(title: string, runId: string): string {
  return `bp/${slugify(title)}-${runId.slice(-6)}`;
}
