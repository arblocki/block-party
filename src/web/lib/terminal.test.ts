import { describe, expect, it } from 'vitest';
import type { RunEvent } from '../types';
import {
  closeNotice,
  liveSession,
  resizeFrame,
  terminalSocketUrl,
  terminalTheme,
} from './terminal';

let id = 1;
const ev = (type: string, payload: unknown): RunEvent => ({
  id: id++,
  runId: 'r1',
  stageId: null,
  ts: '2026-01-01T00:00:00.000Z',
  type,
  payload,
});

describe('liveSession', () => {
  const impl = ev('implementer.session', { mode: 'pane', attach: 'herdr --session s' });
  const plan = ev('planner.session', { mode: 'pane', attach: 'herdr --session p' });

  it('shows the implementer outside planning', () => {
    expect(liveSession('implementing', [plan, impl])).toEqual({
      role: 'implementer',
      attach: 'herdr --session s',
    });
  });

  it('shows the planner while planning', () => {
    expect(liveSession('planning', [plan, impl])).toEqual({
      role: 'planner',
      attach: 'herdr --session p',
    });
  });

  it('uses the latest session event of the role', () => {
    const later = ev('implementer.session', { mode: 'pane', attach: 'later' });
    expect(liveSession('implementing', [impl, later])?.attach).toBe('later');
  });

  it('has no terminal for headless sessions, missing sessions or finished runs', () => {
    expect(
      liveSession('implementing', [ev('implementer.session', { mode: 'headless' })]),
    ).toBeNull();
    expect(liveSession('implementing', [plan])).toBeNull();
    expect(liveSession('planning', [impl])).toBeNull();
    expect(liveSession('complete', [impl])).toBeNull();
    expect(liveSession('implementing', [])).toBeNull();
  });

  it('tolerates a missing attach string', () => {
    expect(liveSession('implementing', [ev('implementer.session', { mode: 'pane' })])).toEqual({
      role: 'implementer',
      attach: null,
    });
  });
});

describe('terminalSocketUrl', () => {
  it('follows the page scheme and host', () => {
    expect(terminalSocketUrl('r1', { protocol: 'http:', host: '127.0.0.1:5174' })).toBe(
      'ws://127.0.0.1:5174/api/runs/r1/terminal',
    );
    expect(terminalSocketUrl('r 1', { protocol: 'https:', host: 'bp.example' })).toBe(
      'wss://bp.example/api/runs/r%201/terminal',
    );
  });
});

describe('resizeFrame', () => {
  it('is the control message the server validates', () => {
    expect(JSON.parse(resizeFrame(120, 40))).toEqual({ type: 'resize', cols: 120, rows: 40 });
  });
});

describe('closeNotice', () => {
  it('words the unavailable cases for a newcomer', () => {
    expect(
      closeNotice(4501, 'Embedded terminal unavailable: native build missing', true).message,
    ).toBe('Embedded terminal unavailable: native build missing');
    expect(closeNotice(4404, 'the agent session is not running', true)).toEqual({
      kind: 'unavailable',
      message: 'Embedded terminal unavailable: the agent session is not running',
    });
    expect(closeNotice(4429, '', true).kind).toBe('unavailable');
  });

  it('distinguishes ended sessions from a refused connection', () => {
    expect(closeNotice(1000, 'terminal ended', true).kind).toBe('ended');
    expect(closeNotice(4408, 'idle', true).message).toContain('30 minutes');
    expect(closeNotice(1006, '', true).message).toContain('lost');
    expect(closeNotice(1006, '', false).kind).toBe('unavailable');
    expect(closeNotice(1006, '', false).message).toContain('refused the connection');
  });
});

describe('terminalTheme', () => {
  it('reads the app colours and falls back when a variable is missing', () => {
    const t = terminalTheme((n) => (n === '--color-text' ? ' #fff ' : ''));
    expect(t.foreground).toBe('#fff');
    expect(t.background).toBe('#0c1011');
  });
});
