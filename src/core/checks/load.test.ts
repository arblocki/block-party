import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProjectChecks } from './load.js';

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'bp-load-'));
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), t);
  }
  return dir;
}

const PKG = JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint .' } });
const CI = `
name: CI
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm test
      - run: pnpm lint
`;

describe('loadProjectChecks', () => {
  it('proposes from package scripts with no config or workflows', () => {
    const r = loadProjectChecks(repo({ 'package.json': PKG, 'pnpm-lock.yaml': '' }));
    expect(r.config).toBeUndefined();
    expect(r.drift).toBeUndefined();
    expect(r.parityMeasurable).toBe(false);
    expect(r.proposal.source).toBe('package-scripts');
    expect(r.proposal.setup).toBe('pnpm install --frozen-lockfile');
    expect(r.errors).toEqual([]);
  });

  it('proposes from workflows and computes drift when a config exists', () => {
    const r = loadProjectChecks(
      repo({
        'package.json': PKG,
        '.github/workflows/ci.yml': CI,
        '.block-party.yaml':
          'checks:\n  required:\n    - { name: test, run: pnpm test, ci: "ci.yml#test/1" }\n',
      }),
    );
    expect(r.proposal.source).toBe('workflows');
    expect(r.parityMeasurable).toBe(true);
    expect(r.config?.required).toHaveLength(1);
    expect(r.drift?.missing.length).toBeGreaterThan(0);
  });

  it('reads .block-party.yml and ignores other sections', () => {
    const r = loadProjectChecks(
      repo({
        '.block-party.yml': 'rules: []\nchecks:\n  required:\n    - { name: a, run: "true" }\n',
      }),
    );
    expect(r.config?.required[0]?.name).toBe('a');
  });

  it('reports invalid YAML and invalid workflows in errors', () => {
    const r = loadProjectChecks(
      repo({
        '.block-party.yaml': 'checks: [unclosed\n',
        '.github/workflows/bad.yml': 'jobs: [\n',
      }),
    );
    expect(r.config).toBeUndefined();
    expect(r.errors.some((e) => e.startsWith('.block-party.yaml: invalid YAML'))).toBe(true);
    expect(r.errors.some((e) => e.includes('bad.yml'))).toBe(true);
  });
});
