import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface RunLogOptions {
  now?: () => Date;
  echo?: (line: string) => void;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export class RunLog {
  readonly path: string;
  private readonly now: () => Date;
  private readonly echo?: (line: string) => void;

  constructor(
    readonly runDir: string,
    opts: RunLogOptions = {},
  ) {
    this.path = join(runDir, 'run-events.jsonl');
    this.now = opts.now ?? (() => new Date());
    this.echo = opts.echo;
  }

  /** Appends one event; returns its `ts`. */
  log(type: string, data?: Record<string, unknown>): string {
    const at = this.now();
    const ts = at.toISOString();
    mkdirSync(this.runDir, { recursive: true });
    appendFileSync(this.path, JSON.stringify({ ts, type, data }) + '\n');
    if (this.echo) {
      const time = `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
      this.echo(`[${time}] ${type}${summarize(data)}`);
    }
    return ts;
  }
}

function summarize(data?: Record<string, unknown>): string {
  if (!data) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (k === 'durationMs' && typeof v === 'number') parts.push(`(${(v / 1000).toFixed(1)}s)`);
    else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
      parts.push(String(v));
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}
