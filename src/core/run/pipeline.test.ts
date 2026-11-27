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
import type { DiffFile } from '../git/index.js';
import type { CiCheck, GitHubClient } from '../github/types.js';
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
import type { DecisionKind, RunStore } from '../store/runs.js';

/** Lets a test declare one otherwise-legal move illegal, to force setStage to reject it. */
const forced = vi.hoisted(() => ({ illegal: null as null | [string, string] }));
vi.mock('./machine.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./machine.js')>();
  return {
    ...real,
    assertTransition: (from: RunStage, to: RunStage, opts?: { resume?: boolean }) => {
      if (forced.illegal?.[0] === from && forced.illegal[1] === to) {
        throw new real.IllegalTransitionError(from, to);
      }
      real.assertTransition(from, to, opts);
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
  /** Planner turns: the plan text to write (default PLAN); null writes nothing. */
  plan?: string | null;
  /** Planner turns: move HEAD, as a commit would. */
  moveHead?: boolean;
}

interface Opts {
  turns: Turn[];
  checks?: boolean[]; // pass/fail per runChecks call; default always pass
  reviews?: (ReviewResult | Error)[];
  ci?: CiWaitState;
  /** One result per wait-for-CI call (the last repeats); overrides `ci`. */
  ciSeq?: { state: CiWaitState; checks?: CiCheck[] }[];
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
  /** Files each fix turn changed, for the broad-fix check; default: one small file. */
  diffFiles?: DiffFile[];
  onStart?: (input: ImplementerStartInput) => void;
  /** Start from a description instead of a plan file. */
  description?: string;
  /** The agent sessions are panes (the label is `bp-pane`). */
  pane?: boolean;
  /** Never answer these calls (until the run is aborted, which stops waiting for them). */
  hang?: ('checks' | 'review' | 'ci')[];
  /** What a resume's `reattach` finds: an agent still working in its pane, or nothing. */
  reattach?: 'working' | 'none';
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
    startInputs: [] as ImplementerStartInput[],
    sendInputs: [] as ImplementerStartInput[],
    stops: 0,
    stoppedSessions: [] as string[],
    stopOpts: [] as unknown[],
    reattaches: [] as string[],
    reviews: [] as {
      round: number;
      prior: number;
      priorFindings: PriorFinding[];
      headSha: string;
      planPath: string;
    }[],
    published: [] as PublishOptions[],
    ciWaits: [] as string[],
    checks: 0,
    setup: 0,
    worktrees: 0,
  };
  let turnIdx = 0;
  const doTurn = (input: ImplementerStartInput): TurnOutcome => {
    const t = o.turns[turnIdx++] ?? {};
    const planner = input.permissionMode === 'default';
    if (planner && t.plan !== null) {
      // The plan path is the one file (besides the report) a planner may write.
      const rule = input.allowedTools.find((x) => /^Write\(\/\/.*plans\/v\d+\.md\)$/.test(x));
      const path = '/' + rule!.slice('Write(/'.length, -1);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, t.plan ?? PLAN);
    }
    if (planner && t.moveHead) git.head = 'f'.repeat(40);
    if (t.commit !== false && !planner) git.head = String(++git.n).padEnd(40, 'c');
    git.dirty = t.dirty ?? false;
    if (t.report === 'invalid') writeFileSync(input.reportPath, '{nope');
    else if (t.report !== undefined || !t.outcome) {
      writeFileSync(input.reportPath, JSON.stringify(t.report ?? report()));
    }
    return t.outcome ?? { kind: 'report' };
  };
  const session: ImplementerSession = {
    mode: o.pane ? 'pane' : 'headless',
    sessionId: 's1',
    cwd: root,
    ...(o.pane ? { paneLabel: 'bp-pane' } : {}),
  };
  const plannerSession: ImplementerSession = { ...session, sessionId: 'planner-1' };
  const adapter: ImplementerAdapter = {
    async start(input) {
      calls.starts.push(input.prompt);
      calls.startInputs.push(input);
      const mine = input.permissionMode === 'default' ? plannerSession : session;
      input.onSession?.(mine);
      o.onStart?.(input);
      for (let i = 0; i < (o.permissionPrompts ?? 0); i++) input.onPermission?.(`approve ${i + 1}`);
      if (o.hangFirstTurn) await new Promise(() => undefined);
      return { session: mine, outcome: doTurn(input) };
    },
    async send(s, input, message) {
      calls.sends.push(message);
      calls.sendSessions.push(s.sessionId);
      calls.sendInputs.push(input);
      return doTurn(input);
    },
    async stop(s, stopOpts) {
      calls.stops++;
      calls.stoppedSessions.push(s.sessionId);
      calls.stopOpts.push(stopOpts);
    },
    ...(o.reattach !== undefined
      ? {
          async reattach(s: ImplementerSession, input: ImplementerStartInput) {
            calls.reattaches.push(s.sessionId);
            return o.reattach === 'working' ? doTurn(input) : null;
          },
        }
      : {}),
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
      statusLines: async () => (git.dirty ? [' M a.ts'] : []),
      commitsBetween: async (_c, base, head) =>
        base === head ? [] : [{ sha: head, subject: 'c' }],
      diffFiles: async () => ({
        files: o.diffFiles ?? [{ path: 'a.ts', added: 3, deleted: 1, status: 'M' }],
      }),
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
      if (o.hang?.includes('checks')) await new Promise(() => undefined);
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
        planPath: opts.planPath,
      });
      o.onReview?.(git);
      if (o.hang?.includes('review')) await new Promise(() => undefined);
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
    waitForCi: async (w) => {
      calls.ciWaits.push(w.sha);
      if (o.hang?.includes('ci')) await new Promise(() => undefined);
      if (o.ciSeq) {
        const r = o.ciSeq[Math.min(calls.ciWaits.length - 1, o.ciSeq.length - 1)]!;
        return { state: r.state, checks: r.checks ?? [] };
      }
      return { state: o.ci ?? 'success', checks: [] };
    },
    github: async () =>
      ({
        getPr: async (_r: unknown, n: number) => ({
          number: n,
          headSha: git.head,
          url: `https://x/pr/${n}`,
          draft: false,
          state: 'open',
        }),
      }) as unknown as GitHubClient,
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
        ...(o.description !== undefined ? { description: o.description } : { planFile }),
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

/**
 * A store that answers each optioned decision of a kind as it is opened, from a script of
 * choices (the run then never waits).
 */
function scripted(script: Partial<Record<DecisionKind, string[]>>) {
  const real = openStore(':memory:').runs;
  const asked: { kind: string; title: string; body: string; choice: string }[] = [];
  const store: RunStore = new Proxy(real, {
    get(target, prop, recv) {
      if (prop === 'openDecision') {
        return (input: Parameters<RunStore['openDecision']>[0]) => {
          const id = target.openDecision(input);
          const choice = input.options ? script[input.kind]?.shift() : undefined;
          if (choice !== undefined) {
            target.answerDecision(id, { choice, note: null });
            asked.push({ kind: input.kind, title: input.title, body: input.body, choice });
          }
          return id;
        };
      }
      return Reflect.get(target, prop, recv) as unknown;
    },
  });
  return { store, asked };
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
        review([finding('f_1_1', 'P0', 'Data loss'), finding('f_1_2', 'P3', 'Minor')]),
        review([finding('f_2_1', 'P1', 'Still lossy', 'r1:f_9')]),
      ],
    });
    const out = await h.run();
    const rows = store.listFindings(out.runId);
    expect(rows.map((r) => [r.key, r.triage, r.status, r.resolutionNote, r.repeatOf])).toEqual([
      ['r1:f_1_1', 'auto_fix', 'fixed', 'tried', null],
      ['r1:f_1_2', 'record', 'open', null, null],
      ['r2:f_2_1', 'auto_fix', 'open', null, 'r1:f_9'],
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
      store: scripted({ dispute: ['accept_dispute'] }).store,
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
    expect(h.calls.published[0]!.body).toContain('wont_fix');
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
      reviews: [review([finding('f_1_1', 'P3', 'Nit')])],
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
    expect(failed.note).toContain('still failing');
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
    // A cancel closes the agent for good (no polite exit).
    expect(h.calls.stoppedSessions).toEqual(['s1']);
    expect(h.calls.stopOpts[0]).toMatchObject({ force: true, runDir: out.runDir });
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

const fixed = (...ids: string[]) =>
  report({
    findingResolutions: ids.map((id) => ({ findingId: id, resolution: 'fixed', note: 'ok' })),
  });

const readJson = (out: RunOutcome, rel: string): unknown =>
  JSON.parse(readFileSync(join(out.runDir, rel), 'utf8'));

describe('triage, disputes and stop conditions', () => {
  const two = [finding('f_1_1', 'P1', 'Null deref'), finding('f_1_2', 'P2', 'Missing test')];

  it('fixes the P1 automatically and asks about the P2; fix adds it to the fix round', async () => {
    const { store, asked } = scripted({ finding_triage: ['fix'] });
    const h = harness({
      store,
      turns: [{}, { report: fixed('f_1_1', 'f_1_2') }],
      reviews: [review(two), review([])],
    });
    const out = await h.run();
    expect(out.stage).toBe('awaiting_review');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ kind: 'finding_triage', choice: 'fix' });
    expect(asked[0]!.title).toContain('Missing test');
    expect(asked[0]!.body).toContain('P2 Missing test');
    expect(asked[0]!.body).toContain('a.ts:1-2');
    const sent = readJson(out, 'inputs/findings-round-1.json') as { id: string }[];
    expect(sent.map((f) => f.id)).toEqual(['f_1_1', 'f_1_2']);
    expect(store.listFindings(out.runId).map((r) => [r.key, r.triage, r.status])).toEqual([
      ['r1:f_1_1', 'auto_fix', 'fixed'],
      ['r1:f_1_2', 'ask', 'fixed'],
    ]);
    expect(readJson(out, 'inputs/rulings.json')).toEqual([
      { key: 'r1:f_1_2', ruling: 'fix', note: '' },
    ]);
    const events = store.listEvents(out.runId);
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['triage.asked', 'triage.answered', 'decision.answered']),
    );
    const waiting = events.find(
      (e) => e.type === 'stage' && /awaiting_decision/.test(JSON.stringify(e.payload)),
    );
    expect(waiting?.payload).toMatchObject({ note: '1 P2 finding to triage' });
  });

  it('skip marks the finding skipped and runs no fix turn for it', async () => {
    const { store } = scripted({ finding_triage: ['skip'] });
    const h = harness({
      store,
      turns: [{}],
      reviews: [review([two[1]!])],
    });
    const out = await h.run();
    expect(out.stage).toBe('awaiting_review');
    expect(h.calls.sends).toHaveLength(0);
    expect(store.listFindings(out.runId)[0]).toMatchObject({ status: 'skipped' });
    expect(readJson(out, 'inputs/rulings.json')).toEqual([
      { key: 'r1:f_1_2', ruling: 'skip', note: '' },
    ]);
  });

  it('with a skipped P2 and a P1, only the P1 is fixed', async () => {
    const { store } = scripted({ finding_triage: ['defer'] });
    const h = harness({
      store,
      turns: [{}, { report: fixed('f_1_1') }],
      reviews: [review(two), review([])],
    });
    const out = await h.run();
    const sent = readJson(out, 'inputs/findings-round-1.json') as { id: string }[];
    expect(sent.map((f) => f.id)).toEqual(['f_1_1']);
    expect(store.listFindings(out.runId).map((r) => r.status)).toEqual(['fixed', 'deferred']);
  });

  it('does not ask again about a finding that raises one already ruled on', async () => {
    const { store, asked } = scripted({ finding_triage: ['skip'] });
    const h = harness({
      store,
      turns: [{}, { report: fixed('f_1_1') }],
      reviews: [review(two), review([finding('f_2_1', 'P2', 'Missing test', 'r1:f_1_2')])],
    });
    const out = await h.run();
    expect(out.stage).toBe('awaiting_review');
    expect(asked).toHaveLength(1);
    expect(store.listFindings(out.runId).map((r) => [r.key, r.status])).toEqual([
      ['r1:f_1_1', 'fixed'],
      ['r1:f_1_2', 'skipped'],
      ['r2:f_2_1', 'skipped'],
    ]);
    // Round 2's reviewer was shown the ruling next to the finding.
    expect(h.calls.reviews[1]!.priorFindings.find((p) => p.key === 'r1:f_1_2')).toMatchObject({
      status: 'skipped',
      ruling: 'skip',
    });
  });

  it('halts blocked when a P2 needs asking and there is no database', async () => {
    const h = harness({ turns: [{}], reviews: [review([two[1]!])] });
    const out = await h.run();
    expect(out.stage).toBe('blocked');
    expect(out.note).toContain('database is unavailable');
  });

  it('halts blocked when the question is dismissed', async () => {
    const real = openStore(':memory:').runs;
    const store: RunStore = new Proxy(real, {
      get(target, prop, recv) {
        if (prop === 'openDecision') {
          return (input: Parameters<RunStore['openDecision']>[0]) => {
            const id = target.openDecision(input);
            if (input.kind === 'finding_triage') target.dismissDecision(id);
            return id;
          };
        }
        return Reflect.get(target, prop, recv) as unknown;
      },
    });
    const out = await harness({ store, turns: [{}], reviews: [review([two[1]!])] }).run();
    expect(out.stage).toBe('blocked');
    expect(out.note).toContain('dismissed');
  });

  const disputeTurn = (id = 'f_1_1'): Turn => ({
    commit: false,
    report: report({
      findingResolutions: [{ findingId: id, resolution: 'disputed', note: 'Works as is' }],
    }),
  });

  it('a disputed finding opens a dispute decision; accept_dispute sets wont_fix', async () => {
    const { store, asked } = scripted({ dispute: ['accept_dispute'] });
    const h = harness({
      store,
      turns: [{}, disputeTurn()],
      reviews: [review([two[0]!]), review([])],
    });
    const out = await h.run();
    expect(out.stage).toBe('awaiting_review');
    expect(asked[0]).toMatchObject({ kind: 'dispute', choice: 'accept_dispute' });
    expect(asked[0]!.body).toContain('Works as is');
    const [row] = store.listFindings(out.runId);
    expect(row).toMatchObject({ status: 'wont_fix' });
    expect(row!.resolutionNote).toContain('Works as is');
    expect(readJson(out, 'inputs/rulings.json')).toEqual([
      { key: 'r1:f_1_1', ruling: 'accept_dispute', note: '' },
    ]);
    // The accepted dispute is not an unresolved blocking finding.
    expect(h.calls.published[0]!.body).not.toContain('Unresolved blocking');
    expect(h.calls.reviews[1]!.priorFindings[0]).toMatchObject({
      status: 'wont_fix',
      ruling: 'accept_dispute',
    });
    const types = store.listEvents(out.runId).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['dispute.opened', 'dispute.answered']));
  });

  it('uphold sends the finding back with the ruling in rulings.json', async () => {
    const { store } = scripted({ dispute: ['uphold'] });
    const h = harness({
      store,
      turns: [{}, disputeTurn(), { report: fixed('r1:f_1_1') }],
      reviews: [review([two[0]!]), review([]), review([])],
    });
    const out = await h.run();
    expect(out.stage).toBe('awaiting_review');
    expect(h.calls.sends).toHaveLength(2);
    expect(readJson(out, 'inputs/rulings.json')).toEqual([
      { key: 'r1:f_1_1', ruling: 'uphold', note: '', spent: true },
    ]);
    // Round 2 sent it again, by key, because ids restart every round.
    const again = readJson(out, 'inputs/findings-round-2.json') as { id: string }[];
    expect(again.map((f) => f.id)).toEqual(['r1:f_1_1']);
    expect(store.listFindings(out.runId)[0]).toMatchObject({ status: 'fixed' });
    expect(h.calls.reviews[1]!.priorFindings[0]).toMatchObject({ ruling: 'uphold' });
  });

  it('blocks when a finding raises a fixed one again, naming both keys', async () => {
    const store = openStore(':memory:').runs;
    const h = harness({
      store,
      turns: [{}, { report: fixed('f_1_1') }],
      reviews: [review([two[0]!]), review([finding('f_2_1', 'P1', 'Still', 'r1:f_1_1')])],
    });
    const out = await h.run();
    expect(out.stage).toBe('blocked');
    expect(out.note).toContain('r2:f_2_1');
    expect(out.note).toContain('r1:f_1_1');
    expect(store.listDecisions({ runId: out.runId }).map((d) => d.kind)).toContain('blocked');
  });

  const big: DiffFile[] = [{ path: 'a.ts', added: 250, deleted: 0, status: 'M' }];

  it('opens broad_fix for a fix over the line budget; stop blocks the run', async () => {
    const { store, asked } = scripted({ broad_fix: ['stop'] });
    const h = harness({
      store,
      diffFiles: big,
      turns: [{}, { report: fixed('f_1_1') }],
      reviews: [review([two[0]!]), review([])],
    });
    const out = await h.run();
    expect(asked[0]).toMatchObject({ kind: 'broad_fix', choice: 'stop' });
    expect(asked[0]!.body).toContain('250 lines');
    expect(asked[0]!.body).toContain('a.ts');
    expect(out.stage).toBe('blocked');
    expect(store.listEvents(out.runId).map((e) => e.type)).toContain('fix.broad');
  });

  it('accepting a broad fix carries on', async () => {
    const { store } = scripted({ broad_fix: ['accept'] });
    const out = await harness({
      store,
      diffFiles: big,
      turns: [{}, { report: fixed('f_1_1') }],
      reviews: [review([two[0]!]), review([])],
    }).run();
    expect(out.stage).toBe('awaiting_review');
  });

  it('a fix that deletes a file is a broad fix', async () => {
    const { store, asked } = scripted({ broad_fix: ['stop'] });
    await harness({
      store,
      diffFiles: [{ path: 'a.ts', added: 0, deleted: 1, status: 'D' }],
      turns: [{}, { report: fixed('f_1_1') }],
      reviews: [review([two[0]!])],
    }).run();
    expect(asked[0]!.body).toContain('deleted or renamed 1 file');
  });

  it('a normal fix does not ask', async () => {
    const { store, asked } = scripted({ broad_fix: ['stop'] });
    const out = await harness({
      store,
      turns: [{}, { report: fixed('f_1_1') }],
      reviews: [review([two[0]!]), review([])],
    }).run();
    expect(out.stage).toBe('awaiting_review');
    expect(asked).toHaveLength(0);
  });
  it('an upheld dispute is disputed again: no second question, escalated, then a continuation leaves it alone', async () => {
    const { store, asked } = scripted({ dispute: ['uphold'] });
    const h = harness({
      store,
      turns: [{}, disputeTurn(), disputeTurn('r1:f_1_1'), {}],
      reviews: [review([two[0]!]), review([]), review([]), review([])],
    });
    const out = await h.run();
    expect(out.stage).toBe('awaiting_review');
    expect(asked.filter((a) => a.kind === 'dispute')).toHaveLength(1);
    expect(h.calls.sends).toHaveLength(2);
    const stuck = store
      .listDecisions({ runId: out.runId })
      .find((d) => d.title === 'Upheld findings still unresolved');
    expect(stuck).toMatchObject({ kind: 'cap_reached' });
    expect(stuck!.body).toContain('r1:f_1_1');
    expect(store.listFindings(out.runId)[0]).toMatchObject({ status: 'disputed' });
    // A continuation rebuilds the rulings from disk: the spent upheld finding gets no third turn.
    const review1 = store
      .listDecisions({ runId: out.runId, status: 'open' })
      .find((d) => d.kind === 'final_review')!;
    store.answerDecision(review1.id, { choice: 'send_back', note: 'x' });
    const next = await continueRun(out.runId, { kind: 'feedback', text: 'x' }, h.deps);
    expect(next.stage).toBe('awaiting_review');
    expect(h.calls.sends).toHaveLength(3);
    expect(h.calls.reviews.at(-1)!.priorFindings[0]).toMatchObject({ ruling: 'uphold' });
  });

  it('uphold of a P2 still gets its fix turn at the default cap', async () => {
    const { store } = scripted({ finding_triage: ['fix'], dispute: ['uphold'] });
    const h = harness({
      store,
      turns: [{}, disputeTurn('f_1_2'), { report: fixed('r1:f_1_2') }],
      reviews: [review([two[1]!]), review([]), review([])],
    });
    const out = await h.run();
    expect(out.stage).toBe('awaiting_review');
    expect(store.listFindings(out.runId)[0]).toMatchObject({ status: 'fixed' });
  });

  it('folds a finding that raises an upheld one again into it', async () => {
    const { store } = scripted({ dispute: ['uphold'] });
    const h = harness({
      store,
      section: { policy: { maxReviewFixRounds: 2 } },
      turns: [{}, disputeTurn(), { report: fixed('r1:f_1_1') }],
      reviews: [
        review([two[0]!]),
        review([finding('f_2_1', 'P1', 'Null deref', 'r1:f_1_1')]),
        review([]),
      ],
    });
    const out = await h.run();
    const sent = readJson(out, 'inputs/findings-round-2.json') as { id: string }[];
    expect(sent.map((f) => f.id)).toEqual(['r1:f_1_1']);
    expect(store.listFindings(out.runId).map((r) => [r.key, r.status])).toEqual([
      ['r1:f_1_1', 'fixed'],
      ['r2:f_2_1', 'fixed'],
    ]);
  });

  it('a P0 that points at a skipped P2 is still fixed', async () => {
    const { store, asked } = scripted({ finding_triage: ['skip'] });
    const h = harness({
      store,
      section: { policy: { maxReviewFixRounds: 2 } },
      turns: [{}, { report: fixed('f_1_1') }, { report: fixed('f_2_1') }],
      reviews: [
        review(two),
        review([finding('f_2_1', 'P0', 'Worse than it looked', 'r1:f_1_2')]),
        review([]),
      ],
    });
    const out = await h.run();
    expect(out.stage).toBe('awaiting_review');
    expect(asked).toHaveLength(1);
    expect(store.listFindings(out.runId).map((r) => [r.key, r.status])).toEqual([
      ['r1:f_1_1', 'fixed'],
      ['r1:f_1_2', 'skipped'],
      ['r2:f_2_1', 'fixed'],
    ]);
  });

  it('a P3 that repeats a fixed finding is recorded, not a halt', async () => {
    const store = openStore(':memory:').runs;
    const h = harness({
      store,
      turns: [{}, { report: fixed('f_1_1') }],
      reviews: [review([two[0]!]), review([finding('f_2_1', 'P3', 'Nit again', 'r1:f_1_1')])],
    });
    const out = await h.run();
    expect(out.stage).toBe('awaiting_review');
    expect(store.listEvents(out.runId).map((e) => e.type)).toContain('repeat.recorded');
  });

  it('says which P2s were not asked about once the cap is reached', async () => {
    const store = openStore(':memory:').runs;
    const h = harness({
      store,
      turns: [{}, { report: fixed('f_1_1') }],
      reviews: [review([two[0]!]), review([finding('f_2_1', 'P2', 'Late nit')])],
    });
    const out = await h.run();
    expect(out.stage).toBe('awaiting_review');
    const ev = store.listEvents(out.runId).find((e) => e.type === 'triage.not_asked');
    expect(ev?.payload).toMatchObject({ findings: ['r2:f_2_1'] });
    const d = store
      .listDecisions({ runId: out.runId })
      .find((x) => x.title === 'Findings not triaged');
    expect(d).toMatchObject({ kind: 'cap_reached' });
    expect(d!.body).toContain('r2:f_2_1');
  });

  it('counts files outside the findings paths, ignoring a leading ./', async () => {
    const { store, asked } = scripted({ broad_fix: ['accept'] });
    await harness({
      store,
      section: { policy: { broadFixFiles: 1 } },
      diffFiles: [
        { path: './a.ts', added: 1, deleted: 0, status: 'M' },
        { path: 'b.ts', added: 1, deleted: 0, status: 'M' },
        { path: 'c.ts', added: 1, deleted: 0, status: 'M' },
      ],
      turns: [{}, { report: fixed('f_1_1') }],
      reviews: [review([two[0]!]), review([])],
    }).run();
    expect(asked[0]!.body).toContain('touched 2 files outside');
  });

  it("still reports round 3's untriaged P2s while round 2's item is open", async () => {
    const { store } = scripted({ dispute: ['uphold'] });
    const h = harness({
      store,
      // Rounds 2 and 3 both end at the cap: the upheld finding's extra turn sits between them.
      turns: [{}, disputeTurn(), { report: fixed('r1:f_1_1') }],
      reviews: [
        review([two[0]!]),
        review([finding('f_2_1', 'P2', 'Late nit')]),
        review([finding('f_3_1', 'P2', 'Later nit')]),
      ],
    });
    const out = await h.run();
    const items = store
      .listDecisions({ runId: out.runId })
      .filter((d) => d.title === 'Findings not triaged');
    expect(items).toHaveLength(2);
    const r3 = items.find((d) => d.body.includes('r3:f_3_1'));
    expect(r3).toBeDefined();
    expect(r3!.body).not.toContain('r2:f_2_1');
    expect(items.some((d) => d.body.includes('r2:f_2_1'))).toBe(true);
  });

  it('at the cap, a repeat of an upheld finding gets the upheld finding’s outcome', async () => {
    const { store } = scripted({ dispute: ['uphold'] });
    const h = harness({
      store,
      turns: [{}, disputeTurn(), { report: fixed('r1:f_1_1') }],
      reviews: [
        review([two[0]!]),
        review([finding('f_2_1', 'P1', 'Null deref', 'r1:f_1_1')]),
        review([]),
      ],
    });
    const out = await h.run();
    const sent = readJson(out, 'inputs/findings-round-2.json') as { id: string }[];
    expect(sent.map((f) => f.id)).toEqual(['r1:f_1_1']);
    expect(store.listFindings(out.runId).map((r) => [r.key, r.status])).toEqual([
      ['r1:f_1_1', 'fixed'],
      ['r2:f_2_1', 'fixed'],
    ]);
  });

  it('a halted upheld turn is not marked spent', async () => {
    const { store } = scripted({ dispute: ['uphold'] });
    const h = harness({
      store,
      // The extra turn commits nothing and reports nothing fixed: judged invalid.
      turns: [{}, disputeTurn(), { report: 'invalid' }],
      reviews: [review([two[0]!]), review([])],
    });
    const out = await h.run();
    expect(out.stage).toBe('blocked');
    expect(readJson(out, 'inputs/rulings.json')).toEqual([
      { key: 'r1:f_1_1', ruling: 'uphold', note: '' },
    ]);
  });

  it('cancels a run aborted while it waits for an answer, dismissing the question', async () => {
    const ac = new AbortController();
    const real = openStore(':memory:').runs;
    const store: RunStore = new Proxy(real, {
      get(target, prop, recv) {
        if (prop === 'openDecision') {
          return (input: Parameters<RunStore['openDecision']>[0]) => {
            const id = target.openDecision(input);
            if (input.kind === 'finding_triage') ac.abort();
            return id;
          };
        }
        return Reflect.get(target, prop, recv) as unknown;
      },
    });
    const out = await harness({ store, turns: [{}], reviews: [review([two[1]!])] }).run(ac.signal);
    expect(out.stage).toBe('cancelled');
    const [d] = store
      .listDecisions({ runId: out.runId })
      .filter((x) => x.kind === 'finding_triage');
    expect(d!.status).toBe('dismissed');
  });
});

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

  it('ends wait-ci failed and blocks when GitHub CI fails and the owner stops', async () => {
    const { store } = scripted({ ci_gap: ['stop'] });
    const out = await harness({ store, turns: [{}, {}], ci: 'failure' }).run();
    expect(out.stage).toBe('blocked');
    expect(stagesOf(store, out).at(-1)).toEqual(['wait-ci', 1, 'failed']);
    expect(
      store
        .listDecisions({ runId: out.runId })
        .map((d) => d.kind)
        .sort(),
    ).toEqual(['blocked', 'ci_gap', 'ci_gap', 'ci_gap']);
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

describe('CI parity gap', () => {
  const GH_FAIL: CiCheck[] = [
    { name: 'build-linux', status: 'completed', conclusion: 'failure', url: 'https://gh/9' },
    { name: 'lint', status: 'completed', conclusion: 'success', url: 'https://gh/8' },
  ];
  const fail = { state: 'failure' as const, checks: GH_FAIL };
  const ok = { state: 'success' as const };
  const kinds = (store: RunStore, out: RunOutcome) =>
    stagesOf(store, out).map((s) => s[0] as string);

  it('runs one ci-fix turn with the failing check names, re-verifies, pushes and rests', async () => {
    const store = openStore(':memory:').runs;
    const h = harness({
      store,
      turns: [{}, { report: report({ summary: 'Fixed CI' }) }],
      ciSeq: [fail, ok],
      reviews: [review([]), review([])],
    });
    const out = await h.run();
    expect(out.stage).toBe('awaiting_review');
    expect(h.calls.sends).toHaveLength(1);
    expect(h.calls.sends[0]).toContain('ci-fix-1.md');
    const input = readFileSync(join(out.runDir, 'inputs', 'ci-failures-1.md'), 'utf8');
    expect(input).toContain('build-linux');
    expect(input).toContain('https://gh/9');
    expect(h.calls.checks).toBe(2);
    expect(h.calls.reviews).toHaveLength(2);
    expect(h.calls.published).toHaveLength(2);
    expect(h.calls.published[1]!.prNumber).toBe(7);
    expect(h.calls.ciWaits).toHaveLength(2);
    expect(h.calls.ciWaits[0]).not.toBe(h.calls.ciWaits[1]);
    expect(kinds(store, out)).toEqual([
      'implement',
      'checks',
      'review',
      'publish',
      'wait-ci',
      'ci-fix',
      'checks',
      'review',
      'publish',
      'wait-ci',
    ]);
    const open = store.listDecisions({ runId: out.runId, status: 'open' });
    expect(open.map((d) => d.kind).sort()).toEqual(['ci_gap', 'final_review']);
    expect(open.find((d) => d.kind === 'ci_gap')!.options).toBeNull();
    expect(JSON.parse(readFileSync(join(out.runDir, 'run.json'), 'utf8')).rounds.ciFix).toBe(1);
  });

  it('keeps outside check names on one line in the ci_gap item and the ci.failed event', async () => {
    const store = openStore(':memory:').runs;
    const nasty: CiCheck[] = [
      { name: 'b`uild\n## Injected', status: 'completed', conclusion: 'failure', url: 'u' },
    ];
    const h = harness({
      store,
      turns: [{}, {}],
      ciSeq: [{ state: 'failure', checks: nasty }, ok],
      reviews: [review([]), review([])],
    });
    const out = await h.run();
    const gap = store.listDecisions({ runId: out.runId }).find((d) => d.kind === 'ci_gap')!;
    expect(gap.body).toContain('`build ## Injected`');
    expect(gap.body).not.toMatch(/^## Injected/m);
    const ev = store.listEvents(out.runId).find((e) => e.type === 'ci.failed')!;
    expect((ev.payload as { checks: string[] }).checks).toEqual(['b`uild ## Injected']);
  });

  it('opens a ci_gap decision on the second failure: stop blocks the run', async () => {
    const { store, asked } = scripted({ ci_gap: ['stop'] });
    const h = harness({ store, turns: [{}, {}], ciSeq: [fail], reviews: [review([]), review([])] });
    const out = await h.run();
    expect(out.stage).toBe('blocked');
    expect(out.note).toContain('Stopped at your request');
    expect(asked.map((a) => a.kind)).toEqual(['ci_gap']);
    expect(h.calls.sends).toHaveLength(1);
  });

  it('retry makes one more ci-fix round', async () => {
    const { store, asked } = scripted({ ci_gap: ['retry'] });
    const h = harness({
      store,
      turns: [{}, {}, {}],
      ciSeq: [fail, fail, ok],
      reviews: [review([]), review([]), review([])],
    });
    const out = await h.run();
    expect(out.stage).toBe('awaiting_review');
    expect(asked).toHaveLength(1);
    expect(h.calls.sends).toHaveLength(2);
    expect(h.calls.sends[1]).toContain('ci-fix-2.md');
  });

  it('opens one informational item per failed head', async () => {
    const { store } = scripted({ ci_gap: ['stop'] });
    const h = harness({ store, turns: [{}, {}], ciSeq: [fail], reviews: [review([]), review([])] });
    const out = await h.run();
    const info = store
      .listDecisions({ runId: out.runId })
      .filter((d) => d.kind === 'ci_gap' && d.options === null);
    expect(info).toHaveLength(2);
    expect(new Set(info.map((d) => d.title)).size).toBe(2);
    expect(info[0]!.body).toContain('build-linux');
  });

  it('blocks instead of waiting when there is no database to ask', async () => {
    const h = harness({ turns: [{}, {}], ciSeq: [fail], reviews: [review([]), review([])] });
    const out = await h.run();
    expect(out.stage).toBe('blocked');
    expect(out.note).toContain('database');
  });

  it('does not fix a timeout', async () => {
    const h = harness({ turns: [{}], ci: 'timeout' });
    const out = await h.run();
    expect(out.stage).toBe('blocked');
    expect(h.calls.sends).toHaveLength(0);
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

  it('cancels a run resting for review, closing its question and releasing it', async () => {
    const store = openStore(':memory:').runs;
    const h = harness({ store, turns: [{}] });
    const out = await h.run();
    expect(out.stage).toBe('awaiting_review');
    const next = await continueRun(out.runId, { kind: 'cancel' }, h.deps);
    expect(next.stage).toBe('cancelled');
    expect(store.getRun(out.runId)!.stage).toBe('cancelled');
    expect(state(out).stage).toBe('cancelled');
    expect(finalReviews(store, out.runId).map((d) => d.status)).toEqual(['dismissed']);
  });

  it('cancels a run resting for plan approval', async () => {
    const store = openStore(':memory:').runs;
    const h = harness({ store, description: 'Add widgets', turns: [{}] });
    const out = await h.run();
    expect(out.stage).toBe('awaiting_plan_approval');
    const next = await continueRun(out.runId, { kind: 'cancel' }, h.deps);
    expect(next.stage).toBe('cancelled');
    expect(store.listDecisions({ runId: out.runId, status: 'open' })).toEqual([]);
  });

  it('refuses to cancel a run that is complete', async () => {
    const h = harness({ turns: [{}] });
    const out = await h.run();
    await continueRun(out.runId, { kind: 'approve' }, h.deps);
    await expect(continueRun(out.runId, { kind: 'cancel' }, h.deps)).rejects.toThrow(
      /not resting or stopped/,
    );
  });

  it('keeps a resting run resting, with its question reopened, when shutdown aborts the continuation first', async () => {
    const store = openStore(':memory:').runs;
    const h = harness({ store, turns: [{}] });
    const out = await h.run();
    answerReview(store, out.runId, 'approve', null);
    const ac = new AbortController();
    ac.abort(new ShutdownError());
    await expect(continueRun(out.runId, { kind: 'approve' }, h.deps, ac.signal)).rejects.toThrow();
    expect(store.getRun(out.runId)!.stage).toBe('awaiting_review');
    expect(state(out).stage).toBe('awaiting_review');
    expect(store.listDecisions({ runId: out.runId, status: 'open' })).toHaveLength(1);
    // The feedback path stays resting too.
    const next = await continueRun(out.runId, { kind: 'feedback', text: 'x' }, h.deps, ac.signal);
    expect(next.stage).toBe('awaiting_review');
    expect(h.calls.sends).toHaveLength(0);
  });

  it('refuses to continue a run that is not resting', async () => {
    const h = harness({ turns: [{}], ci: 'timeout' });
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
      ciFix: 0,
      feedback: 1,
      checkRuns: 4,
    });
  });

  it('resolves the findings a send-back lists, and blocks a report that skips one', async () => {
    const f = finding('f_1_1', 'P3', 'Nit');
    const store = openStore(':memory:').runs;
    const h = harness({
      store,
      turns: [
        {},
        {
          report: report({
            findingResolutions: [{ findingId: 'r1:f_1_1', resolution: 'fixed', note: 'done' }],
          }),
        },
      ],
      reviews: [review([f]), review([])],
    });
    const out = await h.run();
    expect(store.listFindings(out.runId)[0]).toMatchObject({ key: 'r1:f_1_1', status: 'open' });
    answerReview(store, out.runId, 'send_back', 'Fix the nit');
    const next = await continueRun(
      out.runId,
      { kind: 'feedback', text: 'Fix the nit', findingKeys: ['r1:f_1_1'] },
      h.deps,
    );
    expect(next.stage).toBe('awaiting_review');
    expect(store.listFindings(out.runId)[0]).toMatchObject({ status: 'fixed' });
    const dir = join(out.runDir, 'inputs');
    expect(JSON.parse(readFileSync(join(dir, 'feedback-1.keys.json'), 'utf8'))).toEqual([
      'r1:f_1_1',
    ]);
    expect(readFileSync(join(dir, 'feedback-1.md'), 'utf8')).toContain('findingResolutions');
    expect(readFileSync(join(dir, 'feedback-1.md'), 'utf8')).not.toContain('leave `findingRes');
  });

  it('blocks feedback whose report leaves a listed finding unresolved', async () => {
    const store = openStore(':memory:').runs;
    const h = harness({
      store,
      turns: [{}, {}],
      reviews: [review([finding('f_1_1', 'P3', 'Nit')])],
    });
    const out = await h.run();
    answerReview(store, out.runId, 'send_back', 'Fix the nit');
    const next = await continueRun(
      out.runId,
      { kind: 'feedback', text: 'Fix the nit', findingKeys: ['r1:f_1_1'] },
      h.deps,
    );
    expect(next.stage).toBe('blocked');
    expect(next.note).toContain('missing resolutions for: r1:f_1_1');
    expect(store.listFindings(out.runId)[0]).toMatchObject({ status: 'open' });
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

    const closedClient = () =>
      ({
        getPr: async (_r: unknown, n: number) => ({
          number: n,
          headSha: '',
          url: 'u',
          draft: false,
          state: 'closed',
        }),
      }) as unknown as GitHubClient;

    it('blocks before any work when the PR was closed or merged since review', async () => {
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
      // The PR is closed by the time the feedback arrives.
      const deps = { ...h.deps, github: async () => closedClient() };
      const next = await continueRun(out.runId, { kind: 'feedback', text: 'More' }, deps);
      expect(next.stage).toBe('blocked');
      expect(next.note).toContain('PR #7 is closed');
      // No fix turn, no second publish.
      expect(h.calls.sends).toHaveLength(0);
      expect(gh.calls).toEqual(['create']);
    });
  });
});

describe('planning', () => {
  const DESCRIPTION = 'Add a widgets page\n\nIt should list every widget.';
  const planDecisions = (store: RunStore, runId: string) =>
    store.listDecisions({ runId }).filter((d) => d.kind === 'plan_approval');
  const answerPlan = (store: RunStore, runId: string, choice: string, note: string | null) => {
    const d = store
      .listDecisions({ runId, status: 'open' })
      .find((x) => x.kind === 'plan_approval')!;
    expect(store.answerDecision(d.id, { choice, note })).toBe('answered');
  };
  const PLAN_V2 = PLAN.replace('# Add widgets', '# Add widgets, smaller').replace(
    'Do it.',
    'Do it in two steps.',
  );

  it('records a pasted plan as approved version 1 by me', async () => {
    const store = openStore(':memory:').runs;
    const h = harness({ store, turns: [{}] });
    const out = await h.run();
    expect(store.listPlans(out.runId)).toEqual([
      expect.objectContaining({
        version: 1,
        status: 'approved',
        createdBy: 'me',
        title: 'Add widgets',
        feedback: null,
      }),
    ]);
  });

  it('plans from a description and rests with a v1 plan and a plan_approval decision', async () => {
    const store = openStore(':memory:').runs;
    const h = harness({ store, description: DESCRIPTION, turns: [{}] });
    const out = await h.run();
    expect(out.stage).toBe('awaiting_plan_approval');
    expect(h.calls.worktrees).toBe(1);
    // One planner turn; the implementer never started.
    expect(h.calls.starts).toHaveLength(1);
    expect(h.calls.starts[0]).toMatch(/^Read the planning brief at .*plan-1\.md and follow it\.$/);
    const start = h.calls.startInputs[0]!;
    expect(start.permissionMode).toBe('default');
    expect(start.settingsPath).toBe(join(out.runDir, 'planner-settings.json'));
    expect(start.allowedTools).toContain(`Write(/${join(out.runDir, 'plans', 'v1.md')})`);
    expect(start.allowedTools).not.toContain('Write');
    expect(start.disallowedTools).toContain('Bash(git commit:*)');
    const brief = readFileSync(join(out.runDir, 'briefs', 'plan-1.md'), 'utf8');
    expect(brief).toContain('Add a widgets page');
    expect(brief).toContain(join(out.runDir, 'plans', 'v1.md'));
    expect(readFileSync(join(out.runDir, 'inputs', 'plan-template.md'), 'utf8')).toContain(
      '## Acceptance criteria',
    );
    expect(readFileSync(join(out.runDir, 'plans', 'v1.md'), 'utf8')).toBe(PLAN);
    expect(existsSync(join(out.runDir, 'reports', 'plan-1.json'))).toBe(true);

    expect(store.listPlans(out.runId)).toEqual([
      expect.objectContaining({ version: 1, status: 'draft', createdBy: 'agent', feedback: null }),
    ]);
    const open = store.listDecisions({ runId: out.runId, status: 'open' });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      kind: 'plan_approval',
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'revise', label: 'Request changes' },
      ],
    });
    // The planner is stopped, its session kept; nothing owns the run.
    expect(h.calls.stoppedSessions).toEqual(['planner-1']);
    const run = JSON.parse(readFileSync(join(out.runDir, 'run.json'), 'utf8')) as {
      planner: { sessionId: string };
      planPath: string;
      planVersion: number;
      title: string;
      implementer: unknown;
    };
    expect(run.planner.sessionId).toBe('planner-1');
    expect(run).toMatchObject({ planPath: '', planVersion: 0, title: 'Add a widgets page' });
    expect(run.implementer).toBeNull();
    const row = store.getRun(out.runId)!;
    expect(row).toMatchObject({ stage: 'awaiting_plan_approval', ownerPid: null, planPath: '' });
    expect(store.listStages(out.runId).map((x) => [x.kind, x.state])).toEqual([
      ['plan', 'succeeded'],
    ]);
  });

  it('cuts the title from a long first line to 60 characters', async () => {
    const h = harness({ description: 'x'.repeat(100), turns: [{}] });
    const out = await h.run();
    expect(JSON.parse(readFileSync(join(out.runDir, 'run.json'), 'utf8')).title).toBe(
      `${'x'.repeat(59)}…`,
    );
  });

  it('requests changes in the same planner session, then implements from the approved v2', async () => {
    const store = openStore(':memory:').runs;
    const h = harness({
      store,
      description: DESCRIPTION,
      turns: [{}, { plan: PLAN_V2 }, {}],
    });
    const out = await h.run();
    answerPlan(store, out.runId, 'revise', 'Make it smaller');
    const revised = await continueRun(
      out.runId,
      { kind: 'plan_revise', note: 'Make it smaller' },
      h.deps,
    );
    expect(revised.stage).toBe('awaiting_plan_approval');
    // The same session was resumed, not a new one started.
    expect(h.calls.starts).toHaveLength(1);
    expect(h.calls.sendSessions).toEqual(['planner-1']);
    expect(h.calls.sends[0]).toMatch(/^Read the revision brief at .*plan-2\.md and follow it\.$/);
    const brief = readFileSync(join(out.runDir, 'briefs', 'plan-2.md'), 'utf8');
    expect(brief).toContain('Make it smaller');
    expect(brief).toContain(join(out.runDir, 'plans', 'v1.md'));
    expect(h.calls.sendInputs[0]!.allowedTools).toContain(
      `Write(/${join(out.runDir, 'plans', 'v2.md')})`,
    );
    expect(store.listPlans(out.runId).map((p) => [p.version, p.status, p.feedback])).toEqual([
      [1, 'draft', null],
      [2, 'draft', 'Make it smaller'],
    ]);
    expect(planDecisions(store, out.runId).map((d) => d.status)).toEqual(['open', 'answered']);

    answerPlan(store, out.runId, 'approve', null);
    const done = await continueRun(out.runId, { kind: 'plan_approve' }, h.deps);
    expect(done.stage).toBe('awaiting_review');
    expect(store.listPlans(out.runId).map((p) => [p.version, p.status])).toEqual([
      [1, 'superseded'],
      [2, 'approved'],
    ]);
    // Implementation started a new session, from the approved version.
    expect(h.calls.starts).toHaveLength(2);
    expect(h.calls.starts[1]).toMatch(/implement-1\.md/);
    expect(h.calls.startInputs[1]!.permissionMode).toBe('acceptEdits');
    const implementBrief = readFileSync(join(out.runDir, 'briefs', 'implement-1.md'), 'utf8');
    expect(implementBrief).toContain(join(out.runDir, 'plans', 'v2.md'));
    expect(implementBrief).toContain('version 2');
    const run = JSON.parse(readFileSync(join(out.runDir, 'run.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(run).toMatchObject({
      planPath: join(out.runDir, 'plans', 'v2.md'),
      planVersion: 2,
      title: 'Add widgets, smaller',
      stage: 'awaiting_review',
    });
    expect(run.planHash).toBe(store.listPlans(out.runId)[1]!.contentHash);
    expect(store.getRun(out.runId)).toMatchObject({
      title: 'Add widgets, smaller',
      planPath: join(out.runDir, 'plans', 'v2.md'),
    });
    expect(h.calls.published[0]!.title).toBe('Add widgets, smaller');
  });

  it('gives an invalid plan one retry turn listing the errors', async () => {
    const store = openStore(':memory:').runs;
    const h = harness({
      store,
      description: DESCRIPTION,
      turns: [{ plan: '# Only a title\n' }, {}],
    });
    const out = await h.run();
    expect(out.stage).toBe('awaiting_plan_approval');
    expect(h.calls.sends).toHaveLength(1);
    expect(h.calls.sendSessions).toEqual(['planner-1']);
    expect(h.calls.sends[0]).toContain('Missing section: Goal');
    expect(h.calls.sends[0]).toContain('v1.md');
    expect(store.listPlans(out.runId)).toHaveLength(1);
    expect(readFileSync(join(out.runDir, 'plans', 'v1.md'), 'utf8')).toBe(PLAN);
  });

  it('blocks with the validation errors when the retry is invalid too', async () => {
    const store = openStore(':memory:').runs;
    const h = harness({
      store,
      description: DESCRIPTION,
      turns: [{ plan: '# Only a title\n' }, { plan: '# Still a title\n' }],
    });
    const out = await h.run();
    expect(out.stage).toBe('blocked');
    expect(out.note).toContain('still invalid after one retry');
    expect(out.note).toContain('Missing section: Approach');
    expect(h.calls.sends).toHaveLength(1);
    expect(store.listPlans(out.runId)).toHaveLength(0);
    expect(store.listDecisions({ runId: out.runId, status: 'open' })[0]!.kind).toBe('blocked');
  });

  it('treats a plan the planner did not write as invalid', async () => {
    const h = harness({ description: DESCRIPTION, turns: [{ plan: null }, { plan: null }] });
    const out = await h.run();
    expect(out.stage).toBe('blocked');
    expect(out.note).toContain('The plan file was not written');
  });

  it('blocks when the planner leaves the worktree dirty', async () => {
    const store = openStore(':memory:').runs;
    const h = harness({ store, description: DESCRIPTION, turns: [{ dirty: true }] });
    const out = await h.run();
    expect(out.stage).toBe('blocked');
    expect(out.note).toContain('Worktree has uncommitted changes');
    expect(store.listPlans(out.runId)).toHaveLength(0);
  });

  it('blocks when the planner moves HEAD', async () => {
    const store = openStore(':memory:').runs;
    const h = harness({ store, description: DESCRIPTION, turns: [{ moveHead: true }] });
    const out = await h.run();
    expect(out.stage).toBe('blocked');
    expect(out.note).toContain('Planner moved HEAD');
    expect(store.listPlans(out.runId)).toHaveLength(0);
  });

  it('gives the reviewer the approved v2 plan', async () => {
    const h = harness({ description: DESCRIPTION, turns: [{}, { plan: PLAN_V2 }, {}] });
    const out = await h.run();
    await continueRun(out.runId, { kind: 'plan_revise', note: 'smaller' }, h.deps);
    await continueRun(out.runId, { kind: 'plan_approve' }, h.deps);
    expect(h.calls.reviews[0]!.planPath).toBe(join(out.runDir, 'plans', 'v2.md'));
  });

  it('blocks approval when the plan file no longer matches its stored hash', async () => {
    const store = openStore(':memory:').runs;
    const h = harness({ store, description: DESCRIPTION, turns: [{}] });
    const out = await h.run();
    answerPlan(store, out.runId, 'approve', null);
    writeFileSync(join(out.runDir, 'plans', 'v1.md'), PLAN_V2);
    const next = await continueRun(out.runId, { kind: 'plan_approve' }, h.deps);
    expect(next.stage).toBe('awaiting_plan_approval');
    expect(store.listPlans(out.runId)[0]!.status).toBe('draft');
    const open = store.listDecisions({ runId: out.runId, status: 'open' });
    expect(open[0]!.body).toContain('hash mismatch');
    expect(h.calls.starts).toHaveLength(1);
  });

  it('keeps the plan a draft when the move out of rest fails', async () => {
    const store = openStore(':memory:').runs;
    const h = harness({ store, description: DESCRIPTION, turns: [{}] });
    const out = await h.run();
    answerPlan(store, out.runId, 'approve', null);
    forced.illegal = ['awaiting_plan_approval', 'implementing'];
    const next = await continueRun(out.runId, { kind: 'plan_approve' }, h.deps);
    expect(next.stage).toBe('awaiting_plan_approval');
    expect(store.listPlans(out.runId)[0]!.status).toBe('draft');
    expect(h.calls.starts).toHaveLength(1);
  });

  it('carries on and notes it when the store cannot record the approval', async () => {
    const real = openStore(':memory:').runs;
    const store: RunStore = new Proxy(real, {
      get(t, prop, recv) {
        if (prop === 'approvePlan') return () => false;
        return Reflect.get(t, prop, recv) as unknown;
      },
    });
    const h = harness({ store, description: DESCRIPTION, turns: [{}, {}] });
    const out = await h.run();
    answerPlan(real, out.runId, 'approve', null);
    await continueRun(out.runId, { kind: 'plan_approve' }, h.deps);
    expect(real.listEvents(out.runId).map((e) => e.type)).toContain('plan.approval_unrecorded');
    expect(h.calls.starts).toHaveLength(2);
  });

  it('stores the pane label a resumed planner is relaunched under', async () => {
    const h = harness({ description: DESCRIPTION, turns: [{}, { plan: PLAN_V2 }] });
    const out = await h.run();
    const send = h.deps.adapter.send.bind(h.deps.adapter);
    h.deps.adapter.send = async (s, input, message) => {
      s.paneLabel = `bp-${out.runId}-plan-r2`;
      return send(s, input, message);
    };
    await continueRun(out.runId, { kind: 'plan_revise', note: 'x' }, h.deps);
    const run = JSON.parse(readFileSync(join(out.runDir, 'run.json'), 'utf8')) as {
      planner: { paneLabel: string };
    };
    expect(run.planner.paneLabel).toBe(`bp-${out.runId}-plan-r2`);
    expect(h.calls.sendInputs[0]!.role).toBe('plan');
  });

  it('blocks with the questions when the planner reports blocked', async () => {
    const h = harness({
      description: DESCRIPTION,
      turns: [{ report: report({ status: 'blocked', questions: ['Which page?'] }) }],
    });
    const out = await h.run();
    expect(out.stage).toBe('blocked');
    expect(out.note).toContain('Planner is blocked and has questions: Which page?');
  });

  it('does not put planner reports among the implementer work', async () => {
    const h = harness({ description: DESCRIPTION, turns: [{}, {}] });
    const out = await h.run();
    await continueRun(out.runId, { kind: 'plan_approve' }, h.deps);
    const pub = h.calls.published[0]!;
    expect(pub.body).not.toContain('plan-1');
  });

  describe('when an answer cannot be carried out', () => {
    it('reopens the plan approval when the plan cannot be read', async () => {
      const store = openStore(':memory:').runs;
      const h = harness({ store, description: DESCRIPTION, turns: [{}] });
      const out = await h.run();
      answerPlan(store, out.runId, 'approve', null);
      writeFileSync(join(out.runDir, 'plans', 'v1.md'), '# broken');
      const next = await continueRun(out.runId, { kind: 'plan_approve' }, h.deps);
      expect(next.stage).toBe('awaiting_plan_approval');
      const open = store.listDecisions({ runId: out.runId, status: 'open' });
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({
        kind: 'plan_approval',
        options: [
          { id: 'approve', label: 'Approve' },
          { id: 'revise', label: 'Request changes' },
        ],
      });
      expect(open[0]!.body).toContain('could not be carried out');
      expect(store.getRun(out.runId)).toMatchObject({
        stage: 'awaiting_plan_approval',
        ownerPid: null,
      });
      expect(h.calls.starts).toHaveLength(1);
    });

    it('reopens it when the run cannot even be loaded', async () => {
      const store = openStore(':memory:').runs;
      const h = harness({ store, description: DESCRIPTION, turns: [{}] });
      const out = await h.run();
      answerPlan(store, out.runId, 'revise', 'x');
      rmSync(join(out.runDir, 'inputs', 'config.json'));
      await expect(
        continueRun(out.runId, { kind: 'plan_revise', note: 'x' }, h.deps),
      ).rejects.toThrow(/no saved config/);
      const open = store.listDecisions({ runId: out.runId, status: 'open' });
      expect(open.map((d) => d.kind)).toEqual(['plan_approval']);
      expect(open[0]!.body).toContain('no saved config');
    });

    it('ends the run when a revision fails after it left rest', async () => {
      const store = openStore(':memory:').runs;
      const h = harness({
        store,
        description: DESCRIPTION,
        turns: [{}, { report: report({ status: 'blocked', questions: ['Which?'] }) }],
      });
      const out = await h.run();
      answerPlan(store, out.runId, 'revise', 'x');
      const next = await continueRun(out.runId, { kind: 'plan_revise', note: 'x' }, h.deps);
      expect(next.stage).toBe('blocked');
      expect(store.listDecisions({ runId: out.runId, status: 'open' }).map((d) => d.kind)).toEqual([
        'blocked',
      ]);
    });

    it('leaves a run that is not waiting for a plan where it is', async () => {
      const store = openStore(':memory:').runs;
      const h = harness({ store, turns: [{}] });
      const out = await h.run();
      const next = await continueRun(out.runId, { kind: 'plan_approve' }, h.deps);
      expect(next.stage).toBe('awaiting_review');
      expect(h.calls.starts).toHaveLength(1);
      expect(store.listPlans(out.runId)).toHaveLength(1);
    });
  });
});

describe('resume', () => {
  const resume = (h: ReturnType<typeof harness>, id: string, keep = false) =>
    continueRun(id, keep ? { kind: 'resume', keep: true } : { kind: 'resume' }, h.deps);

  /** Interrupts a run in its first agent turn. */
  async function interruptedMidImplement(store: RunStore) {
    const ac = new AbortController();
    const h = harness({ store, turns: [{}, {}, {}], hangFirstTurn: true });
    const p = h.run(ac.signal);
    await new Promise((r) => setTimeout(r, 50));
    ac.abort(new ShutdownError());
    const out = await p;
    expect(out.stage).toBe('interrupted');
    return { h, out };
  }

  /** Interrupts a run as it publishes, after a clean review of its head. */
  async function interruptedAtPublish(store: RunStore) {
    const ac = new AbortController();
    let pushes = 0;
    const h = harness({
      store,
      turns: [{}],
      publishWith: async (p) => {
        if (pushes++ === 0) {
          ac.abort(new ShutdownError());
          throw new Error('server stopped');
        }
        return { prNumber: 7, url: 'https://x/pr/7', headSha: p.branch, created: true };
      },
    });
    const out = await h.run(ac.signal);
    expect(out.stage).toBe('interrupted');
    return { h, out };
  }

  it('resumes the same session mid-implement, judges the report and rests for review', async () => {
    const store = openStore(':memory:').runs;
    const { h, out } = await interruptedMidImplement(store);
    const next = await resume(h, out.runId);
    expect(next.stage).toBe('awaiting_review');
    expect(h.calls.starts).toHaveLength(1);
    expect(h.calls.sendSessions).toEqual(['s1']);
    expect(h.calls.sends[0]).toMatch(
      /^You were interrupted\. Continue the task in .*implement-1\.md;/,
    );
    expect(existsSync(join(out.runDir, 'reports', 'implement-1.json'))).toBe(true);
    expect(h.calls.published).toHaveLength(1);
    // The stale open question is closed, the resume is recorded, and no run is left stopped.
    expect(store.listDecisions({ runId: out.runId, status: 'open' }).map((d) => d.kind)).toEqual([
      'final_review',
    ]);
    const types = store.listEvents(out.runId).map((e) => e.type);
    expect(types).toContain('run.resumed');
    expect(store.getRun(out.runId)?.stage).toBe('awaiting_review');
    expect(stagesOf(store, out)[0]).toEqual(['implement', 1, 'cancelled']);
  });

  it('judges a report the agent had already written without sending anything', async () => {
    const store = openStore(':memory:').runs;
    const { h, out } = await interruptedMidImplement(store);
    h.git.head = 'c'.repeat(40);
    writeFileSync(join(out.runDir, 'report.json'), JSON.stringify(report()));
    const next = await resume(h, out.runId);
    expect(next.stage).toBe('awaiting_review');
    expect(h.calls.sends).toHaveLength(0);
  });

  it('resumes at publish after a clean review, without another review or local CI', async () => {
    const store = openStore(':memory:').runs;
    const { h, out } = await interruptedAtPublish(store);
    expect(h.calls.reviews).toHaveLength(1);
    expect(h.calls.checks).toBe(1);
    const next = await resume(h, out.runId);
    expect(next.stage).toBe('awaiting_review');
    expect(h.calls.reviews).toHaveLength(1);
    expect(h.calls.checks).toBe(1);
    expect(h.calls.sends).toHaveLength(0);
    expect(h.calls.published).toHaveLength(2);
    expect(next.prNumber).toBe(7);
    const resumed = store.listEvents(out.runId).find((e) => e.type === 'run.resumed');
    expect(resumed?.payload).toMatchObject({ from: 'interrupted', point: 'publish' });
  });

  it('resumes a mid-turn dirty worktree without asking, telling the agent about it', async () => {
    const store = openStore(':memory:').runs;
    const { h, out } = await interruptedMidImplement(store);
    h.git.dirty = true;
    const next = await resume(h, out.runId);
    expect(next.stage).toBe('awaiting_review');
    expect(h.calls.sends).toHaveLength(1);
    expect(h.calls.sends[0]).toContain('uncommitted changes from before the interruption');
    expect(h.calls.sends[0]).toContain('git status');
    expect(store.listDecisions({ runId: out.runId }).map((d) => d.kind)).not.toContain(
      'resume_conflict',
    );
  });

  it('asks instead of resuming when the worktree is dirty after the agent turn', async () => {
    const store = openStore(':memory:').runs;
    const { h, out } = await interruptedAtPublish(store);
    h.git.dirty = true;
    const next = await resume(h, out.runId);
    expect(next.stage).toBe('interrupted');
    expect(h.calls.sends).toHaveLength(0);
    expect(h.calls.published).toHaveLength(1);
    const open = store.listDecisions({ runId: out.runId, status: 'open' });
    expect(open.map((d) => d.kind)).toEqual(['resume_conflict']);
    expect(open[0]!.body).toContain('a.ts');
    expect(open[0]!.options?.map((o) => o.id)).toEqual(['keep', 'cancel']);
    expect(store.getRun(out.runId)?.ownerPid).toBeNull();
    // Keeping them goes on from there.
    h.git.dirty = false;
    const kept = await resume(h, out.runId, true);
    expect(kept.stage).toBe('awaiting_review');
  });

  it('asks when HEAD moved since the run stopped, and keep re-records the head', async () => {
    const store = openStore(':memory:').runs;
    const { h, out } = await interruptedAtPublish(store);
    const before = h.git.head;
    h.git.head = 'f'.repeat(40);
    const next = await resume(h, out.runId);
    expect(next.stage).toBe('interrupted');
    const [q] = store.listDecisions({ runId: out.runId, status: 'open' });
    expect(q!.kind).toBe('resume_conflict');
    expect(q!.body).toContain(before.slice(0, 7));
    expect(h.calls.published).toHaveLength(1);
    const kept = await resume(h, out.runId, true);
    expect(kept.stage).toBe('awaiting_review');
    // The new head has no evidence: local CI and review ran on it before publishing.
    expect(h.calls.checks).toBe(2);
    expect(h.calls.reviews).toHaveLength(2);
    expect(h.calls.published.at(-1)).toBeDefined();
  });

  it('resumes a blocked run through the same session and mentions what blocked it', async () => {
    const store = openStore(':memory:').runs;
    const h = harness({ store, turns: [{ report: report({ status: 'partial' }) }, {}] });
    const out = await h.run();
    expect(out.stage).toBe('blocked');
    const next = await resume(h, out.runId);
    expect(next.stage).toBe('awaiting_review');
    expect(h.calls.sendSessions).toEqual(['s1']);
    expect(h.calls.sends[0]).toContain(
      'The run had stopped because: Implementer reported partial work',
    );
  });

  it('keeps the fix-round counters across a resume', async () => {
    const store = openStore(':memory:').runs;
    const ac = new AbortController();
    let reviews = 0;
    const h = harness({
      store,
      turns: [{}, {}],
      checks: [false, true],
      onReview: () => {
        if (reviews++ === 0) ac.abort(new ShutdownError());
      },
    });
    const out = await h.run(ac.signal);
    expect(out.stage).toBe('interrupted');
    expect(state(out).rounds.checkFix).toBe(1);
    const next = await resume(h, out.runId);
    expect(next.stage).toBe('awaiting_review');
    expect(state(next).rounds.checkFix).toBe(1);
  });

  it('does not resume runs that failed, were cancelled or completed', async () => {
    for (const to of ['failed', 'cancelled', 'complete'] as const) {
      const store = openStore(':memory:').runs;
      const h = harness({ store, turns: [{}] });
      const out = await h.run();
      store.updateRun(out.runId, { stage: to });
      const file = join(out.runDir, 'run.json');
      const st = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      writeFileSync(file, JSON.stringify({ ...st, stage: to }));
      await expect(resume(h, out.runId)).rejects.toThrow(/did not stop where it can resume/);
      expect(h.calls.sends).toHaveLength(0);
    }
  });

  it('asks, and offers only cancel, when the worktree cannot be read', async () => {
    const store = openStore(':memory:').runs;
    const { h, out } = await interruptedMidImplement(store);
    h.deps.git.statusLines = async () => [];
    h.deps.git.headSha = async () => {
      throw new Error('git is broken');
    };
    // An unreadable worktree asks rather than failing.
    const asked = await resume(h, out.runId);
    expect(asked.stage).toBe('interrupted');
    expect(store.listDecisions({ runId: out.runId, status: 'open' }).map((d) => d.kind)).toEqual([
      'resume_conflict',
    ]);
  });

  it('keeps the run stopped, with its question back, when a resume fails before it moves', async () => {
    const store = openStore(':memory:').runs;
    const { h, out } = await interruptedMidImplement(store);
    forced.illegal = ['interrupted', 'implementing'];
    const next = await resume(h, out.runId);
    expect(next.stage).toBe('interrupted');
    expect(store.getRun(out.runId)?.stage).toBe('interrupted');
    expect(store.getRun(out.runId)?.ownerPid).toBeNull();
    const open = store.listDecisions({ runId: out.runId, status: 'open' });
    expect(open.map((d) => d.kind)).toEqual(['interrupted']);
    expect(open[0]!.body).toContain('could not be resumed');
    expect(open[0]!.options?.map((o) => o.id)).toEqual(['resume', 'dismiss']);
    // Still resumable once the problem is gone.
    forced.illegal = null;
    expect((await resume(h, out.runId)).stage).toBe('awaiting_review');
  });

  it('settles kept uncommitted changes with a commit turn, then checks the new head', async () => {
    const store = openStore(':memory:').runs;
    const { h, out } = await interruptedAtPublish(store);
    h.git.dirty = true;
    expect((await resume(h, out.runId)).stage).toBe('interrupted');
    const kept = await resume(h, out.runId, true);
    expect(kept.stage).toBe('awaiting_review');
    expect(h.calls.sends).toHaveLength(1);
    expect(h.calls.sends[0]).toContain('uncommitted changes from before an interruption');
    expect(h.calls.sends[0]).toContain('a.ts');
    expect(stagesOf(store, out).map((r) => r[0])).toContain('resume-commit');
    // The new commit has no evidence: local CI and a review ran on it before publishing.
    expect(h.calls.checks).toBe(2);
    expect(h.calls.reviews).toHaveLength(2);
    expect(existsSync(join(out.runDir, 'reports', 'resume-commit-1.json'))).toBe(true);
  });

  it('does not review again a head whose blocking findings the loop accepted', async () => {
    const store = openStore(':memory:').runs;
    const ac = new AbortController();
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
    const real = h.deps.waitForCi;
    h.deps.waitForCi = () => {
      ac.abort(new ShutdownError());
      return new Promise(() => undefined);
    };
    const out = await h.run(ac.signal);
    expect(out.stage).toBe('interrupted');
    expect(h.calls.reviews).toHaveLength(2);
    h.deps.waitForCi = real;
    const next = await resume(h, out.runId);
    expect(next.stage).toBe('awaiting_review');
    expect(h.calls.reviews).toHaveLength(2);
    expect(h.calls.checks).toBe(2);
    expect(h.calls.sends).toHaveLength(1);
    expect(h.calls.published).toHaveLength(1);
  });

  it('resolves old interrupted questions without options, and never leaves two open', async () => {
    const store = openStore(':memory:').runs;
    const { h, out } = await interruptedMidImplement(store);
    const old = store.openDecision({
      runId: out.runId,
      kind: 'interrupted',
      title: 'Run interrupted',
      body: 'old item',
    });
    h.git.dirty = false;
    await resume(h, out.runId);
    expect(store.getDecision(old)?.status).toBe('resolved');
  });

  it('closes the stopped questions before it reopens one after a failed resume', async () => {
    const store = openStore(':memory:').runs;
    const { h, out } = await interruptedMidImplement(store);
    forced.illegal = ['interrupted', 'implementing'];
    await resume(h, out.runId);
    await resume(h, out.runId);
    const open = store.listDecisions({ runId: out.runId, status: 'open' });
    expect(open.filter((d) => d.kind === 'interrupted')).toHaveLength(1);
  });
});

describe('cancel at any stage', () => {
  /** Runs `h` until `ready`, aborts it plainly, and returns the outcome. */
  async function cancelledDuring(h: ReturnType<typeof harness>, wait = 80) {
    const ac = new AbortController();
    const p = h.run(ac.signal);
    await new Promise((r) => setTimeout(r, wait));
    ac.abort();
    return p;
  }

  /** What every cancelled run leaves: one cancelled run, closed stages and questions. */
  function expectConsistent(store: RunStore, out: RunOutcome, stage: string) {
    expect(out.stage).toBe('cancelled');
    expect(store.getRun(out.runId)?.stage).toBe('cancelled');
    expect(store.listStages(out.runId).filter((s) => s.state === 'running')).toEqual([]);
    expect(store.listDecisions({ runId: out.runId, status: 'open' })).toEqual([]);
    const ev = store.listEvents(out.runId).find((e) => e.type === 'run.cancelled');
    expect(ev?.payload).toEqual({ stage });
  }

  it.each([
    ['headless', false],
    ['pane', true],
  ])('cancels an implementer turn in a %s session and stops the agent', async (_n, pane) => {
    const store = openStore(':memory:').runs;
    const h = harness({ store, turns: [], hangFirstTurn: true, pane });
    const out = await cancelledDuring(h);
    expectConsistent(store, out, 'implementing');
    expect(stagesOf(store, out)).toEqual([['implement', 1, 'cancelled']]);
    expect(h.calls.stoppedSessions).toEqual(['s1']);
    expect(h.calls.stopOpts[0]).toMatchObject({ force: true });
  });

  it('cancels while local CI runs', async () => {
    const store = openStore(':memory:').runs;
    const h = harness({ store, turns: [{}], hang: ['checks'] });
    const out = await cancelledDuring(h);
    expectConsistent(store, out, 'checking');
    expect(stagesOf(store, out)).toEqual([
      ['implement', 1, 'succeeded'],
      ['checks', 1, 'cancelled'],
    ]);
    expect(h.calls.stoppedSessions).toEqual(['s1']);
  });

  it('cancels while the reviewer runs', async () => {
    const store = openStore(':memory:').runs;
    const h = harness({ store, turns: [{}], hang: ['review'] });
    const out = await cancelledDuring(h);
    expectConsistent(store, out, 'reviewing');
    expect(stagesOf(store, out).at(-1)).toEqual(['review', 1, 'cancelled']);
  });

  it('cancels while waiting for GitHub CI, keeping the PR number', async () => {
    const store = openStore(':memory:').runs;
    const h = harness({ store, turns: [{}], hang: ['ci'] });
    const out = await cancelledDuring(h);
    expectConsistent(store, out, 'waiting_ci');
    expect(stagesOf(store, out).at(-1)).toEqual(['wait-ci', 1, 'cancelled']);
    expect(store.getRun(out.runId)?.prNumber).toBe(7);
  });

  it('cancels while a question waits, dismissing it', async () => {
    const ac = new AbortController();
    const real = openStore(':memory:').runs;
    const store: RunStore = new Proxy(real, {
      get(target, prop, recv) {
        if (prop === 'openDecision') {
          return (input: Parameters<RunStore['openDecision']>[0]) => {
            const id = target.openDecision(input);
            if (input.kind === 'finding_triage') ac.abort();
            return id;
          };
        }
        return Reflect.get(target, prop, recv) as unknown;
      },
    });
    const reviews = [review([finding('f_1_2', 'P2', 'Missing test')])];
    const out = await harness({ store, turns: [{}], reviews }).run(ac.signal);
    expectConsistent(store, out, 'awaiting_decision');
  });

  it('cancels a planner that is still planning, stopping its session', async () => {
    const store = openStore(':memory:').runs;
    const h = harness({
      store,
      turns: [],
      hangFirstTurn: true,
      pane: true,
      description: 'Add widgets',
    });
    const out = await cancelledDuring(h);
    expectConsistent(store, out, 'planning');
    expect(h.calls.stoppedSessions).toEqual(['planner-1']);
  });

  it('closes a stage a dead owner left running when it cancels a stopped run', async () => {
    const store = openStore(':memory:').runs;
    const ac = new AbortController();
    const h = harness({ store, turns: [], hangFirstTurn: true, pane: true });
    const p = h.run(ac.signal);
    await new Promise((r) => setTimeout(r, 50));
    ac.abort(new ShutdownError());
    const out = await p;
    expect(out.stage).toBe('interrupted');
    // The server stopped: the agent's terminal was left running.
    expect(h.calls.stops).toBe(0);
    const next = await continueRun(out.runId, { kind: 'cancel' }, h.deps);
    expect(next.stage).toBe('cancelled');
    expectConsistent(store, next, 'interrupted');
    // The still-open terminal is closed with the run.
    expect(h.calls.stoppedSessions).toEqual(['s1']);
    expect(h.calls.stopOpts[0]).toMatchObject({ force: true, runDir: out.runDir });
    // The worktree and run directory are left alone.
    expect(existsSync(join(out.runDir, 'run.json'))).toBe(true);
  });

  it('cancels a blocked run, closing its resume question', async () => {
    const store = openStore(':memory:').runs;
    const h = harness({
      store,
      turns: [{ report: report({ status: 'blocked', questions: ['?'] }) }],
    });
    const out = await h.run();
    expect(out.stage).toBe('blocked');
    const next = await continueRun(out.runId, { kind: 'cancel' }, h.deps);
    expect(next.stage).toBe('cancelled');
    expectConsistent(store, next, 'blocked');
  });

  it('a cancel that reaches a resume before it leaves the stopped stage still cancels', async () => {
    const store = openStore(':memory:').runs;
    const ac0 = new AbortController();
    const h = harness({ store, turns: [{}], hangFirstTurn: true });
    const p = h.run(ac0.signal);
    await new Promise((r) => setTimeout(r, 50));
    ac0.abort(new ShutdownError());
    const out = await p;
    const ac = new AbortController();
    ac.abort();
    const next = await continueRun(out.runId, { kind: 'resume' }, h.deps, ac.signal);
    expect(next.stage).toBe('cancelled');
    expectConsistent(store, next, 'interrupted');
  });
});

describe('resume of a planner whose agent is still alive', () => {
  it('waits on the working planner and judges its turn before prompting again', async () => {
    const store = openStore(':memory:').runs;
    const ac = new AbortController();
    const h = harness({
      store,
      turns: [{}],
      hangFirstTurn: true,
      pane: true,
      description: 'Add widgets',
      reattach: 'working',
    });
    const p = h.run(ac.signal);
    await new Promise((r) => setTimeout(r, 50));
    ac.abort(new ShutdownError());
    const out = await p;
    expect(out.stage).toBe('interrupted');
    const next = await continueRun(out.runId, { kind: 'resume' }, h.deps);
    expect(next.stage).toBe('awaiting_plan_approval');
    expect(h.calls.reattaches).toEqual(['planner-1']);
    expect(h.calls.sends).toHaveLength(0);
    expect(store.listEvents(out.runId).map((e) => e.type)).toContain('resume.reattached');
  });
});

describe('resume of a pane whose agent is still alive', () => {
  async function interrupted(o: Partial<Opts>) {
    const store = openStore(':memory:').runs;
    const ac = new AbortController();
    const h = harness({ store, turns: [{}, {}], hangFirstTurn: true, pane: true, ...o });
    const p = h.run(ac.signal);
    await new Promise((r) => setTimeout(r, 50));
    ac.abort(new ShutdownError());
    const out = await p;
    return { h, out, store };
  }

  it('waits on the working agent instead of sending anything', async () => {
    const { h, out, store } = await interrupted({ reattach: 'working' });
    const next = await continueRun(out.runId, { kind: 'resume' }, h.deps);
    expect(next.stage).toBe('awaiting_review');
    expect(h.calls.reattaches).toEqual(['s1']);
    expect(h.calls.sends).toHaveLength(0);
    expect(h.calls.starts).toHaveLength(1);
    expect(store.listEvents(out.runId).map((e) => e.type)).toContain('resume.reattached');
  });

  it('sends to the same session when the agent is not working', async () => {
    const { h, out } = await interrupted({ reattach: 'none' });
    const next = await continueRun(out.runId, { kind: 'resume' }, h.deps);
    expect(next.stage).toBe('awaiting_review');
    expect(h.calls.reattaches).toEqual(['s1']);
    expect(h.calls.sendSessions).toEqual(['s1']);
    expect(h.calls.starts).toHaveLength(1);
  });
});
