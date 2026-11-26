import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunLog } from './events.js';

describe('RunLog', () => {
  it('appends JSON lines synchronously and echoes', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'bp-log-')), 'run');
    const echoed: string[] = [];
    const log = new RunLog(dir, {
      now: () => new Date(2026, 10, 8, 12, 1, 3),
      echo: (l) => echoed.push(l),
    });
    log.log('checks.passed', { name: 'typecheck', durationMs: 4200 });
    log.log('plain');
    const lines = readFileSync(join(dir, 'run-events.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    expect(first.type).toBe('checks.passed');
    expect(first.data.name).toBe('typecheck');
    expect(typeof first.ts).toBe('string');
    expect(echoed[0]).toBe('[12:01:03] checks.passed typecheck (4.2s)');
    expect(echoed[1]).toBe('[12:01:03] plain');
  });
});
