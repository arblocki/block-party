import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSpawn, type FakeProc } from '../llm/fake-spawn.testutil.js';
import { createHeadlessClaude, type HeadlessEvent } from './claude-headless.js';
import type { ImplementerStartInput } from './types.js';

const line = (o: unknown) => JSON.stringify(o) + '\n';
const init = line({
  type: 'system',
  subtype: 'init',
  session_id: 's',
  cwd: '/w',
  model: 'm',
  permissionMode: 'acceptEdits',
  tools: [],
  claude_code_version: '2.1.319',
});
const result = (denials: unknown[] = []) =>
  line({
    type: 'result',
    subtype: 'success',
    session_id: 's',
    is_error: false,
    num_turns: 3,
    duration_ms: 1,
    duration_api_ms: 1,
    total_cost_usd: 0.12,
    usage: {},
    permission_denials: denials,
  });

let dir: string;
let input: ImplementerStartInput;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'bp-headless-'));
  input = {
    runId: 'r1',
    cwd: '/work',
    runDir: dir,
    prompt: 'do it',
    model: 'sonnet',
    agentsPath: '/a.json',
    settingsPath: '/s.json',
    eventsPath: '/e.jsonl',
    reportPath: path.join(dir, 'report.json'),
    permissionMode: 'acceptEdits',
    allowedTools: ['Read', 'Bash(git status:*)'],
    disallowedTools: ['Bash(git push:*)'],
    timeoutMs: 5000,
  };
});
afterEach(() => vi.unstubAllEnvs());

const make = (proc: FakeProc | ((n: number) => FakeProc), events?: HeadlessEvent[]) => {
  let n = 0;
  const f = fakeSpawn(() => (typeof proc === 'function' ? proc(++n) : proc));
  const adapter = createHeadlessClaude({
    spawnFn: f.spawnFn,
    randomUUID: () => 'uuid-1',
    onEvent: events ? (e) => events.push(e) : undefined,
  });
  return { adapter, ...f };
};

describe('createHeadlessClaude', () => {
  it('calls onSession once the process is launched, before the outcome', async () => {
    const order: string[] = [];
    const { adapter, calls } = make({ stdout: init + result() });
    const { outcome } = await adapter.start({
      ...input,
      onSession: (s) => order.push(`session:${s.sessionId}:${calls.length}`),
    });
    order.push(`outcome:${outcome.kind}`);
    expect(order[0]).toMatch(/^session:uuid-1:/);
    expect(order[1]).toMatch(/^outcome:/);
  });

  it('builds argv with prompt after -- and scrubs the env', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'x');
    vi.stubEnv('GH_TOKEN', 'x');
    vi.stubEnv('BLOCK_PARTY_TOKEN', 'x');
    vi.stubEnv('KEEP_ME', 'y');
    vi.stubEnv('GH_ENTERPRISE_TOKEN', 'x');
    vi.stubEnv('OPENROUTER_API_KEY', 'x');
    vi.stubEnv('BLOCK_PARTY_HOME', '/data');
    const { adapter, calls } = make({ stdout: init + result() });
    const { session } = await adapter.start(input);
    expect(session).toEqual({ mode: 'headless', sessionId: 'uuid-1', cwd: '/work' });
    const c = calls[0]!;
    expect(c.command).toBe('claude');
    expect(c.cwd).toBe('/work');
    expect(c.stdin).toBe('');
    expect(c.args).toEqual([
      '-p',
      '--model',
      'sonnet',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
      '--settings',
      '/s.json',
      '--agents',
      '/a.json',
      '--add-dir',
      dir,
      '--allowedTools',
      'Read',
      'Bash(git status:*)',
      '--disallowedTools',
      'Bash(git push:*)',
      '--session-id',
      'uuid-1',
      '--',
      'do it',
    ]);
    expect(c.env?.GITHUB_TOKEN).toBeUndefined();
    expect(c.env?.GH_TOKEN).toBeUndefined();
    expect(c.env?.BLOCK_PARTY_TOKEN).toBeUndefined();
    expect(c.env?.GH_ENTERPRISE_TOKEN).toBeUndefined();
    expect(c.env?.OPENROUTER_API_KEY).toBeUndefined();
    expect(c.env?.BLOCK_PARTY_HOME).toBe('/data');
    expect(c.env?.KEEP_ME).toBe('y');
  });

  it('send resumes with flags repeated and a new stream file', async () => {
    const { adapter, calls } = make({ stdout: init + result() });
    const { session } = await adapter.start(input);
    await adapter.send(session, input, 'fix it');
    const a = calls[1]!.args;
    expect(a.slice(0, 12)).toEqual(calls[0]!.args.slice(0, 12));
    expect(a.slice(-4)).toEqual(['--resume', 'uuid-1', '--', 'fix it']);
    expect(a).not.toContain('--session-id');
    const s1 = await readFile(path.join(dir, 'agent', 'stream-1.jsonl'), 'utf8');
    const s2 = await readFile(path.join(dir, 'agent', 'stream-2.jsonl'), 'utf8');
    expect(s1).toBe(init + result());
    expect(s2).toBe(s1);
    expect(adapter.describe(session)).toContain('stream-2.jsonl');
  });

  it('returns report when result and report.json exist', async () => {
    const events: HeadlessEvent[] = [];
    const { adapter } = make(
      {
        stdout: init + result(),
        onRun: () => writeFile(input.reportPath, '{}'),
      },
      events,
    );
    const { outcome } = await adapter.start(input);
    expect(outcome).toEqual({ kind: 'report' });
    expect(events.map((e) => e.type)).toEqual(['agent.init', 'agent.result']);
    expect(events[0]!.data.claudeCodeVersion).toBe('2.1.319');
    expect(events[1]!.data).toMatchObject({ totalCostUsd: 0.12, numTurns: 3, isError: false });
  });

  it('returns no_report with denial detail', async () => {
    const events: HeadlessEvent[] = [];
    const { adapter } = make(
      {
        stdout: init + result([{ tool_name: 'Bash', tool_use_id: 't', tool_input: {} }]),
      },
      events,
    );
    const { outcome } = await adapter.start(input);
    expect(outcome.kind).toBe('no_report');
    expect(outcome.kind === 'no_report' && outcome.detail).toContain('Bash');
    expect(events.find((e) => e.type === 'agent.result')!.data.permissionDenials).toBe(1);
  });

  it('returns exited when the process ends without a result', async () => {
    const { adapter } = make({ stdout: init, code: 1 });
    const { outcome } = await adapter.start(input);
    expect(outcome.kind).toBe('exited');
  });

  it('maps a spawn timeout to timeout', async () => {
    const { adapter } = make({ hang: true });
    const { outcome } = await adapter.start({ ...input, timeoutMs: 20 });
    expect(outcome).toEqual({ kind: 'timeout' });
  });

  it('stop aborts the live process and reports exited/stopped', async () => {
    const { adapter, killed } = make({ hang: true });
    const p = adapter.start(input);
    await new Promise((r) => setTimeout(r, 20));
    await adapter.stop({ mode: 'headless', sessionId: 'uuid-1', cwd: '/work' });
    const { outcome } = await p;
    expect(outcome).toEqual({ kind: 'exited', reason: 'stopped' });
    expect(killed).toContain('SIGTERM');
  });
});
