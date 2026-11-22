import type { CheckResult } from '../checks/run.js';
import { tailLog } from '../checks/run.js';
import type { PriorFinding } from '../reviewer/prompt.js';
import type { Finding } from '../reviewer/findings.js';
import type { ResolutionKind, ReviewRoundInput } from './publish.js';

export class InterruptedError extends Error {
  constructor() {
    super('interrupted');
    this.name = 'InterruptedError';
  }
}

/**
 * Abort reason meaning "the process driving this run is stopping", not "the user cancelled":
 * a run aborted with it ends `interrupted` instead of `cancelled`.
 */
export class ShutdownError extends Error {
  constructor(message = 'server stopped') {
    super(message);
    this.name = 'ShutdownError';
  }
}

/** Whether `signal` was aborted because its owner is shutting down. */
export function isShutdown(signal?: AbortSignal): boolean {
  return signal?.aborted === true && signal.reason instanceof ShutdownError;
}

/** Body of the `interrupted` inbox item: where the run was and why it stopped. */
export function interruptedBody(stage: string, stageNote: string | null, why: string): string {
  return `The run stopped while ${stage}${stageNote ? ` (${stageNote})` : ''}: ${why}.`;
}

/** Rejects with InterruptedError when `signal` aborts first; the work itself is not cancelled. */
export function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(new InterruptedError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new InterruptedError());
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e as Error);
      },
    );
  });
}

export function failedChecks(results: CheckResult[]): CheckResult[] {
  return results.filter((r) => r.exitCode !== 0 || r.timedOut);
}

/** Markdown for the implementer: failed check names, commands and the last 80 log lines. */
export function renderCheckFailures(results: CheckResult[], headSha: string): string {
  const out = [`# Local CI failed on ${headSha.slice(0, 7)}`, ''];
  for (const r of failedChecks(results)) {
    const how = r.timedOut ? 'timed out' : `exit ${r.exitCode ?? 'signal'}`;
    out.push(`## ${r.name} (${how})`, '', `Command: \`${r.command}\``, '');
    out.push('Last 80 log lines:', '', '```', tailLog(r.logPath, 80), '```', '');
  }
  return out.join('\n');
}

export function locationText(f: Finding): string {
  if (!f.location) return 'n/a';
  const { path, startLine, endLine } = f.location;
  return `${path}:${startLine}-${endLine}`;
}

/** Every finding of earlier rounds with its recorded resolution (`open` when unrecorded). */
export function priorFindings(rounds: ReviewRoundInput[]): PriorFinding[] {
  return rounds.flatMap((r) =>
    r.findings.map((f) => {
      const res = r.resolutions[f.id];
      return {
        id: f.id,
        severity: f.severity,
        title: f.title,
        location: locationText(f),
        resolution: (res?.resolution ?? 'open') as ResolutionKind,
        note: res?.note || '(no note)',
      };
    }),
  );
}
