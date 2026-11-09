import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeSpawn, type FakeProc } from '../llm/fake-spawn.testutil.js';
import { reviewWithCodex, type ReviewWithCodexOptions } from './codex-reviewer.js';

const SHA = 'a'.repeat(40);

function finding(over: Record<string, unknown> = {}) {
  return {
    id: 'f_1',
    reviewedSha: SHA,
    severity: 'P1',
    category: 'correctness',
    title: 'Bug',
    body: 'Broken',
    location: { path: 'src/a.ts', startLine: 1, endLine: 2 },
    confidence: 'high',
    suggestedFix: null,
    ...over,
  };
}
const output = (findings: unknown[]) =>
  JSON.stringify({ reviewedSha: SHA, summary: 's', findings });

const completed = '{"type":"turn.completed","usage":{"input_tokens":5}}\n';

function proc(text: string, extra = completed): (c: { args: string[] }) => FakeProc {
  return (c) => ({
    stdout: extra,
    onRun: async () => {
      await writeFile(c.args[c.args.indexOf('--output-last-message') + 1]!, text);
    },
  });
}

async function setup(overrides: Partial<ReviewWithCodexOptions> = {}) {
  const worktree = await mkdtemp(join(tmpdir(), 'bp-wt-'));
  await mkdir(join(worktree, 'src'));
  await writeFile(join(worktree, 'src/a.ts'), 'one\ntwo\nthree\n');
  const outDir = await mkdtemp(join(tmpdir(), 'bp-out-'));
  const base = {
    worktree,
    baseSha: 'b'.repeat(40),
    headSha: SHA,
    planPath: 'plan.md',
    priorFindings: [],
    outDir,
    round: 3,
    codexHome: '/tmp/chome',
    git: { headSha: async () => SHA, isClean: async () => true },
  };
  return { ...base, ...overrides };
}

describe('reviewWithCodex', () => {
  it('happy path normalizes and writes findings.json', async () => {
    const o = await setup();
    const fs = fakeSpawn(proc(output([finding(), finding({ id: 'f_1' })])));
    const r = await reviewWithCodex({ ...o, spawnFn: fs.spawnFn });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.output.findings.map((f) => f.id)).toEqual(['f_3_1', 'f_3_2']);
    expect(r.usage).toEqual({ input_tokens: 5 });
    expect(r.attempts).toBe(1);
    const c = fs.calls[0]!;
    expect(c.cwd).toBe(o.worktree);
    expect(c.args).toContain('--output-schema');
    expect(c.args.at(-1)).toBe('-');
    expect(c.stdin).toContain(SHA);
    expect(JSON.parse(await readFile(join(o.outDir, 'findings.json'), 'utf8')).reviewedSha).toBe(
      SHA,
    );
    await readFile(join(o.outDir, 'events.jsonl'), 'utf8');
  });

  it('fails on turn.failed', async () => {
    const o = await setup();
    const fs = fakeSpawn(proc(output([]), '{"type":"turn.failed","error":{"message":"boom"}}\n'));
    const r = await reviewWithCodex({ ...o, spawnFn: fs.spawnFn });
    expect(r).toMatchObject({ ok: false, attempts: 1 });
    expect(!r.ok && r.error).toContain('boom');
  });

  it('fails without turn.completed', async () => {
    const o = await setup();
    const fs = fakeSpawn(proc(output([]), ''));
    const r = await reviewWithCodex({ ...o, spawnFn: fs.spawnFn });
    expect(r.ok).toBe(false);
  });

  it('retries once after invalid JSON, keeping attempt 1 files', async () => {
    const o = await setup();
    let n = 0;
    const fs = fakeSpawn((c) => proc(n++ === 0 ? 'nope' : output([]))(c));
    const r = await reviewWithCodex({ ...o, spawnFn: fs.spawnFn });
    expect(r).toMatchObject({ ok: true, attempts: 2 });
    expect(fs.calls[1]!.stdin).toContain('Your previous output was rejected');
    await readFile(join(o.outDir, 'events-2.jsonl'), 'utf8');
    await readFile(join(o.outDir, 'prompt-2.md'), 'utf8');
  });

  it('fails when invalid twice', async () => {
    const o = await setup();
    const fs = fakeSpawn(proc('nope'));
    const r = await reviewWithCodex({ ...o, spawnFn: fs.spawnFn });
    expect(r).toMatchObject({ ok: false, attempts: 2 });
    expect(fs.calls).toHaveLength(2);
  });

  it('rejects a reviewedSha mismatch', async () => {
    const o = await setup();
    const bad = JSON.stringify({ reviewedSha: 'c'.repeat(40), summary: 's', findings: [] });
    const r = await reviewWithCodex({ ...o, spawnFn: fakeSpawn(proc(bad)).spawnFn });
    expect(r).toMatchObject({ ok: false, attempts: 2 });
  });

  it('refuses to run on HEAD mismatch or dirty worktree', async () => {
    const o = await setup();
    const fs = fakeSpawn(proc(output([])));
    const r1 = await reviewWithCodex({
      ...o,
      spawnFn: fs.spawnFn,
      git: { headSha: async () => 'd'.repeat(40), isClean: async () => true },
    });
    const r2 = await reviewWithCodex({
      ...o,
      spawnFn: fs.spawnFn,
      git: { headSha: async () => SHA, isClean: async () => false },
    });
    expect(r1).toMatchObject({ ok: false, attempts: 0 });
    expect(r2).toMatchObject({ ok: false, attempts: 0 });
    expect(fs.calls).toHaveLength(0);
  });

  it('normalizes paths and nulls bad locations', async () => {
    const o = await setup();
    const loc = (path: string, s = 1, e = 1) => ({ path, startLine: s, endLine: e });
    const fs = fakeSpawn(
      proc(
        output([
          finding({ location: loc(`${o.worktree}/src/a.ts`, 2, 3) }),
          finding({ location: loc('./src/a.ts') }),
          finding({ location: loc('src/missing.ts') }),
          finding({ location: loc('src/a.ts', 9, 9) }),
          finding({ location: loc('src/a.ts', 3, 2) }),
          finding({ location: loc('../etc/passwd') }),
          finding({ location: loc('/etc/passwd') }),
        ]),
      ),
    );
    const r = await reviewWithCodex({ ...o, spawnFn: fs.spawnFn });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const f = r.output.findings;
    expect(f[0]!.location).toEqual(loc('src/a.ts', 2, 3));
    expect(f[1]!.location?.path).toBe('src/a.ts');
    for (const x of f.slice(2)) {
      expect(x.location).toBeNull();
      expect(x.body).toContain('(reported location:');
    }
    expect(f[2]!.body).toContain('src/missing.ts:1-1');
  });

  it('sets CODEX_HOME and strips tokens', async () => {
    const o = await setup();
    process.env.GITHUB_TOKEN = 'x';
    process.env.GH_TOKEN = 'y';
    try {
      const fs = fakeSpawn(proc(output([])));
      await reviewWithCodex({ ...o, spawnFn: fs.spawnFn, model: 'm1' });
      const c = fs.calls[0]!;
      expect(c.env?.CODEX_HOME).toBe('/tmp/chome');
      expect(c.env).not.toHaveProperty('GITHUB_TOKEN');
      expect(c.env).not.toHaveProperty('GH_TOKEN');
      expect(c.args).toContain('m1');
    } finally {
      delete process.env.GITHUB_TOKEN;
      delete process.env.GH_TOKEN;
    }
  });
});
