/**
 * Q6 (+ trust inheritance): ways to deliver a follow-up message to an interactive Claude pane.
 *  a) agent.prompt with wait  b) pane.send_input (text + Enter in one call)
 *  c) typing ahead while Claude is still working  d) is a subdirectory of a trusted dir trusted?
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  SCRATCH,
  acceptTrustDialog,
  client,
  launchInWorkspace,
  log,
  makeRepo,
  obj,
  randomUUID,
  readEvents,
  readPane,
  sleep,
  str,
  waitFor,
  writeRunSettings,
} from './common.js';

const runDir = path.join(SCRATCH, 'run3');
fs.rmSync(runDir, { recursive: true, force: true });
const repo = makeRepo('run3-repo');
const { settings, events } = writeRunSettings(runDir, {
  permissions: { defaultMode: 'acceptEdits' },
});
const count = (name: string) =>
  readEvents(events).filter((e) => obj(e.payload).hook_event_name === name).length;
const status = async (id: string) =>
  str(obj(obj(await client.call('pane.get', { pane_id: id })).pane).agent_status);

const pane = await launchInWorkspace('bp-spike-run3', repo, [
  'claude',
  '--model',
  'haiku',
  '--session-id',
  randomUUID(),
  '--settings',
  settings,
  'Create a.txt containing 1, then stop.',
]);
await acceptTrustDialog(pane.paneId, events);
await waitFor('first Stop', () => count('Stop') >= 1, 60_000);
await waitFor('herdr idle', async () => (await status(pane.paneId)) === 'idle', 10_000, 100);

// a) herdr's own agent.prompt, waiting for the settled state
let t = Date.now();
const a = await client.call('agent.prompt', {
  target: pane.paneId,
  text: 'Create b.txt containing 2, then stop.',
  wait: { timeout_ms: 60_000 },
});
log('a) agent.prompt returned after', Date.now() - t, 'ms:', JSON.stringify(a).slice(0, 300));
log('   Stop count', count('Stop'), 'b.txt', fs.existsSync(path.join(repo, 'b.txt')));

// b) send_input: text + Enter in one request
await waitFor('idle', async () => (await status(pane.paneId)) === 'idle', 10_000, 100);
t = Date.now();
const before = count('UserPromptSubmit');
await client.call('pane.send_input', {
  pane_id: pane.paneId,
  text: 'Create c.txt containing 3, then stop.',
  keys: ['Enter'],
});
await waitFor('submit', () => count('UserPromptSubmit') > before, 15_000, 50);
log('b) send_input -> UserPromptSubmit after', Date.now() - t, 'ms');
await waitFor('c.txt', () => fs.existsSync(path.join(repo, 'c.txt')), 60_000);
await waitFor('idle', async () => (await status(pane.paneId)) === 'idle', 20_000, 100);

// c) type ahead while working: start a multi-step task, then send another message 1.5s later
const s0 = count('UserPromptSubmit');
await client.call('pane.send_input', {
  pane_id: pane.paneId,
  text: 'Create d1.txt, d2.txt, d3.txt, d4.txt (contents 4) one at a time with separate Write calls, then stop.',
  keys: ['Enter'],
});
await sleep(1500);
log('c) status when typing ahead:', await status(pane.paneId));
await client.call('pane.send_input', {
  pane_id: pane.paneId,
  text: 'Also create e.txt containing 5.',
  keys: ['Enter'],
});
await waitFor('e.txt', () => fs.existsSync(path.join(repo, 'e.txt')), 90_000);
await waitFor('idle', async () => (await status(pane.paneId)) === 'idle', 30_000, 100);
log(
  'c) UserPromptSubmit events from this phase:',
  readEvents(events)
    .filter((e) => obj(e.payload).hook_event_name === 'UserPromptSubmit')
    .slice(s0)
    .map((e) => str(obj(e.payload).prompt).slice(0, 50)),
);
log(
  '   files:',
  fs
    .readdirSync(repo)
    .filter((f) => f.endsWith('.txt'))
    .sort()
    .join(','),
);
log('   Stop count', count('Stop'));

// long multi-line message: does bracketed paste keep it as one message?
const s1 = count('UserPromptSubmit');
await client.call('pane.send_input', {
  pane_id: pane.paneId,
  text: 'Line one of the message.\nLine two: create f.txt containing 6.\nLine three: then stop.',
  keys: ['Enter'],
});
await waitFor('f.txt', () => fs.existsSync(path.join(repo, 'f.txt')), 60_000);
await sleep(1500);
log('multi-line: UserPromptSubmit count delta', count('UserPromptSubmit') - s1);

// d) trust inheritance: subdirectory of the (now trusted) repo
fs.mkdirSync(path.join(repo, 'sub'));
const dir2 = path.join(runDir, 'events-sub.jsonl');
const s2 = writeRunSettings(path.join(runDir, 'sub'));
const pane2 = await launchInWorkspace('bp-spike-run3-sub', path.join(repo, 'sub'), [
  'claude',
  '--model',
  'haiku',
  '--settings',
  s2.settings,
  'Reply with the word ok and stop.',
]);
await sleep(4000);
log(
  'd) subdir pane shows trust dialog?',
  (await readPane(pane2.paneId, 30)).includes('Yes, I trust this folder'),
  dir2 && '',
);
await client.call('workspace.close', { workspace_id: pane2.workspaceId });
await client.call('workspace.close', { workspace_id: pane.workspaceId });
log('done');
