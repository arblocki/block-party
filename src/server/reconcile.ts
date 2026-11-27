import { existsSync, readFileSync } from 'node:fs';
import { hostname as osHostname } from 'node:os';
import { join } from 'node:path';
import { readHookEvents } from '../core/agents/hook-events.js';
import { RunConfigSchema } from '../core/run/config.js';
import { reopenRestDecision, RESUME_OPTIONS } from '../core/run/rest-decision.js';
import { interruptedBody } from '../core/run/pipeline-helpers.js';
import type { RunRow, RunStore } from '../core/store/runs.js';
import type { AgentState, TerminalHost } from '../core/terminal/types.js';

export interface ReconcileOptions {
  runs: RunStore;
  /** Whether a local pid is alive (default: `process.kill(pid, 0)`). */
  isAlive?: (pid: number) => boolean;
  /** Looks for each pane-mode run's agent terminal (default: none, so no pane evidence). */
  terminal?: Pick<TerminalHost, 'list' | 'agentState'>;
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
 * Copies hook events the server has not seen from the run's `events.jsonl` into `run_events`
 * as `agent.hook` rows. The byte offset and the rows move together in one transaction, so
 * running this again (or after a crash) never repeats an event. Returns how many were copied.
 */
export function replayHookEvents(runs: RunStore, run: RunRow, now: () => Date): number {
  const file = join(run.runDir, 'events.jsonl');
  const from = runs.getHookOffset(run.id);
  const { events, nextOffset } = readHookEvents(file, from);
  if (nextOffset <= from) return 0;
  return runs.replayHookEvents(
    run.id,
    events.map((e) => ({
      ts: e.ts ?? now().toISOString(),
      type: 'agent.hook',
      payload: {
        event: e.hook_event_name,
        ...(e.session_id ? { session: e.session_id } : {}),
        ...(e.message ? { message: e.message } : {}),
        ...(e.reason ? { reason: e.reason } : {}),
        ...(e.notification_type ? { notification: e.notification_type } : {}),
        ...(e.agent_type ? { agentType: e.agent_type } : {}),
      },
    })),
    nextOffset,
  );
}

interface PaneEvidence {
  label: string;
  state: AgentState;
}

/** The run's agent pane, found by label through the terminal host; null when it is gone. */
async function probePane(
  terminal: ReconcileOptions['terminal'],
  run: RunRow,
): Promise<PaneEvidence | null> {
  if (!terminal || run.implementer?.mode !== 'pane') return null;
  try {
    const mine = (await terminal.list()).filter((p) => p.label.startsWith(`bp-${run.id}-`));
    const pane = mine.find((p) => p.label === run.implementer?.paneLabel) ?? mine[mine.length - 1];
    if (!pane) return null;
    let state: AgentState = 'unknown';
    try {
      state = await terminal.agentState(pane);
    } catch {
      // The pane exists; its state just could not be read.
    }
    return { label: pane.label, state };
  } catch {
    // No herdr server: no terminals are open.
    return null;
  }
}

/** What reconciliation found, in the words of the inbox item. */
function evidenceText(
  run: RunRow,
  hasReport: boolean,
  pane: PaneEvidence | null,
  probed: boolean,
): string {
  const parts = [`The agent ${hasReport ? 'had written' : 'had not yet written'} its report.`];
  if (probed && run.implementer?.mode === 'pane') {
    if (!pane) parts.push('Its terminal is no longer open.');
    else if (pane.state === 'working') {
      parts.push(
        'The agent is still running in its terminal; Resume will re-attach to it instead of starting a second one.',
      );
    } else {
      parts.push(
        'Its terminal is still open (the agent is not working); Resume will pick it up from there.',
      );
    }
  }
  return parts.join(' ');
}

/**
 * Checks every active run whose owner process on this host is gone against what is left of it
 * (its hook events file, its agent terminal, its report) and marks it `interrupted`, with an
 * event and an inbox item that say what was found. Runs owned by another host, or by a live
 * process, are left alone. Returns the ids of the runs it changed.
 */
export async function reconcileRuns(opts: ReconcileOptions): Promise<string[]> {
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
    try {
      replayHookEvents(runs, run, now);
    } catch {
      // Evidence only: a file that cannot be read does not stop the run being marked.
    }
    const pane = await probePane(opts.terminal, run);
    const hasReport = existsSync(join(run.runDir, 'report.json'));
    runs.updateRun(run.id, { stage: 'interrupted', stageNote: note });
    runs.closeOpenQuestions(run.id);
    runs.appendEvent({
      runId: run.id,
      ts: now().toISOString(),
      type: 'run.interrupted',
      payload: { stage: run.stage, note },
    });
    if (pane) {
      runs.appendEvent({
        runId: run.id,
        ts: now().toISOString(),
        type: 'reconcile.pane_alive',
        payload: { label: pane.label, state: pane.state },
      });
    }
    const attach = run.implementer?.mode === 'pane' ? sessionAttach(runs, run.id) : null;
    runs.openDecision({
      runId: run.id,
      kind: 'interrupted',
      title: 'Run interrupted',
      body: `${interruptedBody(run.stage, run.stageNote, note)} ${evidenceText(run, hasReport, pane, opts.terminal !== undefined)}`,
      attach,
      options: RESUME_OPTIONS,
    });
    changed.push(run.id);
  }
  return changed;
}

/** What `resumeOnRestart` needs from the run manager. */
export interface Resumer {
  resume(runId: string): 'started' | 'busy' | 'not_resumable';
}

/** Runs resumed automatically at startup, at most (until the run limit exists). */
export const DEFAULT_RESUME_LIMIT = 3;

/**
 * Resumes the runs reconciliation just interrupted whose own config asks for it
 * (`policy.resumeOnRestart`), at most `limit` of them. The rest stay interrupted with their
 * question. Returns the ids it resumed.
 */
export function resumeOnRestart(
  runs: RunStore,
  manager: Resumer,
  ids: string[],
  limit = DEFAULT_RESUME_LIMIT,
): string[] {
  const resumed: string[] = [];
  for (const id of ids) {
    if (resumed.length >= limit) break;
    const run = runs.getRun(id);
    if (!run) continue;
    let wanted = false;
    try {
      const raw: unknown = JSON.parse(
        readFileSync(join(run.runDir, 'inputs', 'config.json'), 'utf8'),
      );
      wanted = RunConfigSchema.parse(raw).policy.resumeOnRestart;
    } catch {
      // No readable config: the default (ask first) applies.
    }
    if (wanted && manager.resume(id) === 'started') resumed.push(id);
  }
  return resumed;
}

/**
 * A hard crash between answering a rest decision and leaving rest strands the run: the answer
 * is recorded, the run still rests, and nothing is open. Reopens the question for each such
 * run (a no-op when it is already open). A run whose owner process on this host is alive is
 * being carried out right now, so it is left alone. Returns the ids of the runs it reopened.
 */
export function reopenStrandedRests(
  runs: RunStore,
  opts: { isAlive?: (pid: number) => boolean; hostname?: string } = {},
): string[] {
  const isAlive = opts.isAlive ?? pidAlive;
  const host = opts.hostname ?? osHostname();
  const reopened: string[] = [];
  for (const run of runs.listRuns({ resting: true })) {
    if (run.ownerHost === host && run.ownerPid !== null && isAlive(run.ownerPid)) continue;
    const id = reopenRestDecision(
      runs,
      run.id,
      'the server stopped before carrying out your answer',
    );
    if (id !== null) reopened.push(run.id);
  }
  return reopened;
}
