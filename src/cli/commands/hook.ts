import { appendHookEvent, readCapped } from '../../core/agents/hook.js';
import { runsRoot } from '../../core/run/paths.js';

/** `block-party hook <eventsPath>`: called by Claude Code hooks. Always exits 0. */
export async function hookMain(argv: string[]): Promise<void> {
  try {
    const eventsPath = argv[0];
    if (!eventsPath) {
      console.error('block-party hook: missing events path');
      return;
    }
    const stdin = await readCapped(process.stdin);
    const msg = appendHookEvent({ eventsPath, runsRoot: runsRoot(), stdin });
    if (msg) console.error(msg);
  } catch (err) {
    console.error(`block-party hook: ${(err as Error).message}`);
  }
}
