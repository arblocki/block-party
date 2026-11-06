/** Q2: headless server behaviour in an isolated session. */
import { execFileSync } from 'node:child_process';
import { HerdrClient, cleanHerdrEnv, ensureServer, sessionSocketPath } from './herdr-client.js';

const session = 'bp-spike-q2';
const c = HerdrClient.forSession(session);
const cli = (...a: string[]) => {
  try {
    return execFileSync('herdr', ['--session', session, ...a], {
      env: cleanHerdrEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return `${err.stdout ?? ''}${err.stderr ?? ''}` || String(e);
  }
};

console.log('socket path:', sessionSocketPath(session));
console.log('1) CLI with no server running ->', cli('workspace', 'list').trim());
try {
  await c.ping();
} catch (e) {
  console.log('2) raw socket ping with no server ->', (e as Error).message);
}
console.log('3) ensureServer started a server:', await ensureServer(session));
console.log('4) ping (no TUI attached) ->', JSON.stringify(await c.ping()));
console.log('5) CLI workspace list ->', cli('workspace', 'list').trim());
console.log(
  '6) session list:\n' + execFileSync('herdr', ['session', 'list'], { encoding: 'utf8' }),
);
console.log('7) server.stop via API ->', JSON.stringify(await c.call('server.stop')));
await new Promise((r) => setTimeout(r, 1000));
console.log('8) after stop, CLI ->', cli('workspace', 'list').trim());
execFileSync('herdr', ['session', 'delete', session], { stdio: 'ignore' });
