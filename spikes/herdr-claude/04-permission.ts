/**
 * Q4/Q5: permission prompt. Default permission mode, a Bash command that is not allowlisted.
 * Records hook events, herdr agent-status events, and herdr's view of the session id (set by the
 * user's own herdr SessionStart hook) so we can compare timings and confirm hook coexistence.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { JsonObject } from './herdr-client.js';
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

const runDir = path.join(SCRATCH, 'run2');
fs.rmSync(runDir, { recursive: true, force: true });
const repo = makeRepo('run2-repo');
const sessionId = randomUUID();
const { settings, events } = writeRunSettings(runDir); // default permission mode
const agentLog = path.join(runDir, 'herdr-events.jsonl');
const t0 = Date.now();
const record = (msg: JsonObject) =>
  fs.appendFileSync(
    agentLog,
    JSON.stringify({ t: Date.now() - t0, ts: new Date().toISOString(), msg }) + '\n',
  );

const prompt = 'Use the Bash tool to run exactly: date > stamp.txt . Then stop.';
const pane = await launchInWorkspace('bp-spike-run2', repo, [
  'claude',
  '--model',
  'haiku',
  '--permission-mode',
  'manual',
  '--session-id',
  sessionId,
  '--settings',
  settings,
  prompt,
]);
const sub = await client.subscribe(
  [{ type: 'pane.agent_status_changed', pane_id: pane.paneId }],
  record,
);
log('launched', pane);
await acceptTrustDialog(pane.paneId, events);

await waitFor(
  'Notification hook',
  () => readEvents(events).some((e) => obj(e.payload).hook_event_name === 'Notification'),
  60_000,
  100,
);
log('Notification hook seen');
await sleep(500);
const info = obj(obj(await client.call('pane.get', { pane_id: pane.paneId })).pane);
log(
  'herdr pane.get during prompt:',
  JSON.stringify({
    agent: info.agent,
    agent_status: info.agent_status,
    agent_session_id: info.agent_session_id,
    agent_session_path: info.agent_session_path,
    keys: Object.keys(info),
  }),
);
log(
  'agent.get:',
  JSON.stringify(await client.call('agent.get', { target: pane.paneId })).slice(0, 700),
);
log('pane text during prompt:\n' + (await readPane(pane.paneId, 14)));

// Approve with Enter (default option is "Yes").
const tApprove = Date.now();
await client.call('pane.send_keys', { pane_id: pane.paneId, keys: ['Enter'] });
await waitFor(
  'Stop',
  () => readEvents(events).some((e) => obj(e.payload).hook_event_name === 'Stop'),
  60_000,
  100,
);
log(
  'Stop',
  Date.now() - tApprove,
  'ms after approving; stamp.txt exists:',
  fs.existsSync(path.join(repo, 'stamp.txt')),
);
await sleep(1500);
sub.close();
await client.call('workspace.close', { workspace_id: pane.workspaceId });
log('done');
for (const e of readEvents(events)) {
  const p = obj(e.payload);
  console.log(str(e.ts).slice(11, 23), p.hook_event_name, JSON.stringify(p).slice(0, 420));
}
for (const l of fs.readFileSync(agentLog, 'utf8').split('\n').filter(Boolean)) {
  const e = obj(JSON.parse(l));
  console.log(str(e.ts).slice(11, 23), JSON.stringify(e.msg).slice(0, 200));
}
