// Manual eval of the Codex reviewer: does it find planted/real bugs, and is "no findings" trustworthy?
// Costs real Codex usage. Usage: pnpm eval:reviewer [--case <name-prefix>] [--out <dir>] [--model <m>] [--timeout-min <n>]
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { ensureReviewerCodexHome } from '../src/core/reviewer/codex-home.js';
import { reviewWithCodex } from '../src/core/reviewer/codex-reviewer.js';
import { scoreCase, type CaseScore, type Expectation } from '../src/core/reviewer/eval-score.js';
import type { Finding } from '../src/core/reviewer/findings.js';

const execFileP = promisify(execFile);

const ExpectationSchema = z.object({
  path: z.string(),
  lines: z.tuple([z.number().int(), z.number().int()]).optional(),
  minSeverity: z.enum(['P0', 'P1', 'P2', 'P3']),
  keywords: z.array(z.string()),
});
const CaseSchema = z.discriminatedUnion('kind', [
  z.object({
    name: z.string(),
    kind: z.literal('synthetic'),
    files: z.record(z.string(), z.string()),
    patch: z.record(z.string(), z.string().nullable()),
    plan: z.string(),
    expected: z.array(ExpectationSchema),
  }),
  z.object({
    name: z.string(),
    kind: z.literal('git'),
    repo: z.string(),
    base: z.string(),
    head: z.string(),
    plan: z.string(),
    expected: z.array(ExpectationSchema),
  }),
]);
type EvalCase = z.infer<typeof CaseSchema>;

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const only = flag('--case');
const model = flag('--model');
const timeoutMs = Number(flag('--timeout-min') ?? 10) * 60_000;
// Outside the repo by default so results are never committed by accident.
const outRoot = resolve(flag('--out') ?? mkdtempSync(join(tmpdir(), 'bp-reviewer-eval-')));
const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');

const fixtureDir = join(repoRoot, 'test/fixtures/reviewer-eval');
const cases: EvalCase[] = readdirSync(fixtureDir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => CaseSchema.parse(JSON.parse(readFileSync(join(fixtureDir, f), 'utf8'))))
  .filter((c) => !only || c.name.startsWith(only));

async function git(cwd: string, ...a: string[]): Promise<string> {
  const { stdout } = await execFileP(
    'git',
    [
      '-c',
      'user.name=eval',
      '-c',
      'user.email=eval@example.com',
      '-c',
      'commit.gpgsign=false',
      ...a,
    ],
    { cwd },
  );
  return stdout.trim();
}

async function writeTree(dir: string, files: Record<string, string | null>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    if (content === null) {
      await rm(p, { force: true });
      continue;
    }
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content);
  }
}

interface Prepared {
  worktree: string;
  baseSha: string;
  headSha: string;
  cleanup: () => Promise<void>;
}

async function prepare(c: EvalCase): Promise<Prepared> {
  if (c.kind === 'synthetic') {
    const dir = await realpath(mkdtempSync(join(tmpdir(), 'bp-eval-repo-')));
    await git(dir, 'init', '-q');
    await writeTree(dir, c.files);
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-q', '-m', 'base');
    const baseSha = await git(dir, 'rev-parse', 'HEAD');
    await writeTree(dir, c.patch);
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-q', '-m', 'change');
    const headSha = await git(dir, 'rev-parse', 'HEAD');
    // Throwaway temp repo created above; safe to delete.
    return {
      worktree: dir,
      baseSha,
      headSha,
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  }
  const repo = resolve(repoRoot, c.repo);
  const baseSha = await git(repo, 'rev-parse', c.base);
  const headSha = await git(repo, 'rev-parse', c.head);
  const wt = join(await realpath(mkdtempSync(join(tmpdir(), 'bp-eval-wt-'))), 'wt');
  await git(repo, 'worktree', 'add', '--detach', wt, headSha);
  return {
    worktree: wt,
    baseSha,
    headSha,
    // Removes only the temp worktree this script created, never the user's checkout.
    cleanup: async () => {
      await git(repo, 'worktree', 'remove', '--force', wt);
    },
  };
}

interface CaseResult {
  name: string;
  kind: string;
  ok: boolean;
  error?: string;
  durationMs: number;
  attempts: number;
  expectedCount: number;
  score?: CaseScore;
  findings?: Finding[];
  usage?: Record<string, unknown>;
}

const codexVersion = await execFileP('codex', ['--version']).then(
  (r) => r.stdout.trim(),
  () => 'unknown',
);
const codexHome = await ensureReviewerCodexHome();
mkdirSync(outRoot, { recursive: true });
console.log(`codex: ${codexVersion}\nout:   ${outRoot}\ncases: ${cases.length}\n`);

const results: CaseResult[] = [];
for (const c of cases) {
  const started = Date.now();
  const outDir = join(outRoot, c.name);
  await mkdir(outDir, { recursive: true });
  const planPath = join(outDir, 'plan.md');
  await writeFile(planPath, c.plan);
  let prepared: Prepared | undefined;
  let result: CaseResult;
  try {
    prepared = await prepare(c);
    const r = await reviewWithCodex({
      worktree: prepared.worktree,
      baseSha: prepared.baseSha,
      headSha: prepared.headSha,
      planPath,
      priorFindings: [],
      outDir,
      round: 1,
      model,
      timeoutMs,
      codexHome,
    });
    if (r.ok) {
      const score = scoreCase(c.expected as Expectation[], r.output.findings);
      result = {
        name: c.name,
        kind: c.kind,
        ok: true,
        durationMs: r.durationMs,
        attempts: r.attempts,
        expectedCount: c.expected.length,
        score,
        findings: r.output.findings,
        usage: r.usage,
      };
    } else {
      result = {
        name: c.name,
        kind: c.kind,
        ok: false,
        error: r.error,
        durationMs: Date.now() - started,
        attempts: r.attempts,
        expectedCount: c.expected.length,
      };
    }
  } catch (e) {
    result = {
      name: c.name,
      kind: c.kind,
      ok: false,
      error: (e as Error).message,
      durationMs: Date.now() - started,
      attempts: 0,
      expectedCount: c.expected.length,
    };
  } finally {
    await prepared?.cleanup().catch((e: unknown) => console.error(`cleanup failed: ${String(e)}`));
  }
  results.push(result);
  report(result, c);
  writeFileSync(join(outRoot, 'results.json'), JSON.stringify({ codexVersion, results }, null, 2));
}

function report(r: CaseResult, c: EvalCase): void {
  const secs = (r.durationMs / 1000).toFixed(1);
  console.log(`== ${r.name} [${r.kind}]  ${secs}s`);
  if (!r.ok || !r.score) {
    console.log(`   FAILED: ${r.error}\n`);
    return;
  }
  const s = r.score;
  if (s.recall === null) {
    console.log(
      `   negative case: ${r.findings?.length ?? 0} findings, ${s.falsePositives.length} false positives (P0-P2)`,
    );
  } else {
    console.log(`   recall ${s.matched.length}/${r.expectedCount}`);
    for (const m of s.matched)
      console.log(`   + ${c.expected[m.expectation]?.path} (${m.by}) <- ${m.findingId}`);
    for (const i of s.missed)
      console.log(`   - MISSED ${c.expected[i]?.path}: ${c.expected[i]?.keywords.join('/')}`);
  }
  for (const f of s.extra) {
    const loc = f.location ? `${f.location.path}:${f.location.startLine}` : 'no location';
    console.log(`   ? extra ${f.severity} ${loc} ${f.title}`);
  }
  console.log('');
}

const positives = results.filter((r) => r.ok && r.score && r.score.recall !== null);
const negatives = results.filter((r) => r.ok && r.score && r.score.recall === null);
const hit = positives.reduce((n, r) => n + (r.score?.matched.length ?? 0), 0);
const want = positives.reduce((n, r) => n + r.expectedCount, 0);
const fps = negatives.reduce((n, r) => n + (r.score?.falsePositives.length ?? 0), 0);
console.log(
  `recall ${hit}/${want}  false positives ${fps} across ${negatives.length} negative cases  failed runs ${results.filter((r) => !r.ok).length}`,
);
console.log(`results: ${join(outRoot, 'results.json')}`);
