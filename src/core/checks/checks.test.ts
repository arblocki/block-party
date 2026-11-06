import { describe, expect, it } from 'vitest';
import { parseChecksConfig, renderChecksYaml } from './config.js';
import { detectDrift } from './drift.js';
import {
  isSetupCommand,
  proposeChecks,
  proposeFromPackageScripts,
  proposeFromWorkflows,
} from './propose.js';
import { parseWorkflow } from './workflows.js';

const CI = `
name: CI
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
jobs:
  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: Typecheck
        run: pnpm typecheck
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: corepack enable
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
        working-directory: web
  test:
    needs: [typecheck]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/cache@v4
      - run: pnpm install --frozen-lockfile
      - name: Unit tests
        run: pnpm test
`;

const wf = (file: string, text: string) => parseWorkflow(file, text);

describe('parseWorkflow', () => {
  it('parses jobs, steps, needs and working-directory', () => {
    const r = wf('.github/workflows/ci.yml', CI);
    if (!r.ok) throw new Error(r.error);
    expect(r.workflow.file).toBe('ci.yml');
    expect(r.workflow.runsOnPullRequest).toBe(true);
    expect(r.workflow.jobs.map((j) => j.id)).toEqual(['typecheck', 'lint', 'test']);
    expect(r.workflow.jobs[2]?.needs).toEqual(['typecheck']);
    const lint = r.workflow.jobs[1]?.steps.find(
      (s) => s.kind === 'run' && s.command === 'pnpm lint',
    );
    expect(lint).toMatchObject({ workingDirectory: 'web', index: 3 });
  });

  it.each([
    ['on: pull_request', true],
    ['on: [push, pull_request]', true],
    ['on:\n  pull_request_target:\n    types: [opened]', true],
    ['on: push', false],
    ['on:\n  push:\n    branches: [main]\n  schedule:\n    - cron: "0 0 * * *"', false],
  ])('trigger %j -> %s', (on, expected) => {
    const r = wf('x.yml', `${on}\njobs:\n  a:\n    steps:\n      - run: echo hi\n`);
    expect(r.ok && r.workflow.runsOnPullRequest).toBe(expected);
  });

  it('records matrix keys without expanding and job-level if', () => {
    const r = wf(
      'm.yml',
      `
on: pull_request
jobs:
  test:
    if: github.actor != 'dependabot[bot]'
    strategy:
      matrix:
        node: [20, 22]
        os: [ubuntu-latest, macos-latest]
    steps:
      - run: npm test
  dyn:
    strategy:
      matrix: \${{ fromJSON(needs.x.outputs.m) }}
    steps:
      - run: npm test
`,
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.workflow.jobs[0]).toMatchObject({
      matrixKeys: ['node', 'os'],
      condition: "github.actor != 'dependabot[bot]'",
    });
    expect(r.workflow.jobs[1]).toMatchObject({ matrixDynamic: true, matrixKeys: [] });
  });

  it('returns an error result for invalid or non-workflow YAML', () => {
    const bad = wf('bad.yml', 'on: [pull_request\njobs: {');
    expect(bad).toMatchObject({ ok: false, file: 'bad.yml' });
    expect(wf('s.yml', 'just a string')).toMatchObject({ ok: false });
    expect(wf('n.yml', 'on: push')).toMatchObject({ ok: false });
    expect(wf('e.yml', '')).toMatchObject({ ok: false });
  });
});

describe('isSetupCommand', () => {
  it.each([
    'pnpm install',
    'npm ci',
    'yarn install --frozen-lockfile',
    'corepack enable',
    'yarn',
    'corepack enable\npnpm i --frozen-lockfile',
  ])('%j is setup', (c) => expect(isSetupCommand(c)).toBe(true));
  it.each([
    'pnpm test',
    'npm run build',
    'pnpm install && pnpm test',
    'corepack enable\npnpm lint',
  ])('%j is not setup', (c) => expect(isSetupCommand(c)).toBe(false));
});

describe('proposeFromWorkflows', () => {
  it('proposes one check per meaningful run step and lifts install into setup', () => {
    const p = proposeFromWorkflows([wf('ci.yml', CI)]);
    expect(p.source).toBe('workflows');
    expect(p.setup).toBe('pnpm install --frozen-lockfile');
    expect(p.checks).toEqual([
      { name: 'typecheck', run: 'pnpm typecheck', ci: 'ci.yml#typecheck/typecheck' },
      { name: 'lint', run: 'pnpm lint', ci: 'ci.yml#lint/3', workingDirectory: 'web' },
      { name: 'unit-tests', run: 'pnpm test', ci: 'ci.yml#test/unit-tests' },
    ]);
    expect(p.workflows).toEqual(['.github/workflows/ci.yml']);
  });

  it('ignores workflows that do not run on pull requests', () => {
    const push = `on:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    steps:\n      - run: ./deploy.sh\n`;
    const p = proposeFromWorkflows([wf('release.yml', push), wf('ci.yml', CI)]);
    expect(p.checks.map((c) => c.ci)).not.toContain(expect.stringContaining('release.yml'));
    expect(p.warnings).toContain('Ignored release.yml: does not run on pull requests');
  });

  it('flags ${{ }} commands and conditional jobs for review', () => {
    const p = proposeFromWorkflows([
      wf(
        'ci.yml',
        `on: pull_request
jobs:
  e2e:
    if: github.event.pull_request.draft == false
    steps:
      - run: pnpm e2e --shard \${{ matrix.shard }}
      - run: pnpm lint
`,
      ),
    ]);
    expect(p.checks[0]?.needsReview).toContain('${{ }}');
    expect(p.checks[1]?.needsReview).toContain('job has a condition');
    const yaml = renderChecksYaml(p);
    expect(yaml).toContain('# NEEDS REVIEW');
    expect(parseChecksConfig(yaml)?.required).toEqual([]);
  });

  it('keeps a multi-line run block as one check', () => {
    const p = proposeFromWorkflows([
      wf(
        'ci.yml',
        `on: pull_request
jobs:
  build:
    steps:
      - name: Build and verify
        run: |
          pnpm build
          test -f dist/cli/index.js
`,
      ),
    ]);
    expect(p.checks).toHaveLength(1);
    expect(p.checks[0]?.run).toBe('pnpm build\ntest -f dist/cli/index.js');
    const parsed = parseChecksConfig(renderChecksYaml(p));
    expect(parsed?.required[0]?.run).toBe('pnpm build\ntest -f dist/cli/index.js');
  });

  it('notes matrix jobs and dedupes names', () => {
    const p = proposeFromWorkflows([
      wf(
        'ci.yml',
        `on: pull_request
jobs:
  a:
    strategy:
      matrix:
        node: [20, 22]
    steps:
      - run: npm test
  b:
    steps:
      - run: npm test
`,
      ),
    ]);
    expect(p.checks.map((c) => c.name)).toEqual(['test', 'test-2']);
    expect(p.checks[0]?.notes?.[0]).toContain('matrix (node)');
    expect(renderChecksYaml(p)).toContain('# job runs a matrix (node)');
  });

  it('reports unparseable workflows as warnings', () => {
    const p = proposeFromWorkflows([wf('bad.yml', 'on: [')]);
    expect(p.checks).toEqual([]);
    expect(p.warnings[0]).toMatch(/^Could not parse bad\.yml/);
  });
});

const THIS_REPO_PKG = JSON.stringify({
  scripts: {
    dev: 'concurrently ...',
    build: 'vite build',
    lint: 'eslint .',
    format: 'prettier --write .',
    typecheck: 'tsc -p tsconfig.test.json',
    test: 'vitest run',
  },
});

describe('package.json fallback', () => {
  it('proposes known scripts with the detected package manager', () => {
    const p = proposeFromPackageScripts(THIS_REPO_PKG, ['pnpm-lock.yaml']);
    expect(p.source).toBe('package-scripts');
    expect(p.setup).toBe('pnpm install --frozen-lockfile');
    expect(p.checks).toEqual([
      { name: 'typecheck', run: 'pnpm typecheck' },
      { name: 'lint', run: 'pnpm lint' },
      { name: 'test', run: 'pnpm test' },
      { name: 'build', run: 'pnpm build' },
    ]);
    expect(p.warnings.join()).toContain('CI parity cannot be measured');
  });

  it('uses npm and yarn conventions', () => {
    const pkg = JSON.stringify({ scripts: { test: 'x', lint: 'y', 'format:check': 'z' } });
    const npm = proposeFromPackageScripts(pkg, ['package-lock.json']);
    expect(npm.setup).toBe('npm ci');
    expect(npm.checks.map((c) => c.run)).toEqual([
      'npm run lint',
      'npm run format:check',
      'npm test',
    ]);
    expect(npm.checks[1]?.name).toBe('format-check');
    expect(proposeFromPackageScripts(pkg, ['yarn.lock']).checks[0]?.run).toBe('yarn lint');
  });

  it('warns on invalid package.json and missing lockfile', () => {
    expect(proposeFromPackageScripts('{', []).warnings[0]).toMatch(/Could not parse package.json/);
    expect(proposeFromPackageScripts(THIS_REPO_PKG, []).setup).toBe('npm ci');
  });

  it('proposeChecks falls back when there are no workflows', () => {
    const p = proposeChecks({
      workflows: [],
      packageJson: THIS_REPO_PKG,
      lockfiles: ['pnpm-lock.yaml'],
    });
    expect(p.source).toBe('package-scripts');
    const yaml = renderChecksYaml(p);
    expect(yaml).toContain('CI parity cannot be measured');
    expect(parseChecksConfig(yaml)?.required.map((c) => c.name)).toEqual([
      'typecheck',
      'lint',
      'test',
      'build',
    ]);
    expect(proposeChecks({ workflows: [], lockfiles: [] }).warnings.join()).toContain('No usable');
  });
});

describe('config', () => {
  it('round-trips a workflow proposal', () => {
    const p = proposeFromWorkflows([wf('ci.yml', CI)]);
    const parsed = parseChecksConfig(renderChecksYaml(p));
    expect(parsed?.setup).toBe('pnpm install --frozen-lockfile');
    expect(parsed?.required[1]).toEqual({
      name: 'lint',
      run: 'pnpm lint',
      ci: 'ci.yml#lint/3',
      cwd: 'web',
    });
    expect(parsed?.ciParity).toEqual({ workflows: ['.github/workflows/ci.yml'], ignore: [] });
  });

  it('returns undefined without a checks section and throws readable errors', () => {
    expect(parseChecksConfig('rules: []')).toBeUndefined();
    expect(parseChecksConfig('')).toBeUndefined();
    expect(() => parseChecksConfig('checks:\n  required:\n    - { name: a }')).toThrow(
      /checks\.required\.0\.run/,
    );
    expect(() => parseChecksConfig('checks: [')).toThrow(/invalid YAML/);
  });
});

describe('detectDrift', () => {
  const results = [
    wf('ci.yml', CI),
    wf(
      'e2e.yml',
      `on: pull_request\njobs:\n  e2e:\n    steps:\n      - run: pnpm install\n      - run: pnpm e2e\n  deploy-preview:\n    steps:\n      - run: ./deploy-preview.sh\n`,
    ),
    wf('release.yml', `on: push\njobs:\n  publish:\n    steps:\n      - run: npm publish\n`),
  ];

  it('reports missing CI steps, skipping setup, non-PR workflows and ignored jobs', () => {
    const config = parseChecksConfig(`
checks:
  required:
    - { name: typecheck, run: pnpm typecheck, ci: "ci.yml#typecheck" }
    - { name: lint, run: pnpm lint, ci: "ci.yml#lint/3" }
    - { name: test, run: pnpm test, ci: "ci.yml#test/unit-tests" }
  ciParity:
    ignore: [deploy-preview]
`);
    if (!config) throw new Error('no config');
    const d = detectDrift(config, results);
    expect(d.missing.map((m) => m.ref)).toEqual(['e2e.yml#e2e/1']);
    expect(d.stale).toEqual([]);
  });

  it('reports stale refs (missing file, job, or step)', () => {
    const config = parseChecksConfig(`
checks:
  required:
    - { name: a, run: x, ci: "ci.yml#typecheck/typecheck" }
    - { name: b, run: x, ci: "ci.yml#gone" }
    - { name: c, run: x, ci: "ci.yml#lint/nope" }
    - { name: d, run: x, ci: "old.yml#lint" }
    - { name: e, run: x }
  ciParity:
    workflows: [.github/workflows/ci.yml]
`);
    if (!config) throw new Error('no config');
    const d = detectDrift(config, results);
    expect(d.stale.map((s) => s.check)).toEqual(['b', 'c', 'd']);
    // e2e.yml is out of scope, so only ci.yml's unmapped steps are missing
    expect(d.missing.map((m) => m.ref)).toEqual(['ci.yml#lint/3', 'ci.yml#test/unit-tests']);
  });

  it('honors ignore by full step ref and file#job, and warns about parse errors', () => {
    const config = parseChecksConfig(`
checks:
  required: []
  ciParity:
    ignore: ["ci.yml#test", "ci.yml#lint/3", "e2e.yml#e2e/1", "deploy-preview"]
`);
    if (!config) throw new Error('no config');
    const d = detectDrift(config, [...results, wf('bad.yml', 'on: [')]);
    expect(d.missing.map((m) => m.ref)).toEqual(['ci.yml#typecheck/typecheck']);
    expect(d.warnings[0]).toMatch(/bad\.yml/);
  });
});

describe('fix round 1 regressions', () => {
  it('round-trips commands with commas, braces, brackets, colons, quotes and #', () => {
    const runs = [
      'echo a,b',
      'echo {foo}',
      'echo [x, y]',
      'echo "a: b" # c',
      "echo 'it''s' && echo {a,b}",
      'node -e "console.log({a:1})"',
      'printf a\nprintf b,c',
    ];
    const p = {
      source: 'workflows' as const,
      workflows: [],
      warnings: [],
      checks: runs.map((run, i) => ({
        name: `c${i}`,
        run,
        ci: `ci.yml#j/${i}`,
        workingDirectory: 'a, b: {c}',
      })),
    };
    const parsed = parseChecksConfig(renderChecksYaml(p));
    expect(parsed?.required.map((c) => c.run)).toEqual(runs);
    expect(parsed?.required.every((c) => c.cwd === 'a, b: {c}')).toBe(true);
    expect(parsed?.required).toHaveLength(runs.length);
  });

  it('resolves working-directory: step > job defaults > workflow defaults', () => {
    const r = wf(
      'ci.yml',
      `on: pull_request
defaults:
  run:
    working-directory: root
jobs:
  a:
    steps:
      - run: npm test
  b:
    defaults:
      run:
        working-directory: packages/b
    steps:
      - run: npm test
      - run: npm run lint
        working-directory: other
`,
    );
    const p = proposeFromWorkflows([r]);
    expect(p.checks.map((c) => c.workingDirectory)).toEqual(['root', 'packages/b', 'other']);
  });

  it('flags expression working directories for review', () => {
    const p = proposeFromWorkflows([
      wf(
        'ci.yml',
        `on: pull_request
jobs:
  a:
    defaults:
      run:
        working-directory: \${{ matrix.pkg }}
    steps:
      - run: npm test
`,
      ),
    ]);
    expect(p.checks[0]?.needsReview).toContain('working directory');
  });

  it('does not emit guarded or expression install commands as active setup', () => {
    const expr = proposeFromWorkflows([
      wf(
        'ci.yml',
        `on: pull_request\njobs:\n  a:\n    steps:\n      - run: npm ci --prefix \${{ matrix.package }}\n      - run: npm test\n`,
      ),
    ]);
    expect(expr.setup).toBeUndefined();
    expect(expr.setupNeedsReview?.reason).toContain('${{ }}');
    const yaml = renderChecksYaml(expr);
    expect(yaml).toContain('# NEEDS REVIEW');
    expect(parseChecksConfig(yaml)?.setup).toBeUndefined();

    const guarded = proposeFromWorkflows([
      wf(
        'ci.yml',
        `on: pull_request\njobs:\n  a:\n    steps:\n      - if: github.ref == 'refs/heads/main'\n        run: npm ci\n      - run: npm test\n`,
      ),
    ]);
    expect(guarded.setup).toBeUndefined();
    expect(guarded.setupNeedsReview?.reason).toContain('condition');

    const jobGuarded = proposeFromWorkflows([
      wf(
        'ci.yml',
        `on: pull_request\njobs:\n  a:\n    if: false\n    steps:\n      - run: npm ci\n  b:\n    steps:\n      - run: yarn install --frozen-lockfile\n`,
      ),
    ]);
    expect(jobGuarded.setup).toBe('yarn install --frozen-lockfile');
  });
});
