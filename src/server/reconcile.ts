import { hostname as osHostname } from 'node:os';
import { interruptedBody } from '../core/run/pipeline-helpers.js';
import type { RunStore } from '../core/store/runs.js';

export interface ReconcileOptions {
  runs: RunStore;
  /** Whether a local pid is alive (default: `process.kill(pid, 0)`). */
  isAlive?: (pid: number) => boolean;
  hostname?: string;
  now?: () => Date;
}

/** `process.kill(pid, 0)` probes without signalling; only ESRCH means the process is gone. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** The attach command the run's last `implementer.session` event recorded, if any. */
function sessionAttach(runs: RunStore, runId: string): string | null {
  let attach: string | null = null;
  for (const e of runs.listEvents(runId)) {
    if (e.type !== 'implementer.session') continue;
    const a = (e.payload as { attach?: unknown } | null)?.attach;
    if (typeof a === 'string') attach = a;
  }
  return attach;
}

/**
 * Marks active runs whose owner process on this host is gone as `interrupted`, with an event
 * and an inbox item. Runs owned by another host, or by a live process, are left alone.
 * Returns the ids of the runs it changed.
 */
export function reconcileRuns(opts: ReconcileOptions): string[] {
  const { runs } = opts;
  const isAlive = opts.isAlive ?? pidAlive;
  const host = opts.hostname ?? osHostname();
  const now = opts.now ?? (() => new Date());
  const changed: string[] = [];
  for (const run of runs.listRuns({ active: true })) {
    if (run.ownerHost !== host || run.ownerPid === null) continue;
    if (isAlive(run.ownerPid)) continue;
    const note = `owner process ${run.ownerPid} is gone`;
    // Re-read: the owner may have finished the run since the list was taken.
    const current = runs.getRun(run.id);
    if (!current || current.stage !== run.stage) continue;
    runs.updateRun(run.id, { stage: 'interrupted', stageNote: note });
    runs.closeOpenQuestions(run.id);
    runs.appendEvent({
      runId: run.id,
      ts: now().toISOString(),
      type: 'run.interrupted',
      payload: { stage: run.stage, note },
    });
    const attach = run.implementer?.mode === 'pane' ? sessionAttach(runs, run.id) : null;
    runs.openDecision({
      runId: run.id,
      kind: 'interrupted',
      title: 'Run interrupted',
      body: interruptedBody(run.stage, run.stageNote, note),
      attach,
    });
    changed.push(run.id);
  }
  return changed;
}
