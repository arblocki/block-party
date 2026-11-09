import { randomUUID as nodeRandomUUID } from 'node:crypto';
import { appendFile, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { scrubbedEnv } from '../process/env.js';
import { LlmError } from '../llm/types.js';
import { spawnCli, type SpawnFn } from '../llm/spawn-cli.js';
import { StreamParser, type ResultEvent, type StreamEvent } from './claude-stream.js';
import type {
  ImplementerAdapter,
  ImplementerSession,
  ImplementerStartInput,
  TurnOutcome,
} from './types.js';

export interface HeadlessEvent {
  type: string;
  data: Record<string, unknown>;
}

export interface HeadlessClaudeOptions {
  spawnFn?: SpawnFn;
  claudeBin?: string;
  randomUUID?: () => string;
  onEvent?: (event: HeadlessEvent) => void;
}

export { scrubbedEnv };

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Next unused `stream-<n>.jsonl` path in `<runDir>/agent/` (n starts at 1). */
async function nextStreamFile(runDir: string): Promise<string> {
  const dir = path.join(runDir, 'agent');
  await mkdir(dir, { recursive: true });
  let max = 0;
  for (const f of await readdir(dir)) {
    const m = /^stream-(\d+)\.jsonl$/.exec(f);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return path.join(dir, `stream-${max + 1}.jsonl`);
}

export function createHeadlessClaude(opts: HeadlessClaudeOptions = {}): ImplementerAdapter {
  const claudeBin = opts.claudeBin ?? 'claude';
  const uuid = opts.randomUUID ?? nodeRandomUUID;
  const emit = (type: string, data: Record<string, unknown>) => opts.onEvent?.({ type, data });
  /** Live processes by session id, for `stop`. */
  const live = new Map<string, AbortController>();
  const streamFiles = new Map<string, string>();

  function baseArgs(input: ImplementerStartInput): string[] {
    return [
      '-p',
      '--model',
      input.model,
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      input.permissionMode,
      '--settings',
      input.settingsPath,
      '--agents',
      input.agentsPath,
      '--add-dir',
      input.runDir,
      ...(input.allowedTools.length ? ['--allowedTools', ...input.allowedTools] : []),
      ...(input.disallowedTools.length ? ['--disallowedTools', ...input.disallowedTools] : []),
    ];
  }

  async function runTurn(
    sessionId: string,
    sessionFlag: string[],
    input: ImplementerStartInput,
    prompt: string,
    onStarted?: () => void,
  ): Promise<TurnOutcome> {
    const streamFile = await nextStreamFile(input.runDir);
    streamFiles.set(sessionId, streamFile);
    onStarted?.();
    const ctl = new AbortController();
    live.set(sessionId, ctl);
    const onOuterAbort = () => ctl.abort();
    if (input.signal?.aborted) ctl.abort();
    else input.signal?.addEventListener('abort', onOuterAbort, { once: true });

    const parser = new StreamParser();
    let result: ResultEvent | undefined;
    let writes: Promise<unknown> = Promise.resolve();
    let logError: unknown;
    const failLog = () =>
      new Error(`failed to write agent stream log ${streamFile}`, { cause: logError });
    const handle = (events: StreamEvent[]) => {
      for (const ev of events) {
        switch (ev.kind) {
          case 'init':
            emit('agent.init', {
              claudeCodeVersion: ev.event.claude_code_version,
              sessionId: ev.event.session_id,
              model: ev.event.model,
            });
            break;
          case 'assistant':
            for (const b of ev.event.message.content)
              if (b.type === 'tool_use') emit('agent.tool_use', { name: b.name });
            break;
          case 'permission_denied':
            emit('agent.permission_denied', {
              tool: ev.event.tool_name,
              message: ev.event.message,
            });
            break;
          case 'result':
            result = ev.event;
            emit('agent.result', {
              totalCostUsd: ev.event.total_cost_usd,
              numTurns: ev.event.num_turns,
              permissionDenials: ev.event.permission_denials.length,
              isError: ev.event.is_error,
            });
            break;
          default:
            break;
        }
      }
    };

    const args = [...baseArgs(input), ...sessionFlag, '--', prompt];
    let code: number | null;
    try {
      const res = await spawnCli({
        command: claudeBin,
        args,
        cwd: input.cwd,
        env: scrubbedEnv(),
        timeoutMs: input.timeoutMs,
        signal: ctl.signal,
        spawnFn: opts.spawnFn,
        onStdout: (chunk) => {
          writes = writes.then(async () => {
            if (logError) return;
            try {
              await appendFile(streamFile, chunk);
            } catch (e) {
              logError = e;
              ctl.abort();
            }
          });
          handle(parser.push(chunk));
        },
      });
      code = res.code;
    } catch (err) {
      await writes;
      if (logError) throw failLog();
      if (err instanceof LlmError) {
        if (err.kind === 'timeout') return { kind: 'timeout' };
        if (err.kind === 'aborted') return { kind: 'exited', reason: 'stopped' };
      }
      throw err;
    } finally {
      input.signal?.removeEventListener('abort', onOuterAbort);
      if (live.get(sessionId) === ctl) live.delete(sessionId);
    }
    handle(parser.flush());
    await writes;
    if (logError) throw failLog();

    if (!result) {
      return {
        kind: 'exited',
        reason: code === null ? 'interrupted' : `interrupted (exit code ${code})`,
      };
    }
    if (await exists(input.reportPath)) return { kind: 'report' };
    const denials = result.permission_denials;
    const parts = [`result ${result.subtype}${result.is_error ? ' (error)' : ''}`];
    if (denials.length)
      parts.push(`permission denials: ${denials.map((d) => d.tool_name).join(', ')}`);
    return { kind: 'no_report', detail: parts.join('; ') };
  }

  return {
    async start(input) {
      const sessionId = uuid();
      const session: ImplementerSession = { mode: 'headless', sessionId, cwd: input.cwd };
      const outcome = await runTurn(
        sessionId,
        ['--session-id', sessionId],
        input,
        input.prompt,
        () => input.onSession?.({ ...session }),
      );
      return { session, outcome };
    },
    send(session, input, message) {
      return runTurn(session.sessionId, ['--resume', session.sessionId], input, message);
    },
    async stop(session) {
      live.get(session.sessionId)?.abort();
    },
    describe(session) {
      const f = streamFiles.get(session.sessionId);
      return f ? `log: ${f}` : `claude --resume ${session.sessionId}`;
    },
  };
}
