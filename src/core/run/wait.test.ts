import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../store/index.js';
import { DecisionDismissedError, waitForAnswer } from './wait.js';

const options = [
  { id: 'a', label: 'A' },
  { id: 'b', label: 'B' },
];

let store: Store;
let id: number;

beforeEach(() => {
  vi.useFakeTimers();
  store = openStore(':memory:');
  const p = store.runs.upsertProject({
    owner: 'o',
    repo: 'r',
    localPath: '/x',
    defaultBase: 'main',
  });
  store.runs.createRun({
    id: 'r1',
    projectId: p.id,
    title: 'T',
    stage: 'awaiting_decision',
    stageNote: null,
    branch: 'b',
    worktreePath: '/wt',
    runDir: '/rd',
    baseRef: 'main',
    baseSha: 's',
    headSha: null,
    prNumber: null,
    planPath: '/p',
    planHash: 'h',
    implementer: null,
    rounds: { checkFix: 0, reviewFix: 0 },
    ownerPid: null,
    ownerHost: null,
  });
  id = store.runs.openDecision({
    runId: 'r1',
    kind: 'dispute',
    title: 'Q',
    body: 'b',
    options,
  });
});

afterEach(() => {
  vi.useRealTimers();
  store.close();
});

describe('waitForAnswer', () => {
  it('resolves when another writer answers', async () => {
    const p = waitForAnswer(store.runs, id, { intervalMs: 100 });
    const settled = vi.fn();
    p.then(settled, settled);
    await vi.advanceTimersByTimeAsync(250);
    expect(settled).not.toHaveBeenCalled();

    store.runs.answerDecision(id, { choice: 'b', note: 'because' });
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toEqual({ choice: 'b', note: 'because' });
  });

  it('resolves at once for an already answered decision', async () => {
    store.runs.answerDecision(id, { choice: 'a', note: null });
    await expect(waitForAnswer(store.runs, id, {})).resolves.toEqual({ choice: 'a', note: null });
  });

  it('polls at the default interval', async () => {
    const getDecision = vi.fn(() => store.runs.getDecision(id));
    const p = waitForAnswer({ getDecision }, id, {});
    expect(getDecision).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(getDecision).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(getDecision).toHaveBeenCalledTimes(2);
    store.runs.answerDecision(id, { choice: 'a', note: null });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toMatchObject({ choice: 'a' });
  });

  it('rejects with the signal reason when aborted, and stops polling', async () => {
    const ctrl = new AbortController();
    const getDecision = vi.fn(() => store.runs.getDecision(id));
    const p = waitForAnswer({ getDecision }, id, { signal: ctrl.signal, intervalMs: 100 });
    const caught = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(150);
    const reason = new Error('cancelled');
    ctrl.abort(reason);
    expect(await caught).toBe(reason);
    const calls = getDecision.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(getDecision).toHaveBeenCalledTimes(calls);
  });

  it('rejects at once when the signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error('nope'));
    await expect(waitForAnswer(store.runs, id, { signal: ctrl.signal })).rejects.toThrow('nope');
  });

  it('rejects with DecisionDismissedError when the decision is dismissed', async () => {
    const p = waitForAnswer(store.runs, id, { intervalMs: 100 });
    const caught = p.catch((e: unknown) => e);
    store.runs.dismissDecision(id);
    await vi.advanceTimersByTimeAsync(100);
    const err = await caught;
    expect(err).toBeInstanceOf(DecisionDismissedError);
    expect(err).toMatchObject({ decisionId: id });
  });

  it('keeps polling through a failed read', async () => {
    let fail = true;
    const getDecision = vi.fn((n: number) => {
      if (fail) throw new Error('SQLITE_BUSY');
      return store.runs.getDecision(n);
    });
    const p = waitForAnswer({ getDecision }, id, { intervalMs: 100 });
    store.runs.answerDecision(id, { choice: 'a', note: null });
    await vi.advanceTimersByTimeAsync(100);
    fail = false;
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toMatchObject({ choice: 'a' });
  });
});
