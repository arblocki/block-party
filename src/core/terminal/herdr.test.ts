import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeHerdr, type FakeHerdr } from './fake-herdr.testutil.js';
import {
  HerdrClient,
  HerdrError,
  cleanHerdrEnv,
  ensureServer,
  type HerdrSpawnFn,
} from './herdr-client.js';
import { createHerdrHost } from './herdr.js';

let fake: FakeHerdr;
beforeEach(async () => {
  fake = await startFakeHerdr();
});
afterEach(async () => {
  await fake.close();
});

const sock = () => new HerdrClient(fake.socketPath);

describe('HerdrClient', () => {
  it('returns the result object', async () => {
    fake.on('ping', { type: 'pong' });
    expect(await sock().call('ping')).toEqual({ type: 'pong' });
  });

  it('maps a missing socket to server_not_running', async () => {
    const c = new HerdrClient(path.join(os.tmpdir(), 'hd-nonexistent.sock'));
    await expect(c.call('ping')).rejects.toMatchObject({ code: 'server_not_running' });
  });

  it('times out', async () => {
    fake.hang('pane.read');
    const err = await sock()
      .call('pane.read', {}, { timeoutMs: 100 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe('timeout');
  });

  it('surfaces server error codes', async () => {
    fake.on('pane.get', () => {
      throw { code: 'pane_not_found', message: 'nope' };
    });
    await expect(sock().call('pane.get')).rejects.toMatchObject({ code: 'pane_not_found' });
  });

  it('ignores malformed lines', async () => {
    fake.on('ping', { ok: true });
    fake.garbageBefore('not json at all\n[1,2]\n');
    expect(await sock().call('ping')).toEqual({ ok: true });
  });

  it('subscribe receives pushed events and can close', async () => {
    const got: unknown[] = [];
    const sub = await sock().subscribe(['pane.created'], (m) => got.push(m));
    expect(fake.calls.at(-1)).toEqual({
      method: 'events.subscribe',
      params: { subscriptions: [{ type: 'pane.created' }] },
    });
    fake.push('garbage');
    fake.push(JSON.stringify({ event: 'pane_closed', data: { pane_id: 'w1:p1' } }));
    await expect.poll(() => got.length).toBe(1);
    expect(got[0]).toEqual({ event: 'pane_closed', data: { pane_id: 'w1:p1' } });
    sub.close();
  });
});

describe('cleanHerdrEnv', () => {
  it('strips HERDR_*, TERM_PROGRAM, SSH_AUTH_SOCK', () => {
    expect(
      cleanHerdrEnv({
        HERDR_PANE_ID: 'x',
        HERDR_ENV: '1',
        TERM_PROGRAM: 'a',
        SSH_AUTH_SOCK: 's',
        PATH: '/bin',
      }),
    ).toEqual({ PATH: '/bin' });
  });
});

describe('ensureServer', () => {
  it('does not spawn when ping works', async () => {
    let spawned = false;
    const started = await ensureServer('bp-x', {
      socketPath: fake.socketPath,
      spawnFn: () => ((spawned = true), { unref() {} }),
    });
    expect(started).toBe(false);
    expect(spawned).toBe(false);
  });

  it('spawns detached with clean env and polls until up', async () => {
    const path2 = path.join(path.dirname(fake.socketPath), 'late.sock');
    process.env.HERDR_TEST_LEAK = '1';
    const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const spawnFn: HerdrSpawnFn = (command, args, o) => {
      calls.push({ command, args, env: o.env });
      expect(o.detached).toBe(true);
      // "server comes up": expose the fake under the expected path.
      fs.symlinkSync(fake.socketPath, path2);
      return { unref() {} };
    };
    try {
      const started = await ensureServer('bp-x', { herdrBin: 'hb', socketPath: path2, spawnFn });
      expect(started).toBe(true);
    } finally {
      delete process.env.HERDR_TEST_LEAK;
    }
    expect(calls[0]?.command).toBe('hb');
    expect(calls[0]?.args).toEqual(['--session', 'bp-x', 'server']);
    expect(calls[0]?.env.HERDR_TEST_LEAK).toBeUndefined();
  });

  it('gives up with server_not_running', async () => {
    const err = await ensureServer('bp-x', {
      socketPath: path.join(os.tmpdir(), 'hd-never.sock'),
      spawnFn: () => ({ unref() {} }),
      timeoutMs: 250,
    }).catch((e: unknown) => e);
    expect((err as HerdrError).code).toBe('server_not_running');
  });
});

describe('createHerdrHost', () => {
  const cwd = fs.realpathSync(os.tmpdir());
  const pane = { session: 'bp-x', label: 'bp-run-impl', cwd };
  const paneList = (id: string, extra: object = {}) => ({
    panes: [{ pane_id: id, label: 'bp-run-impl', cwd, ...extra }],
  });

  it('open: workspace.create then layout.apply with argv passed through', async () => {
    fake.on('ping', {});
    fake.on('workspace.create', {
      workspace: { workspace_id: 'w1' },
      tab: { tab_id: 'w1:t1' },
      root_pane: { pane_id: 'w1:p1' },
    });
    fake.on('layout.apply', { layout: { tab_id: 'w1:t1', root: { pane_id: 'w1:p1' } } });
    const host = createHerdrHost({ session: 'bp-x', socketPath: fake.socketPath });
    const ref = await host.open({
      label: 'bp-run-impl',
      cwd,
      argv: ['claude', '--model', 'haiku', 'do it'],
      env: { A: 'b' },
    });
    expect(ref).toEqual(pane);
    const methods = fake.calls.map((c) => c.method);
    expect(methods).toEqual(['ping', 'workspace.create', 'layout.apply']);
    expect(fake.calls[1]?.params).toEqual({ cwd, label: 'bp-run-impl' });
    expect(fake.calls[2]?.params).toEqual({
      tab_id: 'w1:t1',
      root: {
        type: 'pane',
        cwd,
        label: 'bp-run-impl',
        command: ['claude', '--model', 'haiku', 'do it'],
        env: { A: 'b' },
      },
    });
  });

  it('resolves by label after a server restart (ids changed)', async () => {
    fake.on('pane.list', paneList('w1:p1'));
    fake.on('pane.send_input', {});
    const host = createHerdrHost({ session: 'bp-x', client: sock() });
    await host.sendText(pane, 'hello', { submit: true });
    fake.on('pane.list', paneList('w7:p3'));
    await host.sendText(pane, 'again');
    const sends = fake.calls.filter((c) => c.method === 'pane.send_input');
    expect(sends[0]?.params).toEqual({ pane_id: 'w1:p1', text: 'hello', keys: ['Enter'] });
    expect(sends[1]?.params).toEqual({ pane_id: 'w7:p3', text: 'again', keys: [] });
  });

  it('matches cwd via realpath and ignores other labels', async () => {
    fake.on('pane.list', {
      panes: [
        { pane_id: 'w1:p1', label: 'other', cwd },
        { pane_id: 'w2:p1', label: 'bp-run-impl', cwd: '/elsewhere' },
        { pane_id: 'w3:p1', label: 'bp-run-impl', cwd },
      ],
    });
    const host = createHerdrHost({ session: 'bp-x', client: sock() });
    fake.on('pane.send_keys', {});
    await host.sendKeys(pane, ['Down', 'Enter']);
    expect(fake.calls.find((c) => c.method === 'pane.send_keys')?.params).toEqual({
      pane_id: 'w3:p1',
      keys: ['Down', 'Enter'],
    });
  });

  it('read, agentState, list, attachCommand', async () => {
    fake.on('pane.list', paneList('w1:p1'));
    fake.on('pane.read', { read: { text: 'hi\n' } });
    fake.on('pane.get', { pane: { agent_status: 'blocked' } });
    const host = createHerdrHost({ session: 'bp-x', client: sock() });
    expect(await host.read(pane, 5)).toBe('hi\n');
    expect(fake.calls.find((c) => c.method === 'pane.read')?.params).toEqual({
      pane_id: 'w1:p1',
      source: 'recent',
      lines: 5,
    });
    expect(await host.agentState(pane)).toBe('blocked');
    fake.on('pane.get', { pane: { agent_status: 'done' } });
    expect(await host.agentState(pane)).toBe('unknown');
    expect(await host.list()).toEqual([pane]);
    expect(host.attachCommand(pane)).toContain('herdr --session bp-x');
    expect(host.attachCommand(pane)).toContain('bp-run-impl');
  });

  it('isAlive is false when the pane is gone or the server is down; close is a no-op then', async () => {
    fake.on('pane.list', { panes: [] });
    const host = createHerdrHost({ session: 'bp-x', client: sock() });
    expect(await host.isAlive(pane)).toBe(false);
    await host.close(pane);
    expect(fake.calls.some((c) => c.method === 'pane.close')).toBe(false);
    const down = createHerdrHost({
      session: 'bp-x',
      client: new HerdrClient(path.join(os.tmpdir(), 'hd-down.sock')),
    });
    expect(await down.isAlive(pane)).toBe(false);
    await expect(down.sendKeys(pane, ['Enter'])).rejects.toMatchObject({ code: 'pane_not_found' });
  });

  it('close calls pane.close; server_not_running propagates from open', async () => {
    fake.on('pane.list', paneList('w1:p1'));
    fake.on('pane.close', {});
    const host = createHerdrHost({ session: 'bp-x', client: sock() });
    await host.close(pane);
    expect(fake.calls.find((c) => c.method === 'pane.close')?.params).toEqual({ pane_id: 'w1:p1' });
    const down = createHerdrHost({
      session: 'bp-x',
      client: new HerdrClient(path.join(os.tmpdir(), 'hd-down.sock')),
    });
    await expect(down.open({ label: 'l', cwd, argv: ['x'] })).rejects.toMatchObject({
      code: 'server_not_running',
    });
  });
});
