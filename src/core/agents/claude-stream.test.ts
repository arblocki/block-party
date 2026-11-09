import { describe, expect, it } from 'vitest';
import { StreamParser, parseEvent, summarize, toolResultText } from './claude-stream.js';

describe('StreamParser', () => {
  it('decodes a multibyte UTF-8 character split across Buffer chunks', () => {
    const bytes = Buffer.from(`${JSON.stringify({ type: 'x', text: 'héllo 🎉' })}\n`, 'utf8');
    const emoji = bytes.indexOf(Buffer.from('🎉', 'utf8'));
    const p = new StreamParser();
    const events = [
      ...p.push(bytes.subarray(0, emoji + 2)),
      ...p.push(bytes.subarray(emoji + 2)),
      ...p.flush(),
    ];
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).toContain('héllo 🎉');
    expect(JSON.stringify(events[0])).not.toContain('�');
  });

  it('flushes a trailing partial character and line at end of stream', () => {
    const bytes = Buffer.from(JSON.stringify({ type: 'x', text: 'é' }), 'utf8');
    const p = new StreamParser();
    const events = [
      ...p.push(bytes.subarray(0, bytes.length - 3)),
      ...p.push(bytes.subarray(bytes.length - 3)),
      ...p.flush(),
    ];
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).toContain('é');
  });
});

const SID = '25b3d6e5-dcf2-47ed-8985-874a028801e8';

const init = {
  type: 'system',
  subtype: 'init',
  cwd: '/tmp/r1',
  session_id: SID,
  model: 'claude-haiku-5-5',
  permissionMode: 'acceptEdits',
  tools: ['Task', 'Bash', 'Edit', 'Write'],
  agents: ['claude', 'helper'],
  claude_code_version: '2.1.319',
};
const assistantToolUse = {
  type: 'assistant',
  message: {
    model: 'claude-haiku-5-5',
    id: 'msg_01',
    role: 'assistant',
    content: [
      { type: 'text', text: 'Writing the file.' },
      { type: 'tool_use', id: 'toolu_01', name: 'Write', input: { file_path: 'a.txt' } },
    ],
    usage: { input_tokens: 2, output_tokens: 4 },
  },
  parent_tool_use_id: null,
  session_id: SID,
};
const userToolResult = {
  type: 'user',
  message: {
    role: 'user',
    content: [{ tool_use_id: 'toolu_01', type: 'tool_result', content: 'File created' }],
  },
  parent_tool_use_id: null,
  session_id: SID,
};
const taskStarted = {
  type: 'system',
  subtype: 'task_started',
  session_id: SID,
  task_id: 't1',
  tool_use_id: 'toolu_agent',
  subagent_type: 'helper',
  description: 'Write b.txt',
};
const taskNotification = {
  type: 'system',
  subtype: 'task_notification',
  session_id: SID,
  task_id: 't1',
  status: 'completed',
  summary: 'I created b.txt',
  usage: { total_tokens: 10, tool_uses: 1, duration_ms: 5 },
};
const permissionDenied = {
  type: 'system',
  subtype: 'permission_denied',
  session_id: SID,
  tool_name: 'Bash',
  tool_use_id: 'toolu_02',
  message: 'Bash(rm -rf /) denied',
};
const resultBase = {
  type: 'result',
  session_id: SID,
  num_turns: 4,
  duration_ms: 1000,
  duration_api_ms: 900,
  total_cost_usd: 0.008,
  usage: { input_tokens: 8, output_tokens: 908 },
  permission_denials: [],
};
const resultSuccess = {
  ...resultBase,
  subtype: 'success',
  is_error: false,
  result: 'Done.',
  stop_reason: 'end_turn',
};
const resultError = { ...resultBase, subtype: 'error_max_turns', is_error: true };

describe('parseEvent', () => {
  it.each([
    ['init', init, 'init'],
    ['assistant text/tool_use', assistantToolUse, 'assistant'],
    ['user tool_result', userToolResult, 'user'],
    ['task_started', taskStarted, 'task'],
    ['task_notification', taskNotification, 'task'],
    ['permission_denied', permissionDenied, 'permission_denied'],
    ['result success', resultSuccess, 'result'],
    ['result error', resultError, 'result'],
    [
      'hook_started',
      {
        type: 'system',
        subtype: 'hook_started',
        session_id: SID,
        hook_event: 'PreToolUse',
        hook_name: 'h',
        hook_id: 'h1',
      },
      'hook',
    ],
    [
      'rate_limit_event',
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } },
      'rate_limit',
    ],
  ])('classifies %s as %s', (_name, raw, kind) => {
    expect(parseEvent(raw).kind).toBe(kind);
  });

  it('keeps result error details', () => {
    const ev = parseEvent(resultError);
    expect(ev.kind === 'result' && ev.event.is_error).toBe(true);
    expect(ev.kind === 'result' && ev.event.subtype).toBe('error_max_turns');
  });

  it('keeps extra fields on loose events', () => {
    const ev = parseEvent({ ...init, brand_new_field: 42 });
    expect(ev.kind === 'init' && (ev.event as Record<string, unknown>).brand_new_field).toBe(42);
  });

  it('treats thinking_tokens system events and thinking-only streams as unknown', () => {
    const ev = parseEvent({ type: 'system', subtype: 'thinking_tokens', session_id: SID });
    expect(ev).toMatchObject({ kind: 'unknown', reason: 'system/thinking_tokens' });
  });

  it('treats an unrecognised top-level type as unknown', () => {
    expect(parseEvent({ type: 'stream_event' })).toMatchObject({
      kind: 'unknown',
      reason: 'type stream_event',
    });
  });

  it.each([null, 42, 'str', [], {}, { type: 7 }])('never throws on %j', (raw) => {
    expect(parseEvent(raw).kind).toBe('unknown');
  });

  it('returns unknown (with a reason) for a known type with the wrong shape', () => {
    const ev = parseEvent({ type: 'assistant', message: 'nope' });
    expect(ev.kind).toBe('unknown');
    expect(ev.kind === 'unknown' && ev.reason.length).toBeGreaterThan(0);
  });

  it('preserves parent_tool_use_id on subagent assistant and user events', () => {
    const a = parseEvent({ ...assistantToolUse, parent_tool_use_id: 'toolu_agent' });
    const u = parseEvent({
      ...userToolResult,
      parent_tool_use_id: 'toolu_agent',
      agent_id: 'agent-1',
    });
    expect(a.kind === 'assistant' && a.event.parent_tool_use_id).toBe('toolu_agent');
    expect(u.kind === 'user' && u.event.parent_tool_use_id).toBe('toolu_agent');
    expect(u.kind === 'user' && u.event.agent_id).toBe('agent-1');
  });

  it('keeps parent_tool_use_id null for top-level events', () => {
    const a = parseEvent(assistantToolUse);
    expect(a.kind === 'assistant' && a.event.parent_tool_use_id).toBeNull();
  });
});

describe('StreamParser lines', () => {
  it('parses several events per chunk and across chunk boundaries', () => {
    const text = [init, assistantToolUse, resultSuccess].map((e) => JSON.stringify(e)).join('\n');
    const p = new StreamParser();
    const cut = text.indexOf('"assistant"') + 3;
    const events = [...p.push(text.slice(0, cut)), ...p.push(`${text.slice(cut)}\n`), ...p.flush()];
    expect(events.map((e) => e.kind)).toEqual(['init', 'assistant', 'result']);
  });

  it('reports an invalid JSON line as unknown and keeps going', () => {
    const p = new StreamParser();
    const events = p.push(`not json\n${JSON.stringify(init)}\n\n`);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: 'unknown', raw: 'not json', reason: 'invalid JSON' });
    expect(events[1]?.kind).toBe('init');
  });

  it('reports a truncated final line as invalid JSON on flush', () => {
    const p = new StreamParser();
    expect(p.push('{"type":"resu')).toEqual([]);
    expect(p.flush()).toMatchObject([{ kind: 'unknown', reason: 'invalid JSON' }]);
  });

  it('ignores blank lines', () => {
    expect(new StreamParser().push('\n  \n')).toEqual([]);
  });
});

describe('toolResultText and summarize', () => {
  it('extracts text from string and block-array forms', () => {
    expect(toolResultText('abc')).toBe('abc');
    expect(toolResultText([{ type: 'text', text: 'a' }, { type: 'image' }, { text: 'b' }])).toBe(
      'ab',
    );
    expect(toolResultText(undefined)).toBe('');
  });

  it('summarizes known events and returns null for unknown', () => {
    expect(summarize(parseEvent(init))).toContain(`session=${SID}`);
    expect(summarize(parseEvent(assistantToolUse))).toContain('tool_use Write');
    expect(summarize(parseEvent(resultSuccess))).toContain('turns=4');
    expect(
      summarize(parseEvent({ ...userToolResult, parent_tool_use_id: 'toolu_abcdef' })),
    ).toContain('[sub abcdef]');
    expect(summarize(parseEvent({ type: 'zzz' }))).toBeNull();
  });
});
