/**
 * Reproduces the Codex reviewer spike.
 *
 *   npx tsx spikes/codex-review/run.ts --repo <worktree> --base <sha> --head <sha> \
 *     [--option 1|2|both] [--out <dir>] [--plan <path>] [--model <m>]
 *
 * Run from anywhere; codex runs with cwd = --repo (a checkout at --head). Never writes to the repo.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  lastAgentMessage,
  normalizeProseReview,
  parseEvents,
  parseReviewerOutput,
} from './findings.js';

const here = dirname(fileURLToPath(import.meta.url));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

function exec(args: string[], cwd: string, input?: string): Promise<Run> {
  const started = Date.now();
  return new Promise((res, rej) => {
    const child = spawn('codex', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      // Progress display: one line per event type.
      for (const ev of parseEvents(s)) process.stderr.write(`  [event] ${ev.type}\n`);
    });
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', rej);
    child.on('close', (code) => res({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(input ?? '');
  });
}

async function main(): Promise<void> {
  const repo = resolve(arg('repo') ?? '.');
  const base = arg('base');
  const head = arg('head');
  if (!base || !head) throw new Error('--base and --head are required');
  const option = arg('option') ?? 'both';
  const out = resolve(arg('out') ?? join(repo, '..'));
  const model = arg('model');
  const plan = arg('plan') ?? 'none';
  await mkdir(out, { recursive: true });
  const modelArgs = model ? ['-m', model] : [];

  if (option === '1' || option === 'both') {
    console.error('== option 1: codex exec review --base');
    const r = await exec(
      [
        'exec',
        'review',
        '--ignore-user-config',
        '--ephemeral',
        '--json',
        '--base',
        base,
        ...modelArgs,
      ],
      repo,
    );
    await writeFile(join(out, 'opt1.events.jsonl'), r.stdout);
    const text = lastAgentMessage(parseEvents(r.stdout)) ?? '';
    console.log(
      JSON.stringify(
        { option: 1, exit: r.code, ms: r.ms, prose: normalizeProseReview(text) },
        null,
        2,
      ),
    );
  }

  if (option === '2' || option === 'both') {
    console.error('== option 2: codex exec --output-schema');
    const prompt = (await readFile(join(here, 'review-prompt.md'), 'utf8'))
      .replaceAll('{{PLAN_PATH}}', plan)
      .replaceAll('{{BASE_SHA}}', base)
      .replaceAll('{{HEAD_SHA}}', head)
      .replaceAll('{{PRIOR_FINDINGS}}', '(none: first round)');
    const lastFile = join(out, 'opt2.last-message.txt');
    const r = await exec(
      [
        'exec',
        '--sandbox',
        'read-only',
        '--ignore-user-config',
        '--ephemeral',
        '--json',
        '--output-schema',
        join(here, 'findings.schema.json'),
        '--output-last-message',
        lastFile,
        ...modelArgs,
        '-',
      ],
      repo,
      prompt,
    );
    await writeFile(join(out, 'opt2.events.jsonl'), r.stdout);
    await writeFile(join(out, 'opt2.stderr.txt'), r.stderr);
    const text =
      (await readFile(lastFile, 'utf8').catch(() => undefined)) ??
      lastAgentMessage(parseEvents(r.stdout)) ??
      '';
    const parsed = parseReviewerOutput(text, head);
    console.log(JSON.stringify({ option: 2, exit: r.code, ms: r.ms, parsed }, null, 2));
    if (r.code !== 0 || !parsed.ok) process.exitCode = 1;
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(2);
});
