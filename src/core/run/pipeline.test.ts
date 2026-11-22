import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  ImplementerAdapter,
  ImplementerSession,
  ImplementerStartInput,
  TurnOutcome,
} from '../agents/types.js';
import type { ChecksRunResult } from '../checks/run.js';
import type { GitHubClient } from '../github/types.js';
import type { Finding } from '../reviewer/findings.js';
import type { ReviewResult } from '../reviewer/codex-reviewer.js';
import { resolveRunConfig, type RunFlagOverrides } from './config.js';
import { RunLog } from './events.js';
import { runPipeline, type PipelineDeps, type RunOutcome } from './pipeline.js';
import { PublishError, publishRun, type CiWaitState, type PublishOptions } from './publish.js';
import type { Report } from './report.js';

const PLAN = `# Add widgets

## Goal
Widgets.

## Approach
Do it.

## Acceptance criteria
- [ ] Widgets render

## Out of scope
Gadgets.
`;

function report(over: Partial<Report> = {}): Report {
  return {
    status: 'done',
    summary: 'All done',
    acceptance: [{ criterion: 'Widgets render', status: 'met', evidence: 'test' }],
    questions: [],
    findingResolutions: [],
    ...over,
  };
}

function finding(id: string, severity: Finding['severity'], title: string): Finding {
  return {
    id,
    reviewedSha: 'x'.repeat(7),
    severity,
    category: 'correctness',
    title,
    body: 'It is broken',
    location: { path: 'a.ts', startLine: 1, endLine: 2 },
    confidence: 'high',
    suggestedFix: null,
  };
}

function review(findings: Finding[]): ReviewResult {
  return {
    ok: true,
    output: { reviewedSha: 'x'.repeat(7), summary: 'Looks ok', findings },
    usage: undefined,
    attempts: 1,
    durationMs: 1,
  };
}

/** What the fake agent does on one turn. */
interface Turn {
  outcome?: TurnOutcome;
  report?: Report | 'invalid';
  commit?: boolean;
  dirty?: boolean;
}

interface Opts {
  turns: Turn[];
  checks?: boolean[]; // pass/fail per runChecks call; default always pass
  reviews?: (ReviewResult | Error)[];
  ci?: CiWaitState;
  flags?: RunFlagOverrides;
  section?: unknown;
  noChecksConfig?: boolean;
  hangFirstTurn?: boolean;
  permissionPrompts?: number;
  abortInPublish?: AbortController;
  /** Replaces the fake publishRun (e.g. to run the real one against fakes). */
  publishWith?: PipelineDeps['publishRun'];
  /** Abort the signal (and fail the call) when this step runs. */
  abortAt?: { step: 'setup' | 'checks' | 'review'; ac: AbortController };
  onReview?: (git: { head: string }) => void;
}

function harness(o: Opts) {
  const root = mkdtempSync(join(tmpdir(), 'bp-pipeline-'));
  const planFile = join(root, 'plan.md');
  writeFileSync(planFile, PLAN);
  const echoed: string[] = [];
  const git = { head: 'a'.repeat(40), n: 0, dirty: false };
  const calls = {
    sends: [] as string[],
    starts: [] as string[],
    stops: 0,
    reviews: [] as { round: number; prior: number; headSha: string }[],
    published: [] as PublishOptions[],
    checks: 0,
    setup: 0,
  };
  let turnIdx = 0;
  const doTurn = (input: ImplementerStartInput): TurnOutcome => {
    const t = o.turns[turnIdx++] ?? {};
    if (t.commit !== false) git.head = String(++git.n).padStart(40, 'c');
    git.dirty = t.dirty ?? false;
    if (t.report === 'invalid') writeFileSync(input.reportPath, '{nope');
    else if (t.report !== undefined || !t.outcome) {
      writeFileSync(input.reportPath, JSON.stringify(t.report ?? report()));
    }
    return t.outcome ?? { kind: 'report' };
  };
  const session: ImplementerSession = { mode: 'headless', sessionId: 's1', cwd: root };
  const adapter: ImplementerAdapter = {
    async start(input) {
      calls.starts.push(input.prompt);
      input.onSession?.(session);
      for (let i = 0; i < (o.permissionPrompts ?? 0); i++) input.onPermission?.(`approve ${i + 1}`);
      if (o.hangFirstTurn) await new Promise(() => undefined);
      return { session, outcome: doTurn(input) };
    },
    async send(_s, input, message) {
      calls.sends.push(message);
      return doTurn(input);
    },
    async stop() {
      calls.stops++;
    },
    describe: () => 'attach-cmd',
  };
  const reviews = [...(o.reviews ?? [review([])])];
  const checkPlan = [...(o.checks ?? [])];
  const deps: PipelineDeps = {
    git: {
      repoRoot: async () => root,
      originRepo: async () => ({ owner: 'o', repo: 'r' }),
      fetchBase: async () => ({ sha: git.head, source: 'origin' as const }),
      createWorktree: async () => undefined,
      headSha: async () => git.head,
      isClean: async () => !git.dirty,
      commitsBetween: async (_c, base, head) =>
        base === head ? [] : [{ sha: head, subject: 'c' }],
      pushBranch: async () => undefined,
      remoteBranchSha: async () => git.head,
    },
    runShell: async () => {
      calls.setup++;
      if (o.abortAt?.step === 'setup') {
        o.abortAt.ac.abort();
        return { code: null, signal: 'SIGTERM', durationMs: 1, timedOut: false };
      }
      return { code: 0, signal: null, durationMs: 1, timedOut: false };
    },
    runChecks: async (opts): Promise<ChecksRunResult> => {
      calls.checks++;
      let passed = checkPlan.length ? checkPlan.shift()! : true;
      if (o.abortAt?.step === 'checks') {
        o.abortAt.ac.abort();
        passed = false;
      }
      const logPath = join(root, `check-${calls.checks}.log`);
      writeFileSync(logPath, 'line one\nboom\n');
      return {
        headSha: opts.headSha,
        passed,
        results: [
          {
            name: 'test',
            command: 'pnpm test',
            cwd: root,
            exitCode: passed ? 0 : 1,
            durationMs: 1,
            timedOut: false,
            logPath,
          },
        ],
      };
    },
    loadProjectChecks: () =>
      ({
        config: o.noChecksConfig
          ? undefined
          : { setup: 'pnpm install', required: [{ name: 'test', run: 'pnpm test' }] },
        proposal: {},
        drift: undefined,
        parityMeasurable: false,
        errors: [],
      }) as never,
    adapter,
    reviewWithCodex: async (opts) => {
      calls.reviews.push({
        round: opts.round,
        prior: opts.priorFindings.length,
        headSha: opts.headSha,
      });
      o.onReview?.(git);
      if (o.abortAt?.step === 'review') {
        o.abortAt.ac.abort();
        return { ok: false, error: 'codex killed', attempts: 1 };
      }
      const r = reviews.shift() ?? review([]);
      if (r instanceof Error) throw r;
      return r;
    },
    publishRun: async (p) => {
      calls.published.push(p);
      if (o.publishWith) return o.publishWith(p);
      if (o.abortInPublish) {
        o.abortInPublish.abort();
        throw new PublishError('interrupted', 'Publishing interrupted', {
          pushed: true,
          prNumber: 9,
        });
      }
      return { prNumber: 7, url: 'https://x/pr/7', headSha: git.head, created: true };
    },
    waitForCi: async () => ({ state: o.ci ?? 'success', checks: [] }),
    github: async () => ({}) as GitHubClient,
    createLog: (dir) => new RunLog(dir, { echo: (l) => echoed.push(l) }),
    hookArgv: ['node', 'hook'],
    paths: {
      runDir: (id) => join(root, 'runs', id),
      worktreePath: (ow, re, id) => join(root, 'wt', `${ow}__${re}`, id),
    },
  };
  const run = (signal?: AbortSignal): Promise<RunOutcome> =>
    runPipeline(
      {
        repo: root,
        planFile,
        baseRef: 'main',
        config: resolveRunConfig(o.section, o.flags),
        signal,
      },
      deps,
    );
  return { run, calls, git, root, echoed };
}

function state(out: RunOutcome) {
  return JSON.parse(readFileSync(join(out.runDir, 'run.json'), 'utf8')) as {
    stage: string;
    stageNote: string;
    rounds: { checkFix: number; reviewFix: number };
    prNumber: number | null;
  };
}

describe('runPipeline', () => {
  it('fixes a P1 in one round, re-reviews clean, and publishes with the resolution', async () => {
    const f = finding('f_1_1', 'P1', 'Null deref in widget');
    const h = harness({
      turns: [
        {},
        {
          report: report({
            findingResolutions: [{ findingId: 'f_1_1', resolution: 'fixed', note: 'guarded' }],
          }),
        },
      ],
      reviews: [review([f]), review([])],
    });
    const out = await h.run();
    expect(out.stage).toBe('complete');
    expect(out.prNumber).toBe(7);
    expect(h.calls.reviews.map((r) => [r.round, r.prior])).toEqual([
      [1, 0],
      [2, 1],
    ]);
    expect(h.calls.sends[0]).toMatch(/^Read the fix brief at .*review-fix-1\.md and follow it\.$/);
    expect(h.calls.starts[0]).toMatch(/^Read the task brief at .*implement-1\.md and follow it\.$/);
    const pub = h.calls.published[0]!;
    expect(pub.body).toContain('Null deref in widget');
    expect(pub.body).toContain('| fixed |');
    expect(pub.body).not.toContain('Unresolved blocking');
    expect(pub.base).toBe('main');
    expect(pub.title).toBe('Add widgets');
    expect(h.calls.stops).toBe(1);
    expect(state(out)).toMatchObject({ stage: 'complete', prNumber: 7 });
    expect(existsSync(join(out.runDir, 'reports', 'implement-1.json'))).toBe(true);
    expect(existsSync(join(out.runDir, 'reports', 'review-fix-1.json'))).toBe(true);
    expect(readFileSync(join(out.runDir, 'inputs', 'rulings.json'), 'utf8').trim()).toBe('[]');
    expect(existsSync(join(out.runDir, 'inputs', 'findings-round-1.json'))).toBe(true);
  });

  it('runs a check-fix round after a failing check', async () => {
    const h = harness({ turns: [{}, {}], checks: [false, true] });
    const out = await h.run();
    expect(out.stage).toBe('complete');
    expect(state(out).rounds.checkFix).toBe(1);
    const failures = readFileSync(join(out.runDir, 'inputs', 'check-failures-1.md'), 'utf8');
    expect(failures).toContain('pnpm test');
    expect(failures).toContain('boom');
    expect(h.calls.sends[0]).toContain('check-fix-1.md');
  });

  it('blocks when checks still fail at the cap', async () => {
    const h = harness({
      turns: [{}, {}, {}],
      checks: [false, false, false],
    });
    const out = await h.run();
    expect(out.stage).toBe('blocked');
    expect(out.note).toContain('Local CI still failing');
    expect(h.calls.stops).toBe(0);
    expect(h.calls.published).toHaveLength(0);
  });

  it('blocks with the questions when the implementer reports blocked', async () => {
    const h = harness({
      turns: [{ report: report({ status: 'blocked', questions: ['Which API?'] }) }],
    });
    const out = await h.run();
    expect(out.stage).toBe('blocked');
    expect(out.note).toContain('Which API?');
    expect(h.calls.stops).toBe(0);
  });

  it('blocks on uncommitted changes', async () => {
    const h = harness({ turns: [{ dirty: true }] });
    const out = await h.run();
    expect(out.stage).toBe('blocked');
    expect(out.note).toContain('uncommitted');
    expect(out.note).toContain('attach-cmd');
  });

  it('blocks when there are no new commits', async () => {
    const h = harness({ turns: [{ commit: false }] });
    const out = await h.run();
    expect(out.stage).toBe('blocked');
    expect(out.note).toContain('No new commits');
  });

  it.each([
    [{ outcome: { kind: 'timeout' } }, 'timed out'],
    [{ outcome: { kind: 'permission', message: 'rm?' } }, 'permission'],
    [{ outcome: { kind: 'no_report' } }, 'without a report'],
    [{ outcome: { kind: 'exited', reason: 'crash' } }, 'exited'],
    [{ report: 'invalid' }, 'Invalid report'],
    [{ report: report({ status: 'partial' }) }, 'partial'],
  ] as [Turn, string][])('blocks on a bad first turn: %#', async (turn, text) => {
    const out = await harness({ turns: [turn] }).run();
    expect(out.stage).toBe('blocked');
    expect(out.note).toContain(text);
  });

  it('blocks when the reviewer fails', async () => {
    const h = harness({
      turns: [{}],
      reviews: [{ ok: false, error: 'codex down', attempts: 1 }],
    });
    const out = await h.run();
    expect(out.stage).toBe('blocked');
    expect(out.note).toContain('codex down');
    expect(h.calls.published).toHaveLength(0);
  });

  it('publishes with an unresolved section when findings remain after the cap', async () => {
    const f1 = finding('f_1_1', 'P0', 'Data loss');
    const f2 = finding('f_2_1', 'P1', 'Still lossy');
    const h = harness({
      turns: [
        {},
        {
          report: report({
            findingResolutions: [{ findingId: 'f_1_1', resolution: 'fixed', note: 'tried' }],
          }),
        },
      ],
      reviews: [review([f1]), review([f2])],
    });
    const out = await h.run();
    expect(out.stage).toBe('complete');
    expect(h.calls.reviews).toHaveLength(2);
    expect(h.calls.published[0]!.body).toContain('Unresolved blocking findings');
    expect(h.calls.published[0]!.body).toContain('Still lossy');
  });

  it('accepts a fix round with only disputed findings and no new commit', async () => {
    const f = finding('f_1_1', 'P1', 'Maybe wrong');
    const h = harness({
      turns: [
        {},
        {
          commit: false,
          report: report({
            findingResolutions: [{ findingId: 'f_1_1', resolution: 'disputed', note: 'nope' }],
          }),
        },
      ],
      reviews: [review([f]), review([f])],
    });
    const out = await h.run();
    expect(out.stage).toBe('complete');
    expect(h.calls.published[0]!.body).toContain('disputed');
  });

  it('blocks when the fix report omits a blocking finding', async () => {
    const f = finding('f_1_1', 'P1', 'Bug');
    const h = harness({ turns: [{}, {}], reviews: [review([f])] });
    const out = await h.run();
    expect(out.stage).toBe('blocked');
    expect(out.note).toContain('f_1_1');
  });

  it('does not auto-fix findings below the autoFix severities', async () => {
    const h = harness({
      turns: [{}],
      reviews: [review([finding('f_1_1', 'P2', 'Nit')])],
    });
    const out = await h.run();
    expect(out.stage).toBe('complete');
    expect(h.calls.sends).toHaveLength(0);
    expect(h.calls.published[0]!.body).toContain('Nit');
  });

  it('stops after review with --no-publish', async () => {
    const h = harness({ turns: [{}], flags: { publish: false } });
    const out = await h.run();
    expect(out.stage).toBe('complete');
    expect(h.calls.published).toHaveLength(0);
    expect(h.calls.stops).toBe(1);
  });

  it('treats no_ci as complete', async () => {
    const out = await harness({ turns: [{}], ci: 'no_ci' }).run();
    expect(out.stage).toBe('complete');
    expect(out.note).toContain('no_ci');
  });

  it('blocks on GitHub CI failure and timeout', async () => {
    const failed = await harness({ turns: [{}], ci: 'failure' }).run();
    expect(failed.stage).toBe('blocked');
    expect(failed.note).toContain('parity gap');
    const timeout = await harness({ turns: [{}], ci: 'timeout' }).run();
    expect(timeout.stage).toBe('blocked');
  });

  it('refuses to start without a checks config', async () => {
    await expect(harness({ turns: [], noChecksConfig: true }).run()).rejects.toThrow(/checks init/);
  });

  it('blocks publishing when HEAD moved after the review', async () => {
    const h = harness({
      turns: [{}],
      onReview: (g) => {
        g.head = 'f'.repeat(40);
      },
    });
    const out = await h.run();
    expect(out.stage).toBe('blocked');
    expect(out.note).toContain('not the commit that passed');
    expect(h.calls.published).toHaveLength(0);
  });

  it('writes report.schema.json and references it from the brief', async () => {
    const h = harness({ turns: [{}] });
    const out = await h.run();
    const schemaPath = join(out.runDir, 'report.schema.json');
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
      properties: Record<string, unknown>;
      description: string;
    };
    expect(Object.keys(schema.properties)).toContain('findingResolutions');
    expect(schema.description).toContain('questions');
    const brief = readFileSync(join(out.runDir, 'briefs', 'implement-1.md'), 'utf8');
    expect(brief).toContain(schemaPath);
  });

  it('records the session immediately and blocks on SIGINT during the first turn', async () => {
    const h = harness({ turns: [], hangFirstTurn: true });
    const ac = new AbortController();
    const p = h.run(ac.signal);
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    const out = await p;
    expect(out.stage).toBe('blocked');
    expect(out.note).toBe('interrupted');
    const st = JSON.parse(readFileSync(join(out.runDir, 'run.json'), 'utf8')) as {
      implementer: { sessionId: string } | null;
    };
    expect(st.implementer?.sessionId).toBe('s1');
    expect(h.calls.stops).toBe(0);
    expect(readFileSync(join(out.runDir, 'run-events.jsonl'), 'utf8')).toContain(
      'implementer.session',
    );
  });

  it.each(['setup', 'checks', 'review'] as const)(
    'records blocked/interrupted when aborted during %s',
    async (step) => {
      const ac = new AbortController();
      const h = harness({ turns: [{}, {}, {}], abortAt: { step, ac } });
      const out = await h.run(ac.signal);
      expect(out.stage).toBe('blocked');
      expect(out.note).toBe('interrupted');
      expect(h.calls.published).toHaveLength(0);
    },
  );

  it('records the PR number when interrupted during publishing', async () => {
    const ac = new AbortController();
    const h = harness({ turns: [{}], abortInPublish: ac });
    const out = await h.run(ac.signal);
    expect(out.stage).toBe('blocked');
    expect(out.note).toBe('interrupted');
    expect(state(out).prNumber).toBe(9);
    expect(h.calls.published[0]!.signal).toBe(ac.signal);
    expect(readFileSync(join(out.runDir, 'run-events.jsonl'), 'utf8')).toContain('publish.stopped');
  });

  it('records the PR number when getPr fails with a plain error after the PR was created', async () => {
    const h = harness({
      turns: [{}],
      publishWith: (p) =>
        publishRun({
          ...p,
          sleep: async () => undefined,
          github: {
            findOpenPrForBranch: async () => undefined,
            createPr: async () => ({
              number: 11,
              headSha: 'stale',
              url: 'https://x/pr/11',
              draft: true,
            }),
            getPr: async () => {
              throw new Error('ECONNRESET');
            },
          },
        }),
    });
    const out = await h.run();
    expect(out.stage).toBe('blocked');
    expect(state(out)).toMatchObject({ stage: 'blocked', prNumber: 11 });
    expect(state(out).stageNote).toContain('ECONNRESET');
    const events = readFileSync(join(out.runDir, 'run-events.jsonl'), 'utf8');
    expect(events).toContain('publish.stopped');
    expect(events).toContain('unexpected');
  });

  it('records the PR number when the PR head never matches the pushed SHA', async () => {
    let t = 0;
    const h = harness({
      turns: [{}],
      publishWith: (p) =>
        publishRun({
          ...p,
          now: () => t,
          sleep: async (ms) => {
            t += ms;
          },
          github: {
            findOpenPrForBranch: async () => undefined,
            createPr: async () => ({
              number: 12,
              headSha: 'stale',
              url: 'https://x/pr/12',
              draft: true,
            }),
            getPr: async () => ({
              number: 12,
              headSha: 'stale',
              url: 'https://x/pr/12',
              draft: true,
            }),
          },
        }),
    });
    const out = await h.run();
    expect(out.stage).toBe('blocked');
    expect(state(out)).toMatchObject({ stage: 'blocked', prNumber: 12 });
    expect(state(out).stageNote).toContain('head_mismatch');
    const events = readFileSync(join(out.runDir, 'run-events.jsonl'), 'utf8');
    expect(events).toMatch(/publish\.stopped.*"pushed":true/);
  });

  it('logs each permission wait prominently and continues once the turn ends', async () => {
    const h = harness({ turns: [{}], permissionPrompts: 2 });
    const out = await h.run();
    expect(out.stage).toBe('complete');
    const waits = h.echoed.filter((l) => l.includes('implementer.waiting_for_human'));
    expect(waits).toHaveLength(2);
    expect(waits[0]).toContain('⏸ Implementer needs your approval — attach: attach-cmd');
    expect(waits[1]).toContain('approve 2');
    expect(h.calls.checks).toBe(1);
  });

  it('tells the implementer which shell commands need no approval', async () => {
    const out = await harness({ turns: [{}] }).run();
    const brief = readFileSync(join(out.runDir, 'briefs', 'implement-1.md'), 'utf8');
    expect(brief).toContain('Edit files with the Edit/Write tools, not shell scripts');
    expect(brief).toContain('`git status`');
    expect(brief).toContain('`pnpm test`');
    expect(brief).toContain('`node`');
    expect(brief).toContain('Anything else stops the run until a human approves it.');
    expect(brief).toContain(`The run directory ${out.runDir} is readable and writable for you.`);
  });
});
