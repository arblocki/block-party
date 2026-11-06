/**
 * Spike driver: run `claude -p` headless in a directory, parse the stream with stream.ts, print
 * a summary, and optionally SIGTERM after N ms. Usage:
 *   npx tsx spikes/claude-headless/run.ts --cwd DIR [--session-id U | --resume U] [--sigterm-after MS]
 *     [--raw FILE] -- <claude flags...> "<prompt>"
 * Everything after `--` is passed to claude verbatim (flags after the prompt are not supported).
 */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { StreamParser, summarize, type ResultEvent } from './stream.js';

interface Opts {
  cwd: string;
  sessionId?: string;
  resume?: string;
  sigtermAfter?: number;
  raw?: string;
  rest: string[];
}

function parseArgs(argv: string[]): Opts {
  const o: Opts = { cwd: process.cwd(), rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      o.rest = argv.slice(i + 1);
      break;
    }
    const v = argv[++i] ?? '';
    if (a === '--cwd') o.cwd = v;
    else if (a === '--session-id') o.sessionId = v;
    else if (a === '--resume') o.resume = v;
    else if (a === '--sigterm-after') o.sigtermAfter = Number(v);
    else if (a === '--raw') o.raw = v;
  }
  return o;
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  const session = o.resume ?? o.sessionId ?? randomUUID();
  const args = [
    '-p',
    ...(o.resume ? ['--resume', session] : ['--session-id', session]),
    '--output-format',
    'stream-json',
    '--verbose',
    ...o.rest,
  ];
  console.error(`$ claude ${args.join(' ')}`);
  // stdin must be closed/ignored: otherwise claude waits 3s for piped input.
  const child = spawn('claude', args, { cwd: o.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const raw = o.raw ? createWriteStream(o.raw) : null;
  const parser = new StreamParser();
  let result: ResultEvent | null = null;
  const handle = (chunk: Buffer | null): void => {
    const events = chunk ? (raw?.write(chunk), parser.push(chunk)) : parser.flush();
    for (const ev of events) {
      if (ev.kind === 'result') result = ev.event;
      const line = summarize(ev);
      if (line) console.log(line);
    }
  };
  child.stdout.on('data', (c: Buffer) => handle(c));
  child.stderr.on('data', (c: Buffer) => process.stderr.write(c));
  if (o.sigtermAfter !== undefined) {
    setTimeout(() => {
      console.error('-> SIGTERM');
      child.kill('SIGTERM');
    }, o.sigtermAfter);
  }
  const [code, signal] = await new Promise<[number | null, string | null]>((res) =>
    child.on('close', (c, s) => res([c, s])),
  );
  handle(null);
  raw?.end();
  const r = result as ResultEvent | null;
  console.log(
    `exit code=${code} signal=${signal} result=${r ? `${r.subtype} session=${r.session_id}` : 'none'}`,
  );
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
