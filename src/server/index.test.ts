import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GitHubClient } from '../core/github/types.js';
import { loadRunConfig } from '../core/run/config.js';
import type { RunInput } from '../core/run/pipeline.js';
import { openStore, type Store } from '../core/store/index.js';
import { startServer, type RunningServer } from './index.js';
import { createRunManager } from './run-manager.js';

let store: Store | undefined;
let server: RunningServer | undefined;

afterEach(async () => {
  await server?.close();
  store?.close();
  server = store = undefined;
});

describe('startServer and the queue', () => {
  it('starts runs that were queued before a restart, after reconciliation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bp-index-'));
    store = openStore(join(root, 'db.sqlite'));
    const projectId = store.runs.upsertProject({
      owner: 'o',
      repo: 'r',
      localPath: root,
      defaultBase: 'main',
    }).id;
    const queue = (id: string) =>
      store!.runs.createQueuedRun(
        {
          id,
          projectId,
          title: id,
          stageNote: null,
          branch: '',
          worktreePath: '',
          runDir: join(root, id),
          baseRef: 'main',
          baseSha: '',
          headSha: null,
          prNumber: null,
          planPath: '',
          planHash: '',
          implementer: null,
          rounds: { checkFix: 0, reviewFix: 0, ciFix: 0, feedback: 0, checkRuns: 0 },
        },
        { repo: root, baseRef: 'main', description: id, config: loadRunConfig(root) },
      );
    queue('r20260101-a00001');
    queue('r20260101-a00002');

    const started: RunInput[] = [];
    const manager = createRunManager({
      runs: store.runs,
      limits: { maxRuns: 1, maxRunsPerProject: 1 },
      onError: () => undefined,
      startPipeline: (input) => {
        started.push(input);
        store!.runs.updateRun(input.runId!, { stage: 'setup' });
        input.onStarted?.(input.runId!);
        return new Promise(() => undefined);
      },
    });
    // Nothing starts just because the manager exists.
    expect(started).toHaveLength(0);

    server = await startServer({
      github: {} as GitHubClient,
      store,
      runManager: manager,
    });

    // Only one slot: the oldest queued run started, the other kept its place.
    expect(started.map((i) => i.runId)).toEqual(['r20260101-a00001']);
    expect(started[0]!.description).toBe('r20260101-a00001');
    expect(store.runs.listQueued().map((q) => q.runId)).toEqual(['r20260101-a00002']);
    await manager.shutdown(10);
  });
});
