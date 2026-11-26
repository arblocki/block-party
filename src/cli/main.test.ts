import { describe, expect, it, vi } from 'vitest';
import { main, type Handlers } from './main.js';

function handlers() {
  return {
    review: vi.fn(() => Promise.resolve()),
    checks: vi.fn(() => Promise.resolve()),
    run: vi.fn(() => Promise.resolve()),
    hook: vi.fn(() => Promise.resolve()),
  } satisfies Handlers;
}

describe('main', () => {
  it('routes subcommands with the remaining args', async () => {
    const h = handlers();
    await main(['checks', 'init', '--write'], h);
    await main(['run', 'x'], h);
    await main(['hook', 'y'], h);
    expect(h.checks).toHaveBeenCalledWith(['init', '--write']);
    expect(h.run).toHaveBeenCalledWith(['x']);
    expect(h.hook).toHaveBeenCalledWith(['y']);
    expect(h.review).not.toHaveBeenCalled();
  });

  it('sends everything else to the review flow with all args', async () => {
    const h = handlers();
    await main(['octocat/hello#1', '--port', '5174'], h);
    await main([], h);
    await main(['--help'], h);
    expect(h.review).toHaveBeenNthCalledWith(1, ['octocat/hello#1', '--port', '5174']);
    expect(h.review).toHaveBeenNthCalledWith(2, []);
    expect(h.review).toHaveBeenNthCalledWith(3, ['--help']);
    expect(h.checks).not.toHaveBeenCalled();
  });
});
