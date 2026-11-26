/**
 * Reproduces the Codex reviewer spike.
 *
 *   npx tsx spikes/codex-review/run.ts --repo <worktree> --base <sha> --head <sha> \
 *     [--out <dir>] [--plan <path>] [--model <m>]
 *
 * Run from anywhere; codex runs with cwd = --repo (a checkout at --head). Never writes to the repo.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  lastAgentMessage,
  parseEvents,
  parseReviewerOutput,
} from '../../src/core/reviewer/findings.js';
import { renderReviewPrompt } from '../../src/core/reviewer/prompt.js';
import { writeFindingsSchema } from '../../src/core/reviewer/schema.js';

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
  const out = resolve(arg('out') ?? join(repo, '..'));
  const model = arg('model');
  const plan = arg('plan') ?? 'none';
  await mkdir(out, { recursive: true });
  const modelArgs = model ? ['-m', model] : [];

  {
    console.error('== codex exec --output-schema');
    const prompt = renderReviewPrompt({
      planPath: plan,
      baseSha: base,
      headSha: head,
      priorFindings: [],
    });
    const schemaPath = await writeFindingsSchema(out);
    const lastFile = join(out, 'last-message.txt');
    const r = await exec(
      [
        'exec',
        '--sandbox',
        'read-only',
        '--ignore-user-config',
        '--ephemeral',
        '--json',
        '--output-schema',
        schemaPath,
        '--output-last-message',
        lastFile,
        ...modelArgs,
        '-',
      ],
      repo,
      prompt,
    );
    await writeFile(join(out, 'events.jsonl'), r.stdout);
    await writeFile(join(out, 'stderr.txt'), r.stderr);
    const text =
      (await readFile(lastFile, 'utf8').catch(() => undefined)) ??
      lastAgentMessage(parseEvents(r.stdout)) ??
      '';
    const parsed = parseReviewerOutput(text, head);
    console.log(JSON.stringify({ exit: r.code, ms: r.ms, parsed }, null, 2));
    if (r.code !== 0 || !parsed.ok) process.exitCode = 1;
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(2);
});
