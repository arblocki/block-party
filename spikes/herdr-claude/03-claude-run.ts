/**
 * Q3-Q8: launch interactive Claude in a herdr pane with per-run hooks, record hooks + herdr agent
 * state, send a follow-up, exit, resume in a new pane, close the pane and check for survivors.
 *
 * Run: HERDR_SPIKE_SESSION=bp-spike npx tsx spikes/herdr-claude/03-claude-run.ts
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { JsonObject } from './herdr-client.js';
import {
  HELPER_AGENTS,
  acceptTrustDialog,
  SCRATCH,
  client,
  launchInWorkspace,
  log,
  makeRepo,
  obj,
  randomUUID,
  readEvents,
  readPane,
  sleep,
  waitFor,
  writeRunSettings,
} from './common.js';

const runDir = path.join(SCRATCH, 'run1');
fs.rmSync(runDir, { recursive: true, force: true });
const repo = makeRepo('run1-repo');
const sessionId = randomUUID();
const { settings, events } = writeRunSettings(runDir, {
  permissions: { defaultMode: 'acceptEdits' },
});
const agentLog = path.join(runDir, 'herdr-events.jsonl');
const label = `bp-spike-run1`;

const transcript = path.join(
  os.homedir(),
  '.claude',
  'projects',
  repo.replace(/[^a-zA-Z0-9]/g, '-'),
  `${sessionId}.jsonl`,
);
const lineCount = (f: string) =>
  fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length : 0;
const pids = () => {
  try {
    return execFileSync('pgrep', ['-f', sessionId], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
};

// Q5: record herdr pane events for the whole run.
const t0 = Date.now();
const record = (msg: JsonObject) =>
  fs.appendFileSync(
    agentLog,
    JSON.stringify({ t: Date.now() - t0, ts: new Date().toISOString(), msg }) + '\n',
  );
const sub = await client.subscribe(
  ['pane.agent_detected', 'pane.exited', 'pane.closed', 'pane.created'],
  record,
);
const subs = [sub];

const prompt =
  'Create hello.txt containing hi. Then use the helper subagent to create bye.txt. ' +
  'Then write report.json with {"status":"done"} and stop.';
const argv = [
  'claude',
  '--model',
  'haiku',
  '--session-id',
  sessionId,
  '--settings',
  settings,
  '--agents',
  HELPER_AGENTS,
  prompt,
];
log('session', sessionId, 'repo', repo);
const pane = await launchInWorkspace(label, repo, argv);
log('launched', pane);
subs.push(
  await client.subscribe([{ type: 'pane.agent_status_changed', pane_id: pane.paneId }], record),
);

// First run in a new directory shows the folder-trust dialog (herdr: not `blocked`, status unknown).
await acceptTrustDialog(pane.paneId, events);

// Wait for SessionStart.
try {
  await waitFor(
    'SessionStart hook',
    () => readEvents(events).some((e) => obj(e.payload).hook_event_name === 'SessionStart'),
    40_000,
  );
} catch (e) {
  log('NO SessionStart; pane text:\n' + (await readPane(pane.paneId)));
  throw e;
}
log('SessionStart seen after', Date.now() - t0, 'ms');

await waitFor('report.json', () => fs.existsSync(path.join(repo, 'report.json')), 120_000);
await waitFor(
  'first Stop',
  () => readEvents(events).some((e) => obj(e.payload).hook_event_name === 'Stop'),
  60_000,
);
log('first turn done; files:', fs.readdirSync(repo).join(','));
const agent = obj(await client.call('pane.get', { pane_id: pane.paneId }));
log('pane.get after first turn', JSON.stringify(agent).slice(0, 500));
await waitFor(
  'herdr idle',
  async () => {
    const p = obj(obj(await client.call('pane.get', { pane_id: pane.paneId })).pane);
    return p.agent_status === 'idle' || p.agent_status === 'done';
  },
  15_000,
);

// Q6: send a follow-up. send_text then Enter as separate calls.
const before = readEvents(events).length;
log('transcript lines before follow-up', lineCount(transcript));
const tSend = Date.now();
await client.call('pane.send_text', {
  pane_id: pane.paneId,
  text: 'now create third.txt containing 3, then stop',
});
await client.call('pane.send_keys', { pane_id: pane.paneId, keys: ['Enter'] });
await waitFor(
  'UserPromptSubmit',
  () =>
    readEvents(events)
      .slice(before)
      .some((e) => obj(e.payload).hook_event_name === 'UserPromptSubmit'),
  20_000,
);
log('follow-up submitted after', Date.now() - tSend, 'ms');
await waitFor('third.txt', () => fs.existsSync(path.join(repo, 'third.txt')), 90_000);
await waitFor(
  'second Stop',
  () =>
    readEvents(events)
      .slice(before)
      .some((e) => obj(e.payload).hook_event_name === 'Stop'),
  60_000,
);
log('third.txt =', JSON.stringify(fs.readFileSync(path.join(repo, 'third.txt'), 'utf8')));

// Q7: exit with /exit, then resume.
log('transcript lines before exit', lineCount(transcript), 'pids', pids());
await client.call('pane.send_text', { pane_id: pane.paneId, text: '/exit' });
await client.call('pane.send_keys', { pane_id: pane.paneId, keys: ['Enter'] });
await waitFor(
  'SessionEnd',
  () => readEvents(events).some((e) => obj(e.payload).hook_event_name === 'SessionEnd'),
  20_000,
);
await sleep(1500);
log('after /exit: pids', pids());
const panesAfterExit = obj(await client.call('pane.list', {}));
log(
  'panes after /exit',
  JSON.stringify(
    (panesAfterExit.panes as unknown[]).map((p) => [obj(p).pane_id, obj(p).agent_status]),
  ),
);
await client
  .call('workspace.close', { workspace_id: pane.workspaceId })
  .catch((e: unknown) => log('close err', String(e)));

const linesBeforeResume = lineCount(transcript);
const resumeArgv = [
  'claude',
  '--model',
  'haiku',
  '--resume',
  sessionId,
  '--settings',
  settings,
  '--agents',
  HELPER_AGENTS,
  'Without looking at the filesystem: what was the exact content you wrote to third.txt? Answer in one line, then create fourth.txt containing 4 and stop.',
];
const pane2 = await launchInWorkspace('bp-spike-run1-resume', repo, resumeArgv);
log('resumed in', pane2);
const evBefore = readEvents(events).length;
await waitFor('fourth.txt', () => fs.existsSync(path.join(repo, 'fourth.txt')), 120_000);
await waitFor(
  'Stop after resume',
  () =>
    readEvents(events)
      .slice(evBefore)
      .some((e) => obj(e.payload).hook_event_name === 'Stop'),
  60_000,
);
log('resumed pane text:\n' + (await readPane(pane2.paneId, 30)));
log('transcript lines: before resume', linesBeforeResume, 'after', lineCount(transcript));
log(
  'SessionStart payloads after resume',
  JSON.stringify(
    readEvents(events)
      .slice(evBefore)
      .filter((e) => obj(e.payload).hook_event_name === 'SessionStart')
      .map((e) => e.payload),
  ),
);

// Q8: close the pane (not /exit) and check the process.
log('pids before close', pids());
await client
  .call('pane.close', { pane_id: pane2.paneId })
  .catch((e: unknown) => log('pane.close err', String(e)));
await sleep(2000);
log('pids 2s after pane.close', pids());
await client
  .call('workspace.close', { workspace_id: pane2.workspaceId })
  .catch((e: unknown) => log('ws close', String(e)));
await sleep(2000);
log('pids 2s after workspace.close', pids());
for (const x of subs) x.close();
log('done; events at', events, 'herdr events at', agentLog);
