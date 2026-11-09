import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { scrubbedEnv } from '../agents/claude-headless.js';
import { createGit, type Git } from '../git/index.js';
import { stripMcpNoise } from '../llm/codex-cli.js';
import { spawnCli, type SpawnFn } from '../llm/spawn-cli.js';
import {
  lastAgentMessage,
  parseEvents,
  parseReviewerOutput,
  type ReviewerOutput,
} from './findings.js';
import { renderReviewPrompt, type PriorFinding } from './prompt.js';
import { writeFindingsSchema } from './schema.js';

export const DEFAULT_REVIEW_TIMEOUT_MS = 5 * 60_000;

export interface ReviewWithCodexOptions {
  worktree: string;
  baseSha: string;
  headSha: string;
  planPath: string;
  priorFindings: PriorFinding[];
  outDir: string;
  round: number;
  model?: string;
  timeoutMs?: number;
  spawnFn?: SpawnFn;
  codexHome: string;
  signal?: AbortSignal;
  /** Defaults to the real git service. */
  git?: Pick<Git, 'headSha' | 'isClean'>;
}

export type ReviewResult =
  | {
      ok: true;
      output: ReviewerOutput;
      usage: Record<string, unknown> | undefined;
      attempts: number;
      durationMs: number;
    }
  | { ok: false; error: string; attempts: number };

interface AttemptOk {
  ok: true;
  text: string;
  usage: Record<string, unknown> | undefined;
}

export async function reviewWithCodex(opts: ReviewWithCodexOptions): Promise<ReviewResult> {
  const started = Date.now();
  const { worktree, headSha, outDir } = opts;
  const git = opts.git ?? createGit();
  try {
    const head = await git.headSha(worktree);
    if (head !== headSha) {
      return { ok: false, error: `worktree HEAD ${head} != expected ${headSha}`, attempts: 0 };
    }
    if (!(await git.isClean(worktree))) {
      return {
        ok: false,
        error: 'worktree has uncommitted changes; refusing to review',
        attempts: 0,
      };
    }
  } catch (e) {
    return { ok: false, error: `git check failed: ${(e as Error).message}`, attempts: 0 };
  }

  await mkdir(outDir, { recursive: true });
  const schemaPath = await writeFindingsSchema(outDir);
  const basePrompt = renderReviewPrompt({
    planPath: opts.planPath,
    baseSha: opts.baseSha,
    headSha,
    priorFindings: opts.priorFindings,
  });

  let prompt = basePrompt;
  let lastError = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const sfx = attempt === 1 ? '' : `-${attempt}`;
    const promptFile = join(outDir, `prompt${sfx}.md`);
    const eventsFile = join(outDir, `events${sfx}.jsonl`);
    const stderrFile = join(outDir, `stderr${sfx}.txt`);
    const lastFile = join(outDir, `last${sfx}.txt`);
    if (attempt === 2) {
      prompt = `${basePrompt}\n## Retry\n\nYour previous output was rejected: ${lastError}. Return only valid JSON.\n`;
    }
    await writeFile(promptFile, prompt);

    const res = await runAttempt(opts, { schemaPath, prompt, eventsFile, stderrFile, lastFile });
    if (!res.ok) return { ok: false, error: res.error, attempts: attempt };

    const parsed = parseReviewerOutput(res.text, headSha);
    if (parsed.ok) {
      const output = normalize(parsed.value, opts);
      await writeFile(join(outDir, 'findings.json'), `${JSON.stringify(output, null, 2)}\n`);
      return {
        ok: true,
        output,
        usage: res.usage,
        attempts: attempt,
        durationMs: Date.now() - started,
      };
    }
    lastError = parsed.error;
  }
  return { ok: false, error: `reviewer output rejected twice: ${lastError}`, attempts: 2 };
}

async function runAttempt(
  opts: ReviewWithCodexOptions,
  f: {
    schemaPath: string;
    prompt: string;
    eventsFile: string;
    stderrFile: string;
    lastFile: string;
  },
): Promise<AttemptOk | { ok: false; error: string }> {
  const args = [
    'exec',
    '--sandbox',
    'read-only',
    '--ignore-user-config',
    '--ephemeral',
    '--json',
    '--output-schema',
    f.schemaPath,
    '--output-last-message',
    f.lastFile,
    ...(opts.model ? ['-m', opts.model] : []),
    '-',
  ];
  const env = { ...scrubbedEnv(), CODEX_HOME: opts.codexHome };
  let result;
  let out = '';
  let err = '';
  const persist = async () => {
    await writeFile(f.eventsFile, out);
    await writeFile(f.stderrFile, stripMcpNoise(err));
  };
  try {
    result = await spawnCli({
      command: 'codex',
      args,
      input: f.prompt,
      cwd: opts.worktree,
      env,
      timeoutMs: opts.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
      signal: opts.signal,
      spawnFn: opts.spawnFn,
      onStdout: (c) => void (out += c),
      onStderr: (c) => void (err += c),
    });
  } catch (e) {
    await persist().catch(() => undefined);
    return { ok: false, error: `codex failed: ${(e as Error).message}` };
  }
  await persist();
  const stderr = stripMcpNoise(result.stderr);

  const events = parseEvents(result.stdout);
  const failed = events.find((e) => e.type === 'turn.failed' || e.type === 'error');
  if (failed) {
    const msg = failed.error?.message ?? failed.message ?? 'unknown error';
    return { ok: false, error: `codex reported ${failed.type}: ${String(msg)}` };
  }
  const completed = events.find((e) => e.type === 'turn.completed');
  if (!completed) {
    return {
      ok: false,
      error: `codex did not complete (exit ${result.code}): ${stderr.trim().slice(-300)}`,
    };
  }
  let text = await readFile(f.lastFile, 'utf8').catch(() => undefined);
  if (!text?.trim()) text = lastAgentMessage(events);
  if (!text?.trim()) return { ok: false, error: 'codex produced no final message' };
  return { ok: true, text, usage: completed.usage };
}

function normalize(out: ReviewerOutput, opts: ReviewWithCodexOptions): ReviewerOutput {
  const root = resolve(opts.worktree);
  return {
    ...out,
    reviewedSha: opts.headSha,
    findings: out.findings.map((f, i) => {
      const next = { ...f, id: `f_${opts.round}_${i + 1}`, reviewedSha: opts.headSha };
      if (!f.location) return next;
      const loc = f.location;
      const orig = `${loc.path}:${loc.startLine}-${loc.endLine}`;
      const problem = checkLocation(root, loc.path, loc.startLine, loc.endLine);
      if (typeof problem === 'string') {
        return {
          ...next,
          location: null,
          body: `${f.body}\n\n(reported location: ${orig}; ${problem})`,
        };
      }
      return { ...next, location: { ...loc, path: problem.path } };
    }),
  };
}

function checkLocation(
  root: string,
  p: string,
  start: number,
  end: number,
): string | { path: string } {
  const abs = resolve(root, p);
  const rel = relative(root, abs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return 'path outside worktree';
  }
  if (end < start) return 'endLine before startLine';
  if (!existsSync(abs)) return 'file not found';
  let lines: number;
  try {
    const text = readFileSyncSafe(abs);
    lines = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  } catch {
    return 'file not readable';
  }
  if (start > lines) return 'startLine past end of file';
  return { path: rel.split(sep).join('/') };
}

function readFileSyncSafe(p: string): string {
  if (!statSync(p).isFile()) throw new Error('not a file');
  return readFileSync(p, 'utf8');
}
