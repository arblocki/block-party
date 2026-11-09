import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import { appendHookEvent, readCapped } from './hook.js';

let root: string;
let runDir: string;
beforeEach(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'bp-hook-')));
  root = join(base, 'runs');
  runDir = join(root, 'r1');
  mkdirSync(runDir, { recursive: true });
});

const ok = (eventsPath: string, stdin: string | null) =>
  appendHookEvent({
    eventsPath,
    runsRoot: root,
    stdin,
    now: () => new Date('2026-01-02T03:04:05.000Z'),
  });

describe('appendHookEvent', () => {
  it('appends {ts,payload} lines', () => {
    const p = join(runDir, 'events.jsonl');
    expect(ok(p, '{"hook_event_name":"Stop"}')).toBeNull();
    expect(ok(p, '{"hook_event_name":"SessionEnd"}')).toBeNull();
    const lines = readFileSync(p, 'utf8').split('\n');
    expect(lines[0]).toBe('{"ts":"2026-01-02T03:04:05.000Z","payload":{"hook_event_name":"Stop"}}');
    expect(lines).toHaveLength(3);
  });

  it('refuses relative paths, wrong basename, and paths outside the runs root', () => {
    expect(ok('events.jsonl', '{}')).toMatch(/absolute/);
    expect(ok(join(runDir, 'other.jsonl'), '{}')).toMatch(/events\.jsonl/);
    const outside = join(root, '..', 'events.jsonl');
    expect(ok(outside, '{}')).toMatch(/outside/);
    expect(ok(join(root, 'events.jsonl'), '{}')).toMatch(/outside/);
    expect(ok(join(root, 'missing', 'events.jsonl'), '{}')).toMatch(/does not exist/);
  });

  it('refuses a directory symlinked out of the runs root', () => {
    const elsewhere = join(root, '..', 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(root, 'link'));
    expect(ok(join(root, 'link', 'events.jsonl'), '{}')).toMatch(/outside/);
  });

  it('does not follow an events.jsonl symlink out of the runs root', () => {
    const external = join(root, '..', 'external.txt');
    writeFileSync(external, 'orig');
    symlinkSync(external, join(runDir, 'events.jsonl'));
    expect(ok(join(runDir, 'events.jsonl'), '{}')).toMatch(/append failed/);
    expect(readFileSync(external, 'utf8')).toBe('orig');
  });

  it('drops non-object, invalid and oversized payloads', () => {
    const p = join(runDir, 'events.jsonl');
    expect(ok(p, '[1]')).toMatch(/not a JSON object/);
    expect(ok(p, 'null')).toMatch(/not a JSON object/);
    expect(ok(p, 'nope')).toMatch(/not valid JSON/);
    expect(ok(p, null)).toMatch(/1 MiB/);
    expect(() => readFileSync(p)).toThrow();
  });
});

describe('readCapped', () => {
  it('returns text, or null over the cap', async () => {
    expect(await readCapped(Readable.from(['ab', 'cd']), 10)).toBe('abcd');
    expect(await readCapped(Readable.from(['abcdef']), 5)).toBeNull();
  });
});
