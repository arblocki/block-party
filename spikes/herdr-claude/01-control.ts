/** Q1: create workspaces/panes, run a command, read output, close, check ID renumbering. */
import { HerdrClient, ensureServer, type JsonObject } from './herdr-client.js';

const session = process.env.HERDR_SPIKE_SESSION ?? 'bp-spike';
await ensureServer(session);
const c = HerdrClient.forSession(session);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const show = (title: string, v: unknown) =>
  console.log(`--- ${title}\n${JSON.stringify(v, null, 1)}`);

function obj(v: unknown): JsonObject {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('not an object');
  return v as JsonObject;
}
const str = (v: unknown) => String(v);

const mk = async (label: string, cwd: string) => {
  const r = await c.call('workspace.create', { cwd, label });
  return { ws: obj(r.workspace), pane: obj(r.root_pane) };
};

const a = await mk('bp-spike-a', '/private/tmp');
const b = await mk('bp-spike-b', '/private/var');
const cc = await mk('bp-spike-c', '/private/tmp');
show('workspace ids', [a.ws.workspace_id, b.ws.workspace_id, cc.ws.workspace_id]);

// the shell needs a moment to draw its prompt; sending input within ~2.5s of creation arrived as a literal bracketed paste
await sleep(6000);
// run a command in workspace b's pane: send_input = text + Enter key
const bp = str(b.pane.pane_id);
await c.call('pane.send_input', { pane_id: bp, text: 'echo hello-from-$(pwd)', keys: ['Enter'] });
await sleep(800);
const read = await c.call('pane.read', { pane_id: bp, source: 'recent', lines: 10 });
show('pane.read', obj(read.read ?? read));

// wait_for_output
const w = await c.call('pane.wait_for_output', {
  pane_id: bp,
  source: 'recent',
  match: { type: 'substring', value: 'hello-from-/private/var' },
  timeout_ms: 5000,
});
show('wait_for_output (trimmed)', Object.keys(w));

// split a pane in b
const sp = await c.call('pane.split', {
  target_pane_id: bp,
  direction: 'right',
  cwd: '/private/tmp',
});
show('pane.split', sp);
const splitId = str(obj(sp.pane).pane_id);
await c.call('pane.rename', { pane_id: splitId, label: 'bp-spike-b-implementer' });

const before = await c.call('pane.list', {});
show('pane.list before close', before);

// close workspace a (first one) and see whether the remaining ids renumber
await c.call('workspace.close', { workspace_id: str(a.ws.workspace_id) });
const wl = await c.call('workspace.list', {});
show('workspace.list after closing first workspace', wl);
const after = await c.call('pane.list', {});
show('pane.list after closing first workspace', after);

// close the split pane in b and re-list
await c.call('pane.close', { pane_id: splitId });
show('pane.list after pane.close', await c.call('pane.list', {}));

// new workspace after closes: is an id reused?
const d = await mk('bp-spike-d', '/private/tmp');
show('new workspace id after closes', d.ws.workspace_id);

for (const w2 of obj(await c.call('workspace.list', {})).workspaces as JsonObject[]) {
  if (str(w2.label).startsWith('bp-spike-'))
    await c.call('workspace.close', { workspace_id: str(w2.workspace_id) });
}
show('final workspaces', await c.call('workspace.list', {}));
