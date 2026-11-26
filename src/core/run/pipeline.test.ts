import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { continueRun, runPipeline, type PipelineDeps, type RunOutcome } from './pipeline.js';
import { ShutdownError } from './pipeline-helpers.js';
import { PublishError, publishRun, type CiWaitState, type PublishOptions } from './publish.js';
import type { Report } from './report.js';
import type { RunStage } from './machine.js';
import type { PriorFinding } from '../reviewer/prompt.js';
import { openStore } from '../store/index.js';
import type { RunStore } from '../store/runs.js';

/** Lets a test declare one otherwise-legal move illegal, to force setStage to reject it. */
const forced = vi.hoisted(() => ({ illegal: null as null | [string, string] }));
vi.mock('./machine.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./machine.js')>();
  return {
    ...real,
    assertTransition: (from: RunStage, to: RunStage) => {
      if (forced.illegal?.[0] === from && forced.illegal[1] === to) {
        throw new real.IllegalTransitionError(from, to);
      }
      real.assertTransition(from, to);
    },
  };
});
afterEach(() => {
  forced.illegal = null;
});

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

function finding(
  id: string,
  severity: Finding['severity'],
  title: string,
  repeatOf: string | null = null,
): Finding {
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
    repeatOf,
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
  abortAt?: { step: 'fetch' | 'setup' | 'checks' | 'review'; ac: AbortController };
  onReview?: (git: { head: string }) => void;
  store?: RunStore;
  onStart?: (input: ImplementerStartInput) => void;
}

function harness(o: Opts) {
  const root = mkdtempSync(join(tmpdir(), 'bp-pipeline-'));
  const planFile = join(root, 'plan.md');
  writeFileSync(planFile, PLAN);
  const echoed: string[] = [];
  const git = { head: 'a'.repeat(40), n: 0, dirty: false };
  const calls = {
    sends: [] as string[],
    sendSessions: [] as string[],
    starts: [] as string[],
    stops: 0,
    reviews: [] as {
      round: number;
      prior: number;
      priorFindings: PriorFinding[];
      headSha: string;
    }[],
    published: [] as PublishOptions[],
    checks: 0,
    setup: 0,
    worktrees: 0,
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
      o.onStart?.(input);
      for (let i = 0; i < (o.permissionPrompts ?? 0); i++) input.onPermission?.(`approve ${i + 1}`);
      if (o.hangFirstTurn) await new Promise(() => undefined);
      return { session, outcome: doTurn(input) };
    },
    async send(s, input, message) {
      calls.sends.push(message);
      calls.sendSessions.push(s.sessionId);
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
      fetchBase: async () => {
        if (o.abortAt?.step === 'fetch') o.abortAt.ac.abort();
        return { sha: git.head, source: 'origin' as const };
      },
      createWorktree: async () => {
        calls.worktrees++;
      },
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
        priorFindings: opts.priorFindings,
        headSha: opts.headSha,
      });
      o.onReview?.(git);
      if (o.abortAt?.step === 'review') {
        o.abortAt.ac.abort();
        return { ok: false, error: 'codex killed', attempts: 1 };
      }
      const r = reviews.shift() ?? review([]);
      if (r instanceof Error) throw r;
      if (r.ok) {
        // The real reviewer leaves its findings in the round directory.
        mkdirSync(opts.outDir, { recursive: true });
        writeFileSync(join(opts.outDir, 'findings.json'), JSON.stringify(r.output));
      }
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
    ...(o.store ? { store: o.store } : {}),
    paths: {
      runDir: (id) => join(root, 'runs', id),
      worktreePath: (ow, re, id) => join(root, 'wt', `${ow}__${re}`, id),
    },
  };
  const run = (signal?: AbortSignal, onStarted?: (id: string) => void): Promise<RunOutcome> =>
    runPipeline(
      {
        repo: root,
        planFile,
        baseRef: 'main',
        config: resolveRunConfig(o.section, o.flags),
        signal,
        ...(onStarted ? { onStarted } : {}),
      },
      deps,
    );
  return { run, calls, git, root, echoed, deps };
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
            summary: 'Guarded the widget',
            findingResolutions: [{ findingId: 'f_1_1', resolution: 'fixed', note: 'guarded' }],
          }),
        },
      ],
      reviews: [review([f]), review([])],
    });
    const out = await h.run();
    expect(out.stage).toBe('awaiting_review');
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
    expect(pub.body).toContain('## Summary\n\nAll done\n');
    expect(pub.body).toContain('## Fix rounds\n\n- review-fix 1: Guarded the widget\n');
    expect(pub.base).toBe('main');
    expect(pub.title).toBe('Add widgets');
    expect(h.calls.stops).toBe(1);
    expect(state(out)).toMatchObject({ stage: 'awaiting_review', prNumber: 7 });
    expect(existsSync(join(out.runDir, 'reports', 'implement-1.json'))).toBe(true);
    expect(existsSync(join(out.runDir, 'reports', 'review-fix-1.json'))).toBe(true);
    expect(readFileSync(join(out.runDir, 'inputs', 'rulings.json'), 'utf8').trim()).toBe('[]');
    expect(existsSync(join(out.runDir, 'inputs', 'findings-round-1.json'))).toBe(true);
  });

  it('runs a check-fix round after a failing check', async () => {
    const h = harness({ turns: [{}, {}], checks: [false, true] });
    const out = await h.run();
    expect(out.stage).toBe('awaiting_review');
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
    expect(out.stage).toBe('awaiting_review');
    expect(h.calls.reviews).toHaveLength(2);
    expect(h.calls.published[0]!.body).toContain('Unresolved blocking findings');
    expect(h.calls.published[0]!.body).toContain('Still lossy');
  });

  it('opens a cap_reached decision when it publishes with unresolved blocking findings', async () => {
    const store = openStore(':memory:').runs;
    const h = harness({
      store,
      turns: [
        {},
        {
          report: report({
            findingResolutions: [{ findingId: 'f_1_1', resolution: 'fixed', note: 'tried' }],
          }),
        },
      ],
      reviews: [
        review([finding('f_1_1', 'P0', 'Data loss')]),
        review([finding('f_2_1', 'P1', 'Still lossy')]),
      ],
    });
    const out = await h.run();
    expect(out.stage).toBe('awaiting_review');
    const ds = store.listDecisions({ runId: out.runId });
    expect(ds.map((d) => [d.kind, d.status])).toEqual([
      ['final_review', 'open'],
      ['cap_reached', 'open'],
    ]);
    expect(ds[1]!.title).toBe('Unresolved blocking findings');
    expect(ds[1]!.body).toContain('PR #7');
    expect(ds[1]!.body).toContain('P1 Still lossy');
  });

  it("stores each round's findings as rows with statuses from the fix report and repeatOf", async () => {
    const store = openStore(':memory:').runs;
    const h = harness({
      store,
      turns: [
        {},
        {
          report: report({
            findingResolutions: [{ findingId: 'f_1_1', resolution: 'fixed', note: 'tried' }],
          }),
        },
      ],
      reviews: [
        review([finding('f_1_1', 'P0', 'Data loss'), finding('f_1_2', 'P2', 'Minor')]),
        review([finding('f_2_1', 'P1', 'Still lossy', 'r1:f_1_1')]),
      ],
    });
    const out = await h.run();
    const rows = store.listFindings(out.runId);
    expect(rows.map((r) => [r.key, r.triage, r.status, r.resolutionNote, r.repeatOf])).toEqual([
      ['r1:f_1_1', 'auto_fix', 'fixed', 'tried', null],
      ['r1:f_1_2', 'record', 'open', null, null],
      ['r2:f_2_1', 'auto_fix', 'open', null, 'r1:f_1_1'],
    ]);
    // Round 2's reviewer saw round 1's findings by key, with their statuses.
    expect(h.calls.reviews[1]!.priorFindings.map((p) => [p.key, p.status])).toEqual([
      ['r1:f_1_1', 'fixed'],
      ['r1:f_1_2', 'open'],
    ]);
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
    expect(out.stage).toBe('awaiting_review');
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
    expect(out.stage).toBe('awaiting_review');
    expect(h.calls.sends).toHaveLength(0);
    expect(h.calls.published[0]!.body).toContain('Nit');
  });

  it('stops after review with --no-publish', async () => {
    const h = harness({ turns: [{}], flags: { publish: false } });
    const out = await h.run();
    expect(out.stage).toBe('awaiting_review');
    expect(h.calls.published).toHaveLength(0);
    expect(h.calls.stops).toBe(1);
  });

  it('treats no_ci as complete', async () => {
    const out = await harness({ turns: [{}], ci: 'no_ci' }).run();
    expect(out.stage).toBe('awaiting_review');
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

  it('records the session immediately and cancels on SIGINT during the first turn', async () => {
    const h = harness({ turns: [], hangFirstTurn: true });
    const ac = new AbortController();
    const p = h.run(ac.signal);
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    const out = await p;
    expect(out.stage).toBe('cancelled');
    expect(out.note).toBe('cancelled');
    expect(state(out).stage).toBe('cancelled');
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
    'records cancelled when aborted during %s',
    async (step) => {
      const ac = new AbortController();
      const h = harness({ turns: [{}, {}, {}], abortAt: { step, ac } });
      const out = await h.run(ac.signal);
      expect(out.stage).toBe('cancelled');
      expect(out.note).toBe('cancelled');
      expect(h.calls.published).toHaveLength(0);
    },
  );

  it('ends the run as failed, naming both stages, when setStage rejects a move', async () => {
    forced.illegal = ['reviewing', 'publishing'];
    const h = harness({ turns: [{}] });
    const out = await h.run();
    expect(out.stage).toBe('failed');
    expect(out.note).toContain('reviewing');
    expect(out.note).toContain('publishing');
    expect(state(out)).toMatchObject({ stage: 'failed', stageNote: out.note });
    expect(h.calls.published).toHaveLength(0);
  });

  it('reports the real error, not an illegal move, when saving the final stage fails', async () => {
    // A read-only run directory makes every run.json save fail from the review on.
    let runDir = '';
    const h = harness({
      turns: [{}],
      flags: { publish: false },
      onReview: () => {
        runDir = join(h.root, 'runs', readdirSync(join(h.root, 'runs'))[0]!);
        chmodSync(runDir, 0o500);
      },
    });
    try {
      await expect(h.run()).rejects.toThrow(/EACCES|permission denied/i);
    } finally {
      if (runDir) chmodSync(runDir, 0o700);
    }
  });

  it('records the PR number when cancelled during publishing', async () => {
    const ac = new AbortController();
    const h = harness({ turns: [{}], abortInPublish: ac });
    const out = await h.run(ac.signal);
    expect(out.stage).toBe('cancelled');
    expect(out.note).toBe('cancelled');
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
            updatePr: async () => {
              throw new Error('unused');
            },
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
            updatePr: async () => {
              throw new Error('unused');
            },
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
    expect(out.stage).toBe('awaiting_review');
    const waits = h.echoed.filter((l) => l.includes('implementer.waiting_for_human'));
    expect(waits).toHaveLength(2);
    expect(waits[0]).toContain('⏸ Implementer needs your approval — attach: attach-cmd');
    expect(waits[1]).toContain('approve 2');
    expect(h.calls.checks).toBe(1);
  });

  it("records the adapter's agent.* events in the run log", async () => {
    const h = harness({
      turns: [{}],
      onStart: (input) => input.onEvent?.({ type: 'agent.pane_opened', data: { label: 'x' } }),
    });
    const out = await h.run();
    const types = readFileSync(join(out.runDir, 'run-events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types).toContain('agent.pane_opened');
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

function fileEvents(out: RunOutcome) {
  return readFileSync(join(out.runDir, 'run-events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { ts: string; type: string; data?: Record<string, unknown> });
}

function stagesOf(store: RunStore, out: RunOutcome) {
  return store.listStages(out.runId).map((s) => [s.kind, s.round, s.state]);
}

/** A store whose every method throws. */
function brokenStore(): RunStore {
  return new Proxy({} as RunStore, {
    get: () => () => {
      throw new Error('database is locked');
    },
  });
}

describe('runPipeline with a store', () => {
  it('dismisses open optioned decisions when the run ends, leaving plain ones', async () => {
    const real = openStore(':memory:').runs;
    const store: RunStore = new Proxy(real, {
      get(target, prop, recv) {
        if (prop === 'startStage') {
          return (input: Parameters<RunStore['startStage']>[0]) => {
            if (target.listDecisions({ runId: input.runId }).length === 0) {
              target.openDecision({
                runId: input.runId,
                kind: 'dispute',
                title: 'Q',
                body: 'b',
                options: [{ id: 'a', label: 'A' }],
              });
              target.openDecision({ runId: input.runId, kind: 'blocked', title: 'P', body: 'b' });
            }
            return target.startStage(input);
          };
        }
        return Reflect.get(target, prop, recv) as unknown;
      },
    });
    const h = harness({ store, turns: [{}], reviews: [new Error('boom')] });
    const out = await h.run();
    expect(out.stage).toBe('failed');
    expect(store.listDecisions({ runId: out.runId }).map((d) => [d.title, d.status])).toEqual([
      ['Run failed', 'open'],
      ['P', 'open'],
      ['Q', 'dismissed'],
    ]);
  });

  it('records a full run: run row, every event, stage rows, only the final review open', async () => {
    const store = openStore(':memory:').runs;
    const f = finding('f_1_1', 'P1', 'Null deref in widget');
    const h = harness({
      store,
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
    expect(out.stage).toBe('awaiting_review');

    const json = JSON.parse(readFileSync(join(out.runDir, 'run.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    const row = store.getRun(out.runId)!;
    expect(row).toMatchObject({
      id: json.id,
      title: json.title,
      stage: json.stage,
      stageNote: json.stageNote,
      branch: json.branch,
      worktreePath: json.worktreePath,
      runDir: out.runDir,
      baseRef: json.baseRef,
      baseSha: json.baseSha,
      headSha: json.headSha,
      prNumber: json.prNumber,
      planPath: json.planPath,
      planHash: json.planHash,
      implementer: json.implementer,
      rounds: json.rounds,
      createdAt: json.createdAt,
      ownerPid: null,
      ownerHost: null,
    });
    expect(store.getProject(row.projectId)).toMatchObject({
      owner: 'o',
      repo: 'r',
      localPath: h.root,
      defaultBase: 'main',
    });

    const events = fileEvents(out);
    expect(events.some((e) => e.type === 'db.error')).toBe(false);
    expect(store.listEvents(out.runId).map((e) => [e.ts, e.type, e.payload])).toEqual(
      events.map((e) => [e.ts, e.type, e.data ?? null]),
    );

    expect(stagesOf(store, out)).toEqual([
      ['implement', 1, 'succeeded'],
      ['checks', 1, 'succeeded'],
      ['review', 1, 'succeeded'],
      ['review-fix', 1, 'succeeded'],
      ['checks', 2, 'succeeded'],
      ['review', 2, 'succeeded'],
      ['publish', 1, 'succeeded'],
      ['wait-ci', 1, 'succeeded'],
    ]);
    const stages = store.listStages(out.runId);
    expect(stages.every((s) => s.endedAt !== null)).toBe(true);
    expect(stages[0]!.input).toMatchObject({ brief: expect.stringContaining('implement-1.md') });
    expect(stages[0]!.output).toEqual({ report: join(out.runDir, 'reports', 'implement-1.json') });
    expect(stages[2]!.output).toMatchObject({ findings: 1, blocking: 1, bySeverity: { P1: 1 } });
    expect(stages[6]!.output).toEqual({ prNumber: 7, url: 'https://x/pr/7' });
    expect(stages[7]!.output).toEqual({ state: 'success' });

    // Events inside a stage carry its id.
    const reviewResults = store.listEvents(out.runId).filter((e) => e.type === 'review.result');
    expect(reviewResults.map((e) => e.stageId)).toEqual([stages[2]!.id, stages[5]!.id]);
    // Only the final review is left open.
    expect(store.listDecisions().map((d) => [d.kind, d.status])).toEqual([
      ['final_review', 'open'],
    ]);
  });

  it('opens a permission decision during the turn and resolves it when the turn ends', async () => {
    const store = openStore(':memory:').runs;
    let openAtReview = -1;
    const h = harness({
      store,
      turns: [{}],
      permissionPrompts: 1,
      onReview: () => {
        openAtReview = store.openDecisionCount();
      },
    });
    const out = await h.run();
    expect(out.stage).toBe('awaiting_review');
    expect(openAtReview).toBe(0);
    const [review, d, ...rest] = store.listDecisions({ runId: out.runId });
    expect(review!.kind).toBe('final_review');
    expect(rest).toHaveLength(0);
    expect(d).toMatchObject({
      kind: 'permission',
      status: 'resolved',
      title: 'Implementer needs approval',
      body: 'approve 1',
      attach: 'attach-cmd',
    });
    expect(d!.resolvedAt).not.toBeNull();
  });

  it('resolves a permission decision when the turn ends blocked', async () => {
    const store = openStore(':memory:').runs;
    const h = harness({ store, turns: [{ dirty: true }], permissionPrompts: 1 });
    const out = await h.run();
    expect(out.stage).toBe('blocked');
    const perms = store.listDecisions({ runId: out.runId }).filter((d) => d.kind === 'permission');
    expect(perms.map((d) => d.status)).toEqual(['resolved']);
  });

  it('opens one blocked decision with the halt note', async () => {
    const store = openStore(':memory:').runs;
    const out = await harness({ store, turns: [{ dirty: true }] }).run();
    expect(out.stage).toBe('blocked');
    expect(store.listDecisions({ runId: out.runId })).toEqual([
      expect.objectContaining({
        kind: 'blocked',
        status: 'open',
        body: out.note,
        attach: 'attach-cmd',
      }),
    ]);
    expect(stagesOf(store, out)).toEqual([['implement', 1, 'blocked']]);
    expect(store.getRun(out.runId)).toMatchObject({ stage: 'blocked', stageNote: out.note });
  });

  it('opens cap_reached when local CI still fails at the check-fix cap', async () => {
    const store = openStore(':memory:').runs;
    const h = harness({ store, turns: [{}, {}, {}], checks: [false, false, false] });
    const out = await h.run();
    expect(out.stage).toBe('blocked');
    expect(store.listDecisions({ runId: out.runId })).toEqual([
      expect.objectContaining({ kind: 'cap_reached', status: 'open', body: out.note }),
    ]);
    const stages = stagesOf(store, out);
    expect(stages[0]).toEqual(['implement', 1, 'succeeded']);
    expect(stages.filter((s) => s[0] === 'checks').map((s) => s[2])).toEqual([
      'failed',
      'failed',
      'failed',
    ]);
    expect(stages.filter((s) => s[0] === 'check-fix').map((s) => [s[1], s[2]])).toEqual([
      [1, 'succeeded'],
      [2, 'succeeded'],
    ]);
  });

  it('opens a failed decision with the error when the run fails', async () => {
    forced.illegal = ['reviewing', 'publishing'];
    const store = openStore(':memory:').runs;
    const out = await harness({ store, turns: [{}] }).run();
    expect(out.stage).toBe('failed');
    expect(store.listDecisions({ runId: out.runId })).toEqual([
      expect.objectContaining({ kind: 'failed', status: 'open', body: out.note, attach: null }),
    ]);
  });

  it('opens no decision for a cancelled run and ends the interrupted stage cancelled', async () => {
    const store = openStore(':memory:').runs;
    const ac = new AbortController();
    const h = harness({ store, turns: [{}], abortAt: { step: 'checks', ac } });
    const out = await h.run(ac.signal);
    expect(out.stage).toBe('cancelled');
    expect(store.listDecisions({ runId: out.runId })).toHaveLength(0);
    expect(stagesOf(store, out)).toEqual([
      ['implement', 1, 'succeeded'],
      ['checks', 1, 'cancelled'],
    ]);
    expect(store.getRun(out.runId)?.stage).toBe('cancelled');
  });

  it('ends interrupted with an interrupted decision when aborted with a ShutdownError', async () => {
    const store = openStore(':memory:').runs;
    const ac = new AbortController();
    const h = harness({ store, turns: [], hangFirstTurn: true });
    const started: string[] = [];
    const p = h.run(ac.signal, (id) => started.push(id));
    await new Promise((r) => setTimeout(r, 50));
    ac.abort(new ShutdownError());
    const out = await p;
    expect(started).toEqual([out.runId]);
    expect(out.stage).toBe('interrupted');
    expect(out.note).toBe('server stopped');
    expect(state(out)).toMatchObject({ stage: 'interrupted', stageNote: 'server stopped' });
    expect(store.getRun(out.runId)?.stage).toBe('interrupted');
    expect(store.listDecisions({ runId: out.runId })).toEqual([
      expect.objectContaining({
        kind: 'interrupted',
        status: 'open',
        title: 'Run interrupted',
        body: 'The run stopped while implementing: server stopped.',
        attach: 'attach-cmd',
      }),
    ]);
    expect(stagesOf(store, out)).toEqual([['implement', 1, 'cancelled']]);
    expect(store.listEvents(out.runId).map((e) => e.type)).toContain('run.interrupted');
  });

  it('creates no run when aborted while preparing (during the base fetch)', async () => {
    const store = openStore(':memory:').runs;
    const ac = new AbortController();
    const h = harness({ store, turns: [{}], abortAt: { step: 'fetch', ac } });
    const started: string[] = [];
    await expect(h.run(ac.signal, (id) => started.push(id))).rejects.toThrow('interrupted');
    expect(started).toEqual([]);
    expect(store.listRuns()).toEqual([]);
    expect(existsSync(join(h.root, 'runs'))).toBe(false);
    expect(h.calls.worktrees).toBe(0);
  });

  it('rethrows a ShutdownError when shut down while preparing', async () => {
    const ac = new AbortController();
    const h = harness({ turns: [{}] });
    ac.abort(new ShutdownError());
    await expect(h.run(ac.signal)).rejects.toBeInstanceOf(ShutdownError);
  });

  it('ends cancelled before creating the worktree when aborted as the run starts', async () => {
    const store = openStore(':memory:').runs;
    const ac = new AbortController();
    const h = harness({ store, turns: [{}] });
    const out = await h.run(ac.signal, () => ac.abort());
    expect(out.stage).toBe('cancelled');
    expect(h.calls.worktrees).toBe(0);
    expect(h.calls.starts).toHaveLength(0);
    expect(store.getRun(out.runId)?.stage).toBe('cancelled');
  });

  it('still ends cancelled, with no decision, on a plain abort', async () => {
    const store = openStore(':memory:').runs;
    const ac = new AbortController();
    const h = harness({ store, turns: [], hangFirstTurn: true });
    const p = h.run(ac.signal);
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    const out = await p;
    expect(out.stage).toBe('cancelled');
    expect(store.listDecisions({ runId: out.runId })).toHaveLength(0);
  });

  it('ends wait-ci failed and blocks when GitHub CI fails', async () => {
    const store = openStore(':memory:').runs;
    const out = await harness({ store, turns: [{}], ci: 'failure' }).run();
    expect(out.stage).toBe('blocked');
    expect(stagesOf(store, out).at(-1)).toEqual(['wait-ci', 1, 'failed']);
    expect(store.listDecisions({ runId: out.runId }).map((d) => d.kind)).toEqual(['blocked']);
  });

  it('completes exactly as without a store when every store method throws', async () => {
    const f = finding('f_1_1', 'P1', 'Bug');
    const opts = (): Opts => ({
      turns: [
        {},
        {
          report: report({
            findingResolutions: [{ findingId: 'f_1_1', resolution: 'fixed', note: 'ok' }],
          }),
        },
      ],
      reviews: [review([f]), review([])],
      permissionPrompts: 1,
    });
    const plain = await harness(opts()).run();
    const broken = await harness({ ...opts(), store: brokenStore() }).run();

    expect({ ...broken, runId: '', runDir: '' }).toEqual({ ...plain, runId: '', runDir: '' });
    const strip = (o: RunOutcome) => {
      const { id, branch, worktreePath, planPath, createdAt, updatedAt, repoPath, ...rest } =
        JSON.parse(readFileSync(join(o.runDir, 'run.json'), 'utf8')) as Record<string, unknown>;
      void [id, branch, worktreePath, planPath, createdAt, updatedAt, repoPath];
      return rest;
    };
    expect(strip(broken)).toEqual(strip(plain));

    const brokenEvents = fileEvents(broken);
    expect(brokenEvents.some((e) => e.type === 'db.error')).toBe(true);
    expect(brokenEvents.filter((e) => e.type !== 'db.error').map((e) => e.type)).toEqual(
      fileEvents(plain).map((e) => e.type),
    );
  });
});

describe('final review and continuations', () => {
  /** Answers the run's open final review through the store, as the API does before continuing. */
  const answerReview = (store: RunStore, runId: string, choice: string, note: string | null) => {
    const d = store
      .listDecisions({ runId, status: 'open' })
      .find((x) => x.kind === 'final_review')!;
    expect(store.answerDecision(d.id, { choice, note })).toBe('answered');
  };
  const finalReviews = (store: RunStore, runId: string) =>
    store.listDecisions({ runId }).filter((d) => d.kind === 'final_review');

  it('rests in awaiting_review with an open final_review, the implementer stopped, no owner', async () => {
    const store = openStore(':memory:').runs;
    const h = harness({ store, turns: [{}] });
    const out = await h.run();
    expect(out.stage).toBe('awaiting_review');
    expect(h.calls.stops).toBe(1);
    const [d, ...rest] = finalReviews(store, out.runId);
    expect(rest).toHaveLength(0);
    expect(d).toMatchObject({
      status: 'open',
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'send_back', label: 'Send back' },
      ],
    });
    expect(d!.body).toContain('https://github.com/o/r/pull/7');
    expect(store.getRun(out.runId)).toMatchObject({
      stage: 'awaiting_review',
      ownerPid: null,
      ownerHost: null,
    });
    expect(JSON.parse(readFileSync(join(out.runDir, 'run.json'), 'utf8'))).toMatchObject({
      sessionEnded: true,
      planVersion: 1,
    });
    expect(existsSync(join(out.runDir, 'inputs', 'config.json'))).toBe(true);
  });

  it('rests for review without a PR link when publishing is off', async () => {
    const store = openStore(':memory:').runs;
    const h = harness({ store, turns: [{}], flags: { publish: false } });
    const out = await h.run();
    expect(out.stage).toBe('awaiting_review');
    expect(finalReviews(store, out.runId)[0]!.body).not.toContain('github.com');
  });

  it('completes the run when approved', async () => {
    const store = openStore(':memory:').runs;
    const h = harness({ store, turns: [{}] });
    const out = await h.run();
    answerReview(store, out.runId, 'approve', null);
    const next = await continueRun(out.runId, { kind: 'approve' }, h.deps);
    expect(next.stage).toBe('complete');
    expect(store.getRun(out.runId)!.stage).toBe('complete');
    expect(state(out).stage).toBe('complete');
    expect(h.calls.sends).toHaveLength(0);
  });

  it('refuses to continue a run that is not resting', async () => {
    const h = harness({ turns: [{}], ci: 'failure' });
    const out = await h.run();
    expect(out.stage).toBe('blocked');
    await expect(continueRun(out.runId, { kind: 'approve' }, h.deps)).rejects.toThrow(
      /not waiting for review/,
    );
    await expect(continueRun(out.runId, { kind: 'feedback', text: 'x' }, h.deps)).rejects.toThrow(
      /not resting/,
    );
  });

  it('sends feedback to the same session, re-verifies, updates the PR and rests again', async () => {
    const store = openStore(':memory:').runs;
    const h = harness({
      store,
      turns: [{}, { report: report({ summary: 'Renamed x' }) }],
      reviews: [review([]), review([])],
    });
    const out = await h.run();
    const owners: (number | null | undefined)[] = [];
    const startedWith = h.deps.runChecks;
    h.deps.runChecks = (o) => {
      owners.push(store.getRun(out.runId)?.ownerPid);
      return startedWith(o);
    };
    answerReview(store, out.runId, 'send_back', 'Rename x to y');
    const next = await continueRun(out.runId, { kind: 'feedback', text: 'Rename x to y' }, h.deps);
    expect(next.stage).toBe('awaiting_review');
    expect(h.calls.sends).toHaveLength(1);
    expect(h.calls.sends[0]).toMatch(/feedback-1\.md and follow it\.$/);
    expect(h.calls.sendSessions).toEqual(['s1']);
    expect(readFileSync(join(out.runDir, 'inputs', 'feedback-1.md'), 'utf8')).toContain(
      'Rename x to y',
    );
    expect(h.calls.checks).toBe(2);
    expect(h.calls.reviews.map((r) => r.round)).toEqual([1, 2]);
    expect(h.calls.published).toHaveLength(2);
    expect(h.calls.published[1]!.body).toContain('Renamed x');
    expect(next.prNumber).toBe(7);
    expect(owners).toEqual([process.pid]);
    expect(store.getRun(out.runId)).toMatchObject({ ownerPid: null, ownerHost: null });
    expect(state(out)).toMatchObject({ stage: 'awaiting_review', rounds: { feedback: 1 } });
    expect(h.calls.stops).toBe(2);
    const reviews = finalReviews(store, out.runId);
    expect(reviews.map((d) => d.status)).toEqual(['open', 'answered']);
    expect(stagesOf(store, out).map((s) => s[0])).toContain('feedback');
    const publishRounds = store
      .listStages(out.runId)
      .filter((s) => s.kind === 'publish')
      .map((s) => s.round);
    expect(publishRounds).toEqual([1, 2]);
  });

  it('accepts feedback answered without changes and no new commit', async () => {
    const store = openStore(':memory:').runs;
    const h = harness({
      store,
      turns: [
        {},
        {
          commit: false,
          report: report({ summary: 'It is intended', feedbackOutcome: 'no_changes' }),
        },
      ],
    });
    const out = await h.run();
    answerReview(store, out.runId, 'send_back', 'Why x?');
    const next = await continueRun(out.runId, { kind: 'feedback', text: 'Why x?' }, h.deps);
    expect(next.stage).toBe('awaiting_review');
  });

  it('blocks feedback that changes nothing without saying so', async () => {
    const store = openStore(':memory:').runs;
    const h = harness({ store, turns: [{}, { commit: false }] });
    const out = await h.run();
    answerReview(store, out.runId, 'send_back', 'Fix it');
    const next = await continueRun(out.runId, { kind: 'feedback', text: 'Fix it' }, h.deps);
    expect(next.stage).toBe('blocked');
    expect(next.note).toContain('No new commits after feedback-1');
  });

  it('gives a continuation its own fix-round budget and numbers its reviews on', async () => {
    const f = finding('f_1_1', 'P1', 'Null deref');
    const store = openStore(':memory:').runs;
    const h = harness({
      store,
      turns: [
        {},
        {
          report: report({
            findingResolutions: [{ findingId: 'f_1_1', resolution: 'fixed', note: 'guarded' }],
          }),
        },
        {},
        {
          report: report({
            findingResolutions: [{ findingId: 'f_3_1', resolution: 'fixed', note: 'again' }],
          }),
        },
      ],
      reviews: [review([f]), review([]), review([finding('f_3_1', 'P1', 'New bug')]), review([])],
    });
    const out = await h.run();
    expect(out.stage).toBe('awaiting_review');
    answerReview(store, out.runId, 'send_back', 'More');
    const next = await continueRun(out.runId, { kind: 'feedback', text: 'More' }, h.deps);
    expect(next.stage).toBe('awaiting_review');
    expect(h.calls.reviews.map((r) => r.round)).toEqual([1, 2, 3, 4]);
    // The first round's resolution was rebuilt from disk, so it is not prior-unresolved.
    expect(h.calls.reviews[2]!.prior).toBe(1);
    expect(state(out).rounds).toEqual({
      checkFix: 0,
      reviewFix: 2,
      feedback: 1,
      checkRuns: 4,
    });
  });

  it('approves from run.json alone, with no config, plan or checks', async () => {
    const store = openStore(':memory:').runs;
    const h = harness({ store, turns: [{}] });
    const out = await h.run();
    rmSync(join(out.runDir, 'inputs', 'config.json'));
    h.deps.loadProjectChecks = () => {
      throw new Error('checks must not be read');
    };
    answerReview(store, out.runId, 'approve', null);
    expect((await continueRun(out.runId, { kind: 'approve' }, h.deps)).stage).toBe('complete');
    expect(store.getRun(out.runId)!.stage).toBe('complete');
  });

  it('reopens the final review when a continuation cannot load its context', async () => {
    const store = openStore(':memory:').runs;
    const h = harness({ store, turns: [{}] });
    const out = await h.run();
    rmSync(join(out.runDir, 'inputs', 'config.json'));
    answerReview(store, out.runId, 'send_back', 'More');
    await expect(
      continueRun(out.runId, { kind: 'feedback', text: 'More' }, h.deps),
    ).rejects.toThrow(/no saved config/);
    expect(store.getRun(out.runId)).toMatchObject({
      stage: 'awaiting_review',
      ownerPid: null,
    });
    const open = finalReviews(store, out.runId).filter((d) => d.status === 'open');
    expect(open).toHaveLength(1);
    expect(open[0]!.body).toContain('could not be carried out: Run ');
    expect(open[0]!.options).toHaveLength(2);
    expect(store.listEvents(out.runId).some((e) => e.type === 'continuation.failed')).toBe(true);
    expect(state(out).stage).toBe('awaiting_review');
  });

  it('reopens the final review, not an illegal move, when the first stage move fails', async () => {
    const store = openStore(':memory:').runs;
    const h = harness({ store, turns: [{}] });
    const out = await h.run();
    answerReview(store, out.runId, 'send_back', 'More');
    forced.illegal = ['awaiting_review', 'fixing'];
    const next = await continueRun(out.runId, { kind: 'feedback', text: 'More' }, h.deps);
    expect(next.stage).toBe('awaiting_review');
    expect(store.getRun(out.runId)).toMatchObject({ stage: 'awaiting_review', ownerPid: null });
    const open = finalReviews(store, out.runId).filter((d) => d.status === 'open');
    expect(open).toHaveLength(1);
    expect(open[0]!.body).toContain('Illegal run stage transition');
  });

  it('opens exactly one final review when approving fails at the stage move', async () => {
    const store = openStore(':memory:').runs;
    const h = harness({ store, turns: [{}] });
    const out = await h.run();
    answerReview(store, out.runId, 'approve', null);
    forced.illegal = ['awaiting_review', 'complete'];
    await expect(continueRun(out.runId, { kind: 'approve' }, h.deps)).rejects.toThrow(
      /Illegal run stage transition/,
    );
    const open = finalReviews(store, out.runId).filter((d) => d.status === 'open');
    expect(open).toHaveLength(1);
    expect(
      store.listEvents(out.runId).filter((e) => e.type === 'continuation.failed'),
    ).toHaveLength(1);
    expect(store.getRun(out.runId)).toMatchObject({ stage: 'awaiting_review', ownerPid: null });
  });

  it('does not open a second unresolved-findings item on a continuation', async () => {
    const store = openStore(':memory:').runs;
    const h = harness({
      store,
      section: { policy: { maxReviewFixRounds: 0 } },
      turns: [{}, {}],
      reviews: [review([finding('f_1_1', 'P1', 'Bad')]), review([finding('f_2_1', 'P1', 'Bad')])],
    });
    const out = await h.run();
    answerReview(store, out.runId, 'send_back', 'More');
    await continueRun(out.runId, { kind: 'feedback', text: 'More' }, h.deps);
    const caps = store
      .listDecisions({ runId: out.runId, status: 'open' })
      .filter((d) => d.kind === 'cap_reached');
    expect(caps).toHaveLength(1);
  });

  describe('with a fake GitHub client', () => {
    function github(state: 'open' | 'closed' | 'merged') {
      const calls: string[] = [];
      let body = '';
      const client = {
        findOpenPrForBranch: async () => undefined,
        createPr: async (_r: unknown, i: { body: string }) => {
          calls.push('create');
          body = i.body;
          return { number: 7, headSha: head(), url: 'https://x/pr/7', draft: true };
        },
        updatePr: async (_r: unknown, n: number, i: { title: string; body: string }) => {
          calls.push(`update:${n}`);
          body = i.body;
          return { number: n, headSha: head(), url: 'https://x/pr/7', draft: true };
        },
        getPr: async (_r: unknown, n: number) => {
          calls.push(`get:${n}`);
          return { number: n, headSha: head(), url: 'https://x/pr/7', draft: true, state };
        },
      };
      let head = () => '';
      return { client, calls, body: () => body, setHead: (f: () => string) => (head = f) };
    }

    it('updates the same PR title and body when a continuation publishes again', async () => {
      const store = openStore(':memory:').runs;
      const gh = github('open');
      const h = harness({
        store,
        turns: [{}, { report: report({ summary: 'Renamed x' }) }],
        publishWith: async (p) => {
          const head = await p.git.headSha(p.worktree);
          gh.setHead(() => head);
          return publishRun({ ...p, github: gh.client });
        },
      });
      const out = await h.run();
      expect(gh.calls).toEqual(['create']);
      answerReview(store, out.runId, 'send_back', 'Rename x');
      const next = await continueRun(out.runId, { kind: 'feedback', text: 'Rename x' }, h.deps);
      expect(next).toMatchObject({ stage: 'awaiting_review', prNumber: 7 });
      expect(gh.calls).toEqual(['create', 'get:7', 'update:7']);
      expect(gh.body()).toContain('Renamed x');
      expect(h.calls.published[1]!.prNumber).toBe(7);
    });

    it('blocks instead of opening a second PR when the PR was closed', async () => {
      const store = openStore(':memory:').runs;
      const gh = github('closed');
      const h = harness({
        store,
        turns: [{}, {}],
        publishWith: async (p) => {
          const head = await p.git.headSha(p.worktree);
          gh.setHead(() => head);
          return publishRun({ ...p, github: gh.client });
        },
      });
      const out = await h.run();
      answerReview(store, out.runId, 'send_back', 'More');
      const next = await continueRun(out.runId, { kind: 'feedback', text: 'More' }, h.deps);
      expect(next.stage).toBe('blocked');
      expect(next.note).toContain('PR #7 is closed');
      expect(gh.calls).toEqual(['create', 'get:7']);
    });
  });
});
