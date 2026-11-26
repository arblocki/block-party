import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fakeSpawn } from '../llm/fake-spawn.testutil.js';

vi.mock('node:fs/promises', async (orig) => ({
  ...(await orig<typeof import('node:fs/promises')>()),
  appendFile: vi.fn().mockRejectedValue(new Error('ENOSPC')),
}));

describe('stream log failure', () => {
  it('rejects naming the stream file without unhandled rejections', async () => {
    const { createHeadlessClaude } = await import('./claude-headless.js');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bp-logfail-'));
    const { spawnFn } = fakeSpawn(() => ({ stdout: 'x\ny\n' }));
    const adapter = createHeadlessClaude({ spawnFn, randomUUID: () => 'u' });
    await expect(
      adapter.start({
        runId: 'r',
        cwd: dir,
        runDir: dir,
        prompt: 'p',
        model: 'm',
        agentsPath: 'a',
        settingsPath: 's',
        eventsPath: 'e',
        reportPath: path.join(dir, 'report.json'),
        permissionMode: 'acceptEdits',
        allowedTools: [],
        disallowedTools: [],
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/stream-1\.jsonl/);
  });
});
