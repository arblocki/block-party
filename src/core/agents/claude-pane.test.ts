import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HerdrError } from '../terminal/herdr-client.js';
import type { AgentState, PaneRef, TerminalHost } from '../terminal/types.js';
import { createPaneClaude } from './claude-pane.js';
import { HookWatcher } from './hook-events.js';
import type { ImplementerStartInput } from './types.js';

const timing = {
  settleMs: 30,
  pollMs: 10,
  loopMs: 10,
  trustMaxMs: 300,
  idlePollMs: 10,
  idleMaxMs: 200,
  confirmMs: 100,
  stopWaitMs: 150,
};

class FakeHost implements TerminalHost {
  opens: { label: string; cwd: string; argv: string[]; env?: Record<string, string> }[] = [];
  texts: string[] = [];
  keys: string[][] = [];
  closed: string[] = [];
  paneText = '';
  state: AgentState = 'idle';
  stateQueue: AgentState[] = [];
  aliveLabels = new Set<string>();
  onOpen?: (label: string) => void;
  onText?: (text: string) => void;
  async open(o: { label: string; cwd: string; argv: string[]; env?: Record<string, string> }) {
    this.opens.push(o);
    this.aliveLabels.add(o.label);
    this.onOpen?.(o.label);
    return { session: 's', label: o.label, cwd: o.cwd };
  }
  async sendText(_p: PaneRef, text: string) {
    this.texts.push(text);
    this.onText?.(text);
  }
  async sendKeys(_p: PaneRef, keys: string[]) {
    this.keys.push(keys);
  }
  async read() {
    return this.paneText;
  }
  async agentState(): Promise<AgentState> {
    return this.stateQueue.shift() ?? this.state;
  }
  async isAlive(p: PaneRef) {
    return this.aliveLabels.has(p.label);
  }
  async close(p: PaneRef) {
    if (!this.aliveLabels.delete(p.label)) throw new HerdrError('pane_not_found', 'gone');
    this.closed.push(p.label);
  }
  attachCommand(p: PaneRef) {
    return `herdr attach ${p.label}`;
  }
  async list() {
    return [];
  }
}

let dir: string;
let root: string;
let input: ImplementerStartInput;
let host: FakeHost;
const SID = 'sess-1';

function emitEvent(name: string, extra: Record<string, unknown> = {}) {
  appendFileSync(
    input.eventsPath,
    JSON.stringify({ ts: 'x', payload: { hook_event_name: name, session_id: SID, ...extra } }) +
      '\n',
  );
}

function adapter() {
  return createPaneClaude({
    host,
    claudeBin: 'claude',
    randomUUID: () => SID,
    timing,
    watcherFactory: (p, off) => new HookWatcher(p, { startOffset: off, intervalMs: 10 }),
  });
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bp-pane-')));
  root = path.join(dir, 'home');
  process.env.BLOCK_PARTY_HOME = root;
  const cwd = path.join(root, 'worktrees', 'o__r', 'r1');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(path.join(dir, 'run'), { recursive: true });
  input = {
    runId: 'r1',
    cwd,
    runDir: path.join(dir, 'run'),
    prompt: 'do it',
    model: 'haiku',
    agentsPath: '/a.json',
    settingsPath: '/s.json',
    eventsPath: path.join(dir, 'run', 'events.jsonl'),
    reportPath: path.join(dir, 'run', 'report.json'),
    permissionMode: 'acceptEdits',
    allowedTools: ['Read', 'Edit'],
    disallowedTools: ['WebFetch'],
    timeoutMs: 5000,
  };
  host = new FakeHost();
});
afterEach(() => {
  delete process.env.BLOCK_PARTY_HOME;
});

describe('createPaneClaude', () => {
  it('opens a pane with the expected argv and a scrubbed env, returns report', async () => {
    process.env.GITHUB_TOKEN = 'secret';
    host.onOpen = () => {
      emitEvent('SessionStart');
      writeFileSync(input.reportPath, '{}');
      emitEvent('Stop', { background_tasks: [] });
    };
    try {
      const { session, outcome } = await adapter().start(input);
      expect(outcome).toEqual({ kind: 'report' });
      expect(session).toMatchObject({ mode: 'pane', sessionId: SID, paneLabel: 'bp-r1-impl' });
      const open = host.opens[0]!;
      expect(open.label).toBe('bp-r1-impl');
      expect(open.argv).toEqual([
        'claude',
        '--session-id',
        SID,
        '--model',
        'haiku',
        '--permission-mode',
        'acceptEdits',
        '--settings',
        '/s.json',
        '--agents',
        '/a.json',
        '--allowedTools',
        'Read',
        'Edit',
        '--disallowedTools',
        'WebFetch',
        '--',
        'do it',
      ]);
      expect(open.env).toBeDefined();
      expect(open.env!.GITHUB_TOKEN).toBeUndefined();
    } finally {
      delete process.env.GITHUB_TOKEN;
    }
  });

  it('passes agents as inline JSON when the file is readable', async () => {
    const agents = path.join(dir, 'agents.json');
    writeFileSync(agents, '{"helper":{}}\n');
    input.agentsPath = agents;
    host.onOpen = () => {
      emitEvent('SessionStart');
      writeFileSync(input.reportPath, '{}');
      emitEvent('Stop', { background_tasks: [] });
    };
    await adapter().start(input);
    const argv = host.opens[0]!.argv;
    expect(argv[argv.indexOf('--agents') + 1]).toBe('{"helper":{}}');
  });

  it('accepts the trust dialog inside the worktrees root', async () => {
    host.paneText = 'Do you trust this folder?\nYes, I trust this folder';
    host.sendKeys = async (_p, keys) => {
      host.keys.push(keys);
      emitEvent('SessionStart');
      writeFileSync(input.reportPath, '{}');
      emitEvent('Stop', { background_tasks: [] });
    };
    const { outcome } = await adapter().start(input);
    expect(host.keys).toEqual([['Down', 'Enter']]);
    expect(outcome.kind).toBe('report');
  });

  it('refuses the trust dialog outside the worktrees root', async () => {
    input.cwd = dir;
    host.paneText = 'Do you trust this folder?';
    const { outcome } = await adapter().start(input);
    expect(outcome).toEqual({ kind: 'permission', message: 'folder trust dialog' });
    expect(host.keys).toEqual([]);
  });

  async function started() {
    host.onOpen = () => {
      emitEvent('SessionStart');
      writeFileSync(input.reportPath, '{}');
      emitEvent('Stop', { background_tasks: [] });
    };
    const a = adapter();
    const { session } = await a.start(input);
    host.onOpen = undefined;
    host.opens.length = 0;
    return { a, session };
  }

  it('send waits for idle, retries once when UserPromptSubmit is missing', async () => {
    const { a, session } = await started();
    host.stateQueue = ['working', 'working', 'idle'];
    let n = 0;
    host.onText = () => {
      if (++n === 2) {
        emitEvent('UserPromptSubmit');
        emitEvent('Stop', { background_tasks: [] });
      }
    };
    const outcome = await a.send(session, input, 'see msg.md');
    expect(host.texts).toEqual(['see msg.md', 'see msg.md']);
    expect(outcome.kind).toBe('report');
    expect(host.stateQueue).toEqual([]);
  });

  it('send returns timeout when never idle, and no_report when never submitted', async () => {
    const { a, session } = await started();
    host.state = 'working';
    expect(await a.send(session, input, 'x')).toEqual({ kind: 'timeout' });
    expect(host.texts).toEqual([]);
    host.state = 'idle';
    const o = await a.send(session, input, 'x');
    expect(o.kind).toBe('no_report');
    expect(host.texts).toHaveLength(2);
  });

  it('rejects over-long messages', async () => {
    const { a, session } = await started();
    await expect(a.send(session, input, 'x'.repeat(2001))).rejects.toThrow(/too long/);
  });

  it('send after pane death resumes in a new pane', async () => {
    const { a, session } = await started();
    host.aliveLabels.clear();
    host.onOpen = () => {
      emitEvent('SessionStart', { source: 'resume' });
      emitEvent('Stop', { background_tasks: [] });
    };
    const outcome = await a.send(session, input, 'next');
    expect(outcome.kind).toBe('report');
    expect(host.opens[0]!.label).toBe('bp-r1-impl-r2');
    expect(host.opens[0]!.argv.slice(0, 3)).toEqual(['claude', '--resume', SID]);
    expect(host.opens[0]!.argv.slice(-2)).toEqual(['--', 'next']);
    expect(session.paneLabel).toBe('bp-r1-impl-r2');
    expect(host.texts).toEqual([]);
    host.aliveLabels.clear();
    await a.send(session, input, 'again');
    expect(host.opens[1]!.label).toBe('bp-r1-impl-r3');
  });

  it('stop graceful: /exit then SessionEnd, saves final pane text', async () => {
    const { a, session } = await started();
    host.paneText = 'final text';
    host.onText = (t) => {
      if (t === '/exit') {
        emitEvent('SessionEnd', { reason: 'prompt_input_exit' });
        host.aliveLabels.clear();
      }
    };
    await a.stop(session);
    expect(host.texts).toEqual(['/exit']);
    expect(host.closed).toEqual([]);
    expect(readFileSync(path.join(input.runDir, 'agent', 'pane-final.txt'), 'utf8')).toBe(
      'final text',
    );
  });

  it('stop closes the pane on graceful timeout and when forced', async () => {
    let { a, session } = await started();
    await a.stop(session);
    expect(host.texts).toEqual(['/exit']);
    expect(host.closed).toEqual(['bp-r1-impl']);

    host.texts = [];
    host.closed = [];
    ({ a, session } = await started());
    await a.stop(session, { force: true });
    expect(host.texts).toEqual([]);
    expect(host.closed).toEqual(['bp-r1-impl']);
  });

  it('describe includes attach command and label', async () => {
    const { a, session } = await started();
    expect(a.describe(session)).toBe('herdr attach bp-r1-impl (workspace bp-r1-impl)');
  });
});
