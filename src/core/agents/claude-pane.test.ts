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
import { ShutdownError } from '../run/pipeline-helpers.js';
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
  private check(p: PaneRef) {
    if (p.session !== 's') throw new HerdrError('wrong_session', `session ${p.session}`);
  }
  async open(o: { label: string; cwd: string; argv: string[]; env?: Record<string, string> }) {
    this.opens.push(o);
    this.aliveLabels.add(o.label);
    this.onOpen?.(o.label);
    return { session: 's', label: o.label, cwd: o.cwd };
  }
  async sendText(p: PaneRef, text: string) {
    this.check(p);
    this.texts.push(text);
    this.onText?.(text);
  }
  async sendKeys(p: PaneRef, keys: string[]) {
    this.check(p);
    this.keys.push(keys);
  }
  async read() {
    return this.paneText;
  }
  async agentState(): Promise<AgentState> {
    return this.stateQueue.shift() ?? this.state;
  }
  async isAlive(p: PaneRef) {
    await this.aliveGate;
    this.check(p);
    return this.aliveLabels.has(p.label);
  }
  async close(p: PaneRef) {
    this.check(p);
    if (!this.aliveLabels.delete(p.label)) throw new HerdrError('pane_not_found', 'gone');
    this.closed.push(p.label);
  }
  attachCommand(p: PaneRef) {
    return `herdr attach ${p.label}`;
  }
  listGate?: Promise<void>;
  aliveGate?: Promise<void>;
  async list(): Promise<PaneRef[]> {
    await this.listGate;
    return [...this.aliveLabels].map((label) => ({ session: 's', label, cwd: this.cwd }));
  }
  cwd = '';
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

function adapter(t: typeof timing & { dialogRetryMs?: number } = timing) {
  return createPaneClaude({
    host,
    claudeBin: 'claude',
    randomUUID: () => SID,
    timing: t,
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
  host.cwd = cwd;
});
afterEach(() => {
  delete process.env.BLOCK_PARTY_HOME;
});

describe('createPaneClaude', () => {
  it('keeps waiting through a permission prompt until the turn ends', async () => {
    host.onOpen = () => {
      emitEvent('SessionStart');
      emitEvent('Notification', { notification_type: 'permission_prompt', message: 'approve?' });
      host.state = 'blocked';
      setTimeout(() => {
        host.state = 'working';
        writeFileSync(input.reportPath, '{}');
        emitEvent('Stop', { background_tasks: [] });
        host.state = 'idle';
      }, 150);
    };
    const prompts: string[] = [];
    const { outcome } = await adapter().start({
      ...input,
      onPermission: (m) => prompts.push(m),
    });
    expect(prompts).toEqual(['approve?']);
    expect(outcome).toEqual({ kind: 'report' });
  });

  it('ends as timeout when the permission prompt is never answered', async () => {
    host.onOpen = () => {
      emitEvent('SessionStart');
      emitEvent('Notification', { notification_type: 'permission_prompt', message: 'approve?' });
      host.state = 'blocked';
    };
    const { outcome } = await adapter().start({ ...input, timeoutMs: 200 });
    expect(outcome).toEqual({ kind: 'timeout' });
  });

  it('calls onSession right after the pane opens, before the turn ends', async () => {
    const order: string[] = [];
    host.onOpen = () => {
      emitEvent('SessionStart');
      writeFileSync(input.reportPath, '{}');
      emitEvent('Stop', { background_tasks: [] });
    };
    const a = adapter();
    const { outcome } = await a.start({
      ...input,
      onSession: (s) => {
        order.push(`session:${s.paneLabel}:${a.describe(s) ? 'desc' : ''}`);
      },
    });
    order.push(`outcome:${outcome.kind}`);
    expect(order).toEqual(['session:bp-r1-impl:desc', 'outcome:report']);
  });

  it('opens a pane with the expected argv and a scrubbed env, returns report', async () => {
    process.env.GITHUB_TOKEN = 'secret';
    process.env.OPENROUTER_API_KEY = 'secret';
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
        '--add-dir',
        input.runDir,
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
      expect(open.env!.OPENROUTER_API_KEY).toBeUndefined();
    } finally {
      delete process.env.GITHUB_TOKEN;
      delete process.env.OPENROUTER_API_KEY;
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

  it('accepts the add-directory dialog for the run directory', async () => {
    // Claude Code ≥ 2.1.328 asks about each --add-dir; long paths wrap in the pane.
    const wrapped = input.runDir.replace(/\/([^/]*)$/, '/\n $1');
    // Layout as captured from a real pane: blank lines around the path.
    host.paneText =
      ` Adding a new directory:\n\n ${wrapped}\n\n` +
      " This session hasn't worked here before. Is this a directory you created or one you trust?\n\n" +
      ' Security guide\n\n ❯ No, exit\n   Yes, add it\n\n Enter to confirm · Esc to cancel';
    host.sendKeys = async (_p, keys) => {
      host.keys.push(keys);
      host.paneText = '';
      emitEvent('SessionStart');
      writeFileSync(input.reportPath, '{}');
      emitEvent('Stop', { background_tasks: [] });
    };
    const { outcome } = await adapter().start(input);
    expect(host.keys).toEqual([['Down', 'Enter']]);
    expect(outcome.kind).toBe('report');
  });

  it('answers the folder trust dialog and then the add-directory dialog', async () => {
    host.paneText = 'Do you trust this folder?\nYes, I trust this folder';
    host.sendKeys = async (_p, keys) => {
      host.keys.push(keys);
      if (host.keys.length === 1) {
        host.paneText = `Adding a new directory:\n ${input.runDir}\n ❯ No, exit\n   Yes, add it`;
        return;
      }
      host.paneText = '';
      emitEvent('SessionStart');
      writeFileSync(input.reportPath, '{}');
      emitEvent('Stop', { background_tasks: [] });
    };
    const { outcome } = await adapter().start(input);
    expect(host.keys).toEqual([
      ['Down', 'Enter'],
      ['Down', 'Enter'],
    ]);
    expect(outcome.kind).toBe('report');
  });

  it('presses the keys again when the add-directory dialog ignored the first press', async () => {
    host.paneText = `Adding a new directory:\n\n ${input.runDir}\n\n ❯ No, exit\n   Yes, add it`;
    host.sendKeys = async (_p, keys) => {
      host.keys.push(keys);
      if (host.keys.length < 2) return; // the first press is lost
      host.paneText = '';
      emitEvent('SessionStart');
      writeFileSync(input.reportPath, '{}');
      emitEvent('Stop', { background_tasks: [] });
    };
    const { outcome } = await adapter({ ...timing, trustMaxMs: 2000, dialogRetryMs: 50 }).start(
      input,
    );
    expect(host.keys).toEqual([
      ['Down', 'Enter'],
      ['Down', 'Enter'],
    ]);
    expect(outcome.kind).toBe('report');
  });

  it('waits for the add-directory dialog to finish rendering before deciding', async () => {
    const full = `Adding a new directory:\n ${input.runDir}\n ❯ No, exit\n   Yes, add it`;
    const frames = ['Adding a new directory:\n', `Adding a new directory:\n ${input.runDir}\n`];
    host.read = async () => frames.shift() ?? full;
    host.sendKeys = async (_p, keys) => {
      host.keys.push(keys);
      frames.length = 0;
      host.read = async () => '';
      emitEvent('SessionStart');
      writeFileSync(input.reportPath, '{}');
      emitEvent('Stop', { background_tasks: [] });
    };
    const { outcome } = await adapter().start(input);
    expect(host.keys).toEqual([['Down', 'Enter']]);
    expect(outcome.kind).toBe('report');
  });

  it('reports a startup dialog that is still open when Claude never starts', async () => {
    host.read = async () => 'Some new dialog\n ❯ 1. Yes\n   2. No\n Enter to confirm';
    const { outcome } = await adapter().start(input);
    expect(outcome).toEqual({
      kind: 'permission',
      message: expect.stringMatching(/did not start .*dialog/),
    });
  });

  it('fails the turn when Claude never starts and shows no dialog', async () => {
    host.read = async () => '';
    const { outcome } = await adapter().start(input);
    expect(outcome).toEqual({ kind: 'exited', reason: expect.stringMatching(/did not start/) });
  });

  it('refuses the add-directory dialog for any other directory', async () => {
    host.paneText = 'Adding a new directory:\n /etc\n ❯ No, exit\n   Yes, add it';
    const { outcome } = await adapter().start(input);
    expect(outcome).toEqual({ kind: 'permission', message: 'add-directory dialog' });
    expect(host.keys).toEqual([]);
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

  it('send waits for idle, presses Enter once when UserPromptSubmit is missing', async () => {
    const { a, session } = await started();
    host.stateQueue = ['working', 'working', 'idle'];
    host.sendKeys = async (_p, keys) => {
      host.keys.push(keys);
      emitEvent('UserPromptSubmit');
      emitEvent('Stop', { background_tasks: [] });
    };
    const outcome = await a.send(session, input, 'see msg.md');
    expect(host.texts).toEqual(['see msg.md']);
    expect(host.keys).toEqual([['Enter']]);
    expect(outcome.kind).toBe('report');
    expect(host.stateQueue).toEqual([]);
  });

  it('send returns timeout when never idle, and not-submitted when unconfirmed', async () => {
    const { a, session } = await started();
    host.state = 'working';
    expect(await a.send(session, input, 'x')).toEqual({ kind: 'timeout' });
    expect(host.texts).toEqual([]);
    host.state = 'idle';
    const o = await a.send(session, input, 'x');
    expect(o).toEqual({ kind: 'no_report', detail: 'message was not submitted' });
    expect(host.texts).toEqual(['x']);
    expect(host.keys).toEqual([['Enter']]);
  });

  it('a pre-aborted signal sends and opens nothing', async () => {
    const { a, session } = await started();
    const ctl = new AbortController();
    ctl.abort();
    const o = await a.send(session, { ...input, signal: ctl.signal }, 'x');
    expect(o).toEqual({ kind: 'exited', reason: 'aborted' });
    host.aliveLabels.clear();
    expect(await a.send(session, { ...input, signal: ctl.signal }, 'x')).toEqual(o);
    expect(host.texts).toEqual([]);
    expect(host.opens).toEqual([]);
  });

  it('abort during confirmation does not press Enter', async () => {
    const { a, session } = await started();
    const ctl = new AbortController();
    host.onText = () => setTimeout(() => ctl.abort(), 20);
    const o = await a.send(session, { ...input, signal: ctl.signal }, 'x');
    expect(o).toEqual({ kind: 'exited', reason: 'aborted' });
    expect(host.keys).toEqual([]);
  });

  it('a fresh adapter attaches to a live pane found via list()', async () => {
    const { session } = await started();
    const b = adapter();
    host.onText = () => {
      emitEvent('UserPromptSubmit');
      emitEvent('Stop', { background_tasks: [] });
    };
    expect((await b.send(session, input, 'hello')).kind).toBe('report');
    expect(host.texts).toEqual(['hello']);
    expect(host.opens).toEqual([]);
  });

  it('abort during list() or isAlive() opens no pane', async () => {
    const { a, session } = await started();
    host.aliveLabels.clear();
    for (const gate of ['listGate', 'aliveGate'] as const) {
      const ctl = new AbortController();
      let release!: () => void;
      host[gate] = new Promise<void>((r) => (release = r));
      // list() is only used by a fresh adapter; isAlive() by the known one.
      const ad = gate === 'listGate' ? adapter() : a;
      const p = ad.send(session, { ...input, signal: ctl.signal }, 'x');
      ctl.abort();
      release();
      expect(await p).toEqual({ kind: 'exited', reason: 'aborted' });
      host[gate] = undefined;
    }
    expect(host.opens).toEqual([]);
  });

  it('abort while the agents file is being read opens no pane', async () => {
    const ctl = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ad = createPaneClaude({
      host,
      claudeBin: 'claude',
      randomUUID: () => SID,
      timing,
      readTextFile: async () => {
        await gate;
        return '{}';
      },
      watcherFactory: (p, off) => new HookWatcher(p, { startOffset: off, intervalMs: 10 }),
    });
    const p = ad.start({ ...input, signal: ctl.signal });
    ctl.abort();
    release();
    expect((await p).outcome).toEqual({ kind: 'exited', reason: 'aborted' });
    expect(host.opens).toEqual([]);
  });

  it('start aborted before open opens no pane', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const { outcome } = await adapter().start({ ...input, signal: ctl.signal });
    expect(outcome).toEqual({ kind: 'exited', reason: 'aborted' });
    expect(host.opens).toEqual([]);
  });

  it('a fresh adapter resumes when the pane is gone', async () => {
    const { session } = await started();
    host.aliveLabels.clear();
    host.onOpen = () => {
      emitEvent('SessionStart', { source: 'resume' });
      emitEvent('Stop', { background_tasks: [] });
    };
    const b = adapter();
    expect((await b.send(session, input, 'hello')).kind).toBe('report');
    expect(host.opens[0]!.label).toBe('bp-r1-impl-r2');
    expect(session.paneLabel).toBe('bp-r1-impl-r2');
  });

  it('names a planner pane apart from the implementer, also after a resume', async () => {
    host.onOpen = () => {
      emitEvent('SessionStart');
      writeFileSync(input.reportPath, '{}');
      emitEvent('Stop', { background_tasks: [] });
    };
    const { session } = await adapter().start({ ...input, role: 'plan' });
    expect(session.paneLabel).toBe('bp-r1-plan');
    host.aliveLabels.clear();
    host.onOpen = () => {
      emitEvent('SessionStart', { source: 'resume' });
      emitEvent('Stop', { background_tasks: [] });
    };
    await adapter().send(session, { ...input, role: 'plan' }, 'hello');
    expect(host.opens.at(-1)!.label).toBe('bp-r1-plan-r2');
    expect(session.paneLabel).toBe('bp-r1-plan-r2');
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
    expect(host.opens[0]!.argv).toContain('--add-dir');
    expect(host.opens[0]!.argv[host.opens[0]!.argv.indexOf('--add-dir') + 1]).toBe(input.runDir);
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

  it('a forced stop saves the last screen under logs/<label>-final.txt', async () => {
    const { a, session } = await started();
    host.paneText = 'screen at cancel';
    await a.stop(session, { force: true });
    expect(readFileSync(path.join(input.runDir, 'logs', 'bp-r1-impl-final.txt'), 'utf8')).toBe(
      'screen at cancel',
    );
    expect(host.closed).toEqual(['bp-r1-impl']);
  });

  it('a fresh adapter stops a pane it never saw, found by its label', async () => {
    host.aliveLabels.add('bp-r1-impl');
    host.paneText = 'old screen';
    const session = {
      mode: 'pane' as const,
      sessionId: SID,
      cwd: input.cwd,
      paneLabel: 'bp-r1-impl',
    };
    await adapter().stop(session, {
      force: true,
      runDir: input.runDir,
      eventsPath: input.eventsPath,
    });
    expect(host.closed).toEqual(['bp-r1-impl']);
    expect(readFileSync(path.join(input.runDir, 'logs', 'bp-r1-impl-final.txt'), 'utf8')).toBe(
      'old screen',
    );
    // Without the run's paths a session it never saw is left alone.
    host.aliveLabels.add('bp-r1-impl');
    await adapter().stop(session, { force: true });
    expect(host.aliveLabels.has('bp-r1-impl')).toBe(true);
  });

  it('reattach waits for a working agent in its live pane and opens nothing', async () => {
    host.aliveLabels.add('bp-r1-impl');
    host.state = 'working';
    const session = {
      mode: 'pane' as const,
      sessionId: SID,
      cwd: input.cwd,
      paneLabel: 'bp-r1-impl',
    };
    const a = adapter();
    const turn = a.reattach!(session, input);
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(input.reportPath, '{}');
    emitEvent('Stop');
    host.state = 'idle';
    await expect(turn).resolves.toEqual({ kind: 'report' });
    expect(host.opens).toEqual([]);
    expect(host.texts).toEqual([]);
  });

  it('reattach finds nothing to wait for when the pane is gone or the agent is idle', async () => {
    const session = {
      mode: 'pane' as const,
      sessionId: SID,
      cwd: input.cwd,
      paneLabel: 'bp-r1-impl',
    };
    expect(await adapter().reattach!(session, input)).toBeNull();
    host.aliveLabels.add('bp-r1-impl');
    host.state = 'idle';
    expect(await adapter().reattach!(session, input)).toBeNull();
    // An idle live pane is sent to, not relaunched.
    const a = adapter();
    emitEvent('UserPromptSubmit');
    const sent = a.send(session, input, 'carry on');
    emitEvent('Stop');
    await sent;
    expect(host.opens).toEqual([]);
    expect(host.texts).toEqual(['carry on']);
  });

  it('closes a pane that opened after a cancel, and leaves it after a shutdown', async () => {
    for (const [reason, closed] of [
      [undefined, ['bp-r1-impl']],
      [new ShutdownError(), []],
    ] as const) {
      host = new FakeHost();
      host.cwd = input.cwd;
      host.paneText = 'opened late';
      const ac = new AbortController();
      // The abort lands while the host is still opening the pane.
      host.onOpen = () => ac.abort(reason);
      const a = adapter();
      const { outcome } = await a.start({ ...input, signal: ac.signal });
      expect(outcome).toEqual({ kind: 'exited', reason: 'aborted' });
      expect(host.closed).toEqual(closed);
      expect(host.texts).toEqual([]);
    }
    expect(readFileSync(path.join(input.runDir, 'logs', 'bp-r1-impl-final.txt'), 'utf8')).toBe(
      'opened late',
    );
  });

  it('describe includes attach command and label', async () => {
    const { a, session } = await started();
    expect(a.describe(session)).toBe('herdr attach bp-r1-impl (workspace bp-r1-impl)');
  });
});
