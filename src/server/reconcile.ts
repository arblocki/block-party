import { readFileSync, statSync } from 'node:fs';
import { hostname as osHostname } from 'node:os';
import { join } from 'node:path';
import { isFinalStop, readHookEvents } from '../core/agents/hook-events.js';
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
 * Reads the hook events past the run's offset (the live watcher advances it as it consumes
 * lines, so this is only what happened while block-party was down) and records what they mean,
 * never the raw lines: `reconcile.agent_stopped` when the agent finished a turn or ended its
 * session, `agent.permission_wait` for a permission prompt (as the live path records it), and
 * one `reconcile.activity { toolCalls }` counting tool calls. The offset moves with the rows
 * in one transaction, so running this again never repeats an event. Returns how many events
 * it recorded.
 */
export function replayHookEvents(runs: RunStore, run: RunRow, now: () => Date): number {
  const file = join(run.runDir, 'events.jsonl');
  const from = runs.getHookOffset(run.id);
  const { events, nextOffset } = readHookEvents(file, from);
  if (nextOffset <= from) return 0;
  const at = (e: { ts?: string }) => e.ts ?? now().toISOString();
  const derived: { ts: string; type: string; payload?: unknown }[] = [];
  let toolCalls = 0;
  let stopped: { ts: string; event: string } | undefined;
  for (const e of events) {
    if (e.hook_event_name === 'PostToolUse') toolCalls += 1;
    else if (isFinalStop(e) || e.hook_event_name === 'SessionEnd') {
      stopped = { ts: at(e), event: e.hook_event_name };
    } else if (
      e.hook_event_name === 'Notification' &&
      e.notification_type === 'permission_prompt'
    ) {
      derived.push({
        ts: at(e),
        type: 'agent.permission_wait',
        payload: { message: e.message ?? 'permission prompt' },
      });
    }
  }
  if (toolCalls > 0) {
    derived.push({ ts: now().toISOString(), type: 'reconcile.activity', payload: { toolCalls } });
  }
  if (stopped) {
    derived.push({
      ts: stopped.ts,
      type: 'reconcile.agent_stopped',
      payload: { event: stopped.event },
    });
  }
  return runs.replayHookEvents(run.id, derived, nextOffset);
}

interface PaneEvidence {
  label: string;
  state: AgentState;
  /** Whose terminal it is: the planner's while the run was planning, else the implementer's. */
  agent: 'planner' | 'implementer';
}

/** The run's agent pane, found by label through the terminal host; null when it is gone. */
async function probePane(
  terminal: ReconcileOptions['terminal'],
  run: RunRow,
): Promise<PaneEvidence | null> {
  const planning = run.stage === 'planning';
  if (!terminal || (!planning && run.implementer?.mode !== 'pane')) return null;
  try {
    const mine = (await terminal.list()).filter((p) =>
      p.label.startsWith(`bp-${run.id}-${planning ? 'plan' : 'impl'}`),
    );
    const pane = mine.find((p) => p.label === run.implementer?.paneLabel) ?? mine[mine.length - 1];
    if (!pane) return null;
    let state: AgentState = 'unknown';
    try {
      state = await terminal.agentState(pane);
    } catch {
      // The pane exists; its state just could not be read.
    }
    return { label: pane.label, state, agent: planning ? 'planner' : 'implementer' };
  } catch {
    // No herdr server: no terminals are open.
    return null;
  }
}

/** Whether `report.json` was written during the current turn (null: no turn to compare with). */
function reportEvidence(runs: RunStore, run: RunRow): 'this_turn' | 'older' | 'none' | 'exists' {
  let mtime: number;
  try {
    mtime = statSync(join(run.runDir, 'report.json')).mtimeMs;
  } catch {
    return 'none';
  }
  try {
    const open = runs.listStages(run.id).filter((s) => s.state === 'running');
    const turn = open.at(-1);
    if (!turn) return 'exists';
    return mtime >= Date.parse(turn.startedAt) ? 'this_turn' : 'older';
  } catch {
    return 'exists';
  }
}

/** What reconciliation found, in the words of the inbox item. */
function evidenceText(
  report: ReturnType<typeof reportEvidence>,
  pane: PaneEvidence | null,
  probed: boolean,
  paneRun: boolean,
): string {
  const parts = [
    {
      this_turn: 'The agent had written its report for this step.',
      older: 'The report file is from an earlier step; none was written for this one yet.',
      none: 'No report file exists yet.',
      exists: 'A report file exists.',
    }[report],
  ];
  if (pane) {
    const who = pane.agent === 'planner' ? 'planner' : 'implementer';
    parts.push(
      pane.state === 'working'
        ? `The ${who} is still running in its terminal; Resume will re-attach to it instead of starting a second one.`
        : `The ${who}'s terminal is still open (it is not working); Resume will pick it up from there.`,
    );
  } else if (probed && paneRun) {
    parts.push('Its terminal is no longer open.');
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
    // A queued start that was taken from the queue but never created its run files is not
    // interrupted (there is nothing to resume): it goes back to its place in the queue.
    if (run.stage === 'setup' && runs.requeueStart(run.id)) continue;
    try {
      replayHookEvents(runs, run, now);
    } catch {
      // Evidence only: a file that cannot be read does not stop the run being marked.
    }
    const pane = await probePane(opts.terminal, run);
    const report = reportEvidence(runs, run);
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
        payload: { label: pane.label, state: pane.state, agent: pane.agent },
      });
    }
    const attach = run.implementer?.mode === 'pane' ? sessionAttach(runs, run.id) : null;
    runs.openDecision({
      runId: run.id,
      kind: 'interrupted',
      title: 'Run interrupted',
      body: `${interruptedBody(run.stage, run.stageNote, note)} ${evidenceText(report, pane, opts.terminal !== undefined, run.implementer?.mode === 'pane')}`,
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
  /** The run limits: at most `maxRuns` runs are resumed at startup. */
  limits?: { maxRuns: number };
}

/** Runs resumed automatically at startup when the manager gives no limits. */
export const DEFAULT_RESUME_LIMIT = 3;

/**
 * Resumes the runs reconciliation just interrupted whose own config asks for it
 * (`policy.resumeOnRestart`), at most `limit` of them (default: the manager's `maxRuns`). The
 * rest stay interrupted with their question. Returns the ids it resumed.
 */
export function resumeOnRestart(
  runs: RunStore,
  manager: Resumer,
  ids: string[],
  limit: number = manager.limits?.maxRuns ?? DEFAULT_RESUME_LIMIT,
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
