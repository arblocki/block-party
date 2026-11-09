import { describe, expect, it } from 'vitest';
import type { CiStatus, PublishedPr } from '../github/types.js';
import type { Finding } from '../reviewer/findings.js';
import {
  PublishError,
  publishRun,
  renderPrBody,
  waitForCi,
  type PublishOptions,
  type ReviewRoundInput,
} from './publish.js';
import type { Plan } from './plan.js';
import type { Report } from './report.js';

const repo = { owner: 'o', repo: 'r' };
const SHA = 'a'.repeat(40);

function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe('publishRun', () => {
  function setup(opts: {
    remote?: string | undefined;
    existing?: PublishedPr;
    prHeads?: string[];
  }) {
    const clock = fakeClock();
    const log: string[] = [];
    const heads = [...(opts.prHeads ?? [SHA])];
    const mk = (headSha: string): PublishedPr => ({
      number: 5,
      headSha,
      url: 'https://pr/5',
      draft: true,
    });
    const base: PublishOptions = {
      git: {
        async headSha() {
          return SHA;
        },
        async pushBranch() {
          log.push('push');
        },
        async remoteBranchSha() {
          return 'remote' in opts ? opts.remote : SHA;
        },
      },
      github: {
        async findOpenPrForBranch() {
          log.push('find');
          return opts.existing;
        },
        async createPr(_r, input) {
          log.push(`create:${input.draft}`);
          return mk(heads.shift() ?? SHA);
        },
        async getPr() {
          log.push('get');
          return mk(heads.shift() ?? heads[0] ?? 'stale');
        },
      },
      repo,
      worktree: '/wt',
      branch: 'bp/x',
      base: 'main',
      title: 'T',
      body: 'B',
      ...clock,
    };
    return { base, log, clock };
  }

  it('pushes, creates a draft PR and confirms the head', async () => {
    const { base, log } = setup({});
    expect(await publishRun(base)).toEqual({
      prNumber: 5,
      url: 'https://pr/5',
      headSha: SHA,
      created: true,
    });
    expect(log).toEqual(['push', 'find', 'create:true']);
  });

  it('is idempotent: reuses an existing PR', async () => {
    const { base, log } = setup({
      existing: { number: 5, headSha: SHA, url: 'https://pr/5', draft: true },
    });
    const r = await publishRun(base);
    expect(r.created).toBe(false);
    expect(log).toEqual(['push', 'find']);
  });

  it('polls getPr until GitHub shows the new head', async () => {
    const { base, log } = setup({
      existing: { number: 5, headSha: 'old', url: 'https://pr/5', draft: true },
      prHeads: ['old', SHA],
    });
    expect((await publishRun(base)).headSha).toBe(SHA);
    expect(log.filter((l) => l === 'get')).toHaveLength(2);
  });

  it('fails with head_mismatch when the PR head never updates', async () => {
    const { base, clock } = setup({
      existing: { number: 5, headSha: 'old', url: 'https://pr/5', draft: true },
      prHeads: ['old'],
    });
    await expect(publishRun(base)).rejects.toMatchObject({ code: 'head_mismatch' });
    expect(clock.now()).toBeGreaterThanOrEqual(30_000);
  });

  it('fails with remote_mismatch before touching GitHub', async () => {
    const { base, log } = setup({ remote: 'b'.repeat(40) });
    await expect(publishRun(base)).rejects.toMatchObject({ code: 'remote_mismatch' });
    expect(log).toEqual(['push']);
    const none = setup({ remote: undefined });
    await expect(publishRun(none.base)).rejects.toBeInstanceOf(PublishError);
  });

  it('wraps push failures', async () => {
    const { base } = setup({});
    base.git = {
      ...base.git,
      async pushBranch() {
        throw new Error('rejected');
      },
    };
    await expect(publishRun(base)).rejects.toMatchObject({ code: 'push_failed' });
  });
});

describe('waitForCi', () => {
  function script(states: CiStatus['state'][]) {
    let i = 0;
    return {
      async getCiStatus(): Promise<CiStatus> {
        const state = states[Math.min(i++, states.length - 1)]!;
        return {
          state,
          checks: state === 'none' ? [] : [{ name: 'ci', status: 's', conclusion: null, url: '' }],
        };
      },
      polls: () => i,
    };
  }
  const run = (github: ReturnType<typeof script>, extra: object = {}) =>
    waitForCi({ github, repo, sha: SHA, ...fakeClock(), ...extra });

  it('rejects promptly when aborted while sleeping between polls', async () => {
    const gh = script(['pending']);
    const ac = new AbortController();
    const started = Date.now();
    const p = waitForCi({ github: gh, repo, sha: SHA, intervalMs: 60_000, signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toBeTruthy();
    expect(Date.now() - started).toBeLessThan(2000);
    const polls = gh.polls();
    await new Promise((r) => setTimeout(r, 50));
    expect(gh.polls()).toBe(polls);
  });

  it('succeeds after pending', async () => {
    const gh = script(['pending', 'pending', 'success']);
    expect((await run(gh)).state).toBe('success');
    expect(gh.polls()).toBe(3);
  });

  it('reports failure', async () => {
    expect((await run(script(['pending', 'failure']))).state).toBe('failure');
  });

  it('resolves no_ci when nothing appears within the grace period', async () => {
    const gh = script(['none']);
    expect((await run(gh)).state).toBe('no_ci');
    expect(gh.polls()).toBe(4); // t=0,20,40,60
  });

  it('does not resolve no_ci once a check has appeared', async () => {
    const gh = script(['pending', 'none']);
    expect((await run(gh, { timeoutMs: 120_000 })).state).toBe('timeout');
  });

  it('times out while pending', async () => {
    const gh = script(['pending']);
    expect((await run(gh, { timeoutMs: 100_000 })).state).toBe('timeout');
  });
});

describe('renderPrBody', () => {
  const plan: Plan = {
    title: 'Plan',
    sections: {},
    acceptanceCriteria: ['It works', 'Docs updated'],
    contentHash: 'h',
  };
  const report: Report = {
    status: 'done',
    summary: 'Did the thing, thanks @alice',
    acceptance: [{ criterion: 'It works', status: 'met', evidence: 'ran it\nwith @bob' }],
    questions: [],
    findingResolutions: [],
  };
  const checks = {
    headSha: SHA,
    passed: false,
    results: [
      {
        name: 'test',
        command: 'x',
        cwd: '/',
        exitCode: 0,
        durationMs: 1,
        timedOut: false,
        logPath: 'l',
      },
      {
        name: 'lint',
        command: 'x',
        cwd: '/',
        exitCode: 1,
        durationMs: 1,
        timedOut: false,
        logPath: 'l',
      },
    ],
  };
  const finding = (
    id: string,
    severity: Finding['severity'],
    extra: Partial<Finding> = {},
  ): Finding => ({
    id,
    reviewedSha: SHA,
    severity,
    category: 'correctness',
    title: `title ${id}`,
    body: `body ${id}`,
    location: { path: 'src/a.ts', startLine: 3, endLine: 5 },
    confidence: 'high',
    suggestedFix: null,
    ...extra,
  });
  const body = (reviewRounds: ReviewRoundInput[]) =>
    renderPrBody({ plan, report, checks, reviewRounds, runId: 'run-1' });

  it('renders summary, criteria, CI and neutralises mentions', () => {
    const md = body([]);
    expect(md).toContain('## Summary\n\nDid the thing, thanks @​alice');
    expect(md).toContain('- met: It works - ran it with @​bob');
    expect(md).toContain('- not reported: Docs updated');
    expect(md).toContain('## Local CI (on `aaaaaaa`)');
    expect(md).toContain('| test | passed |');
    expect(md).toContain('| lint | failed (exit 1) |');
    expect(md).not.toMatch(/@(?!\u200b)\w/);
    expect(md.trimEnd().endsWith('Run: run-1')).toBe(true);
    expect(md).not.toContain('Unresolved');
  });

  it('says Codex found nothing for an empty round, with no unresolved section', () => {
    const md = body([{ round: 1, reviewedSha: SHA, summary: '', findings: [], resolutions: {} }]);
    expect(md).toContain('Codex found nothing on `aaaaaaa`.');
    expect(md).not.toContain('clean');
    expect(md).not.toContain('Unresolved');
  });

  it('lists findings with resolution and escapes table cells', () => {
    const md = body([
      {
        round: 1,
        reviewedSha: SHA,
        summary: 'sum',
        findings: [finding('f1', 'P2', { title: 'a | b\nping @carol' })],
        resolutions: { f1: { resolution: 'fixed' } },
      },
    ]);
    expect(md).toContain('| P2 | a \\| b ping @​carol | src/a.ts:3-5 | fixed |');
  });

  it('flags last-round P0/P1 and earlier non-fixed P0/P1 as unresolved', () => {
    const md = body([
      {
        round: 1,
        reviewedSha: SHA,
        summary: '',
        findings: [
          finding('f1', 'P0'),
          finding('f2', 'P1'),
          finding('f3', 'P1'),
          finding('f4', 'P3'),
        ],
        resolutions: {
          f1: { resolution: 'fixed' },
          f2: { resolution: 'disputed' },
          f3: { resolution: 'deferred' },
        },
      },
      {
        round: 2,
        reviewedSha: SHA,
        summary: '',
        findings: [finding('f5', 'P1', { body: 'hi @dave' }), finding('f6', 'P2')],
        resolutions: {},
      },
    ]);
    const section = md.slice(md.indexOf('## ⚠ Unresolved blocking findings'));
    expect(section).toContain('title f2');
    expect(section).toContain('title f3');
    expect(section).toContain('title f5');
    expect(section).toContain('hi @​dave');
    expect(section).not.toContain('title f1');
    expect(section).not.toContain('title f4');
    expect(section).not.toContain('title f6');
    expect(section.indexOf('Run: run-1')).toBeGreaterThan(section.indexOf('title f5'));
  });

  it('treats earlier fixed blockers as resolved when the last round is empty', () => {
    const md = body([
      {
        round: 1,
        reviewedSha: SHA,
        summary: '',
        findings: [finding('f1', 'P0')],
        resolutions: { f1: { resolution: 'fixed' } },
      },
      { round: 2, reviewedSha: SHA, summary: '', findings: [], resolutions: {} },
    ]);
    expect(md).not.toContain('Unresolved');
  });
});
