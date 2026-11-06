import {
  ciRef,
  kebab,
  type RunStep,
  type Workflow,
  type WorkflowJob,
  type ParseWorkflowResult,
} from './workflows.js';

export interface ProposedCheck {
  name: string;
  run: string;
  /** Reference to the CI step this mirrors: `ci.yml#<job>/<step>`. */
  ci?: string;
  workingDirectory?: string;
  /** Why this proposal should not be accepted blindly. */
  needsReview?: string;
  /** Informational notes (e.g. matrix not expanded). */
  notes?: string[];
}

export interface ChecksProposal {
  /** `package-scripts` means no workflows were found, so CI parity cannot be measured. */
  source: 'workflows' | 'package-scripts';
  setup?: string;
  checks: ProposedCheck[];
  /** Workflow files (as `.github/workflows/<file>`) parity is measured against. */
  workflows: string[];
  warnings: string[];
}

const INSTALL_RE =
  /^(?:(?:pnpm|npm|yarn|bun)\s+(?:install|i|ci|add\s+-g\b.*)(?:\s|$)|yarn\s*$|corepack\s+(?:enable|prepare|use)\b|npm\s+(?:install|i)\s+-g\b|npx\s+(?:--yes\s+)?playwright\s+install\b)/;

function commandLines(command: string): string[] {
  return command
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

/** True when every line of the command is dependency-install or package-manager setup. */
export function isSetupCommand(command: string): boolean {
  const lines = commandLines(command);
  return lines.length > 0 && lines.every((l) => !/&&|\|\||[;|]/.test(l) && INSTALL_RE.test(l));
}

const DEPS_RE = /^(?:pnpm|npm|yarn|bun)\s+(?:install|i|ci)(?:\s|$)|^yarn\s*$/;

function extractSetup(command: string): string | undefined {
  return commandLines(command).find((l) => DEPS_RE.test(l));
}

export function hasExpression(command: string): boolean {
  return command.includes('${{');
}

function baseNameFor(step: RunStep): string {
  if (step.name) {
    const k = kebab(step.name);
    if (k) return k;
  }
  const first = commandLines(step.command)[0] ?? 'check';
  const runner = /^(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)/.exec(first);
  const raw = runner?.[1] ?? first.split(/\s+/).slice(0, 3).join(' ');
  return kebab(raw).slice(0, 40).replace(/-+$/, '') || 'check';
}

function uniqueName(base: string, used: Set<string>): string {
  let name = base;
  for (let n = 2; used.has(name); n++) name = `${base}-${n}`;
  used.add(name);
  return name;
}

function reviewReason(job: WorkflowJob, step: RunStep): string | undefined {
  if (hasExpression(step.command)) {
    return 'command contains a ${{ }} expression that cannot be evaluated locally';
  }
  if (step.condition !== undefined) return `step has a condition (if: ${step.condition})`;
  if (job.condition !== undefined) return `job has a condition (if: ${job.condition})`;
  return undefined;
}

/** Proposes checks from the PR-triggered jobs of the given workflows. */
export function proposeFromWorkflows(results: readonly ParseWorkflowResult[]): ChecksProposal {
  const warnings: string[] = [];
  const workflows: Workflow[] = [];
  for (const r of results) {
    if (r.ok) workflows.push(r.workflow);
    else warnings.push(`Could not parse ${r.file}: ${r.error}`);
  }
  const prWorkflows = workflows.filter((w) => w.runsOnPullRequest);
  for (const w of workflows) {
    if (!w.runsOnPullRequest) warnings.push(`Ignored ${w.file}: does not run on pull requests`);
  }
  const checks: ProposedCheck[] = [];
  const used = new Set<string>();
  let setup: string | undefined;
  for (const w of prWorkflows) {
    for (const job of w.jobs) {
      for (const step of job.steps) {
        if (step.kind !== 'run') continue;
        if (isSetupCommand(step.command)) {
          setup ??= extractSetup(step.command);
          continue;
        }
        const check: ProposedCheck = {
          name: uniqueName(baseNameFor(step), used),
          run: step.command,
          ci: ciRef(w, job, step),
        };
        if (step.workingDirectory) check.workingDirectory = step.workingDirectory;
        const reason = reviewReason(job, step);
        if (reason) check.needsReview = reason;
        const notes: string[] = [];
        if (job.matrixKeys.length > 0) {
          notes.push(
            `job runs a matrix (${job.matrixKeys.join(', ')}); only one configuration is proposed`,
          );
        } else if (job.matrixDynamic) {
          notes.push('job runs a dynamic matrix; only one configuration is proposed');
        }
        if (notes.length > 0) check.notes = notes;
        checks.push(check);
      }
    }
  }
  const proposal: ChecksProposal = {
    source: 'workflows',
    checks,
    workflows: prWorkflows.map((w) => `.github/workflows/${w.file}`),
    warnings,
  };
  if (setup) proposal.setup = setup;
  return proposal;
}

type PackageManager = 'pnpm' | 'yarn' | 'npm';

export function detectPackageManager(lockfiles: readonly string[]): PackageManager | undefined {
  const names = new Set(lockfiles.map((f) => f.split('/').pop()));
  if (names.has('pnpm-lock.yaml')) return 'pnpm';
  if (names.has('yarn.lock')) return 'yarn';
  if (names.has('package-lock.json')) return 'npm';
  return undefined;
}

const KNOWN_SCRIPTS = [
  'typecheck',
  'type-check',
  'lint',
  'format:check',
  'check',
  'test',
  'build',
] as const;

const SETUP: Record<PackageManager, string> = {
  pnpm: 'pnpm install --frozen-lockfile',
  yarn: 'yarn install --frozen-lockfile',
  npm: 'npm ci',
};

function scriptCommand(pm: PackageManager, script: string): string {
  if (pm === 'npm') return script === 'test' ? 'npm test' : `npm run ${script}`;
  return `${pm} ${script}`;
}

/** Fallback when there are no workflows: proposes checks from well-known package.json scripts. */
export function proposeFromPackageScripts(
  packageJsonText: string,
  lockfiles: readonly string[],
): ChecksProposal {
  const proposal: ChecksProposal = {
    source: 'package-scripts',
    checks: [],
    workflows: [],
    warnings: [],
  };
  let scripts: Record<string, unknown> = {};
  try {
    const pkg: unknown = JSON.parse(packageJsonText);
    const s =
      typeof pkg === 'object' && pkg !== null ? (pkg as { scripts?: unknown }).scripts : undefined;
    if (typeof s === 'object' && s !== null) scripts = s as Record<string, unknown>;
  } catch (err) {
    proposal.warnings.push(`Could not parse package.json: ${(err as Error).message}`);
    return proposal;
  }
  let pm = detectPackageManager(lockfiles);
  if (!pm) {
    proposal.warnings.push('No lockfile found; assuming npm');
    pm = 'npm';
  }
  proposal.setup = SETUP[pm];
  for (const script of KNOWN_SCRIPTS) {
    if (typeof scripts[script] !== 'string') continue;
    proposal.checks.push({ name: kebab(script), run: scriptCommand(pm, script) });
  }
  proposal.warnings.push('No GitHub Actions workflows found: CI parity cannot be measured');
  return proposal;
}

export interface ProposeInput {
  /** Parsed `.github/workflows/*` files. */
  workflows: readonly ParseWorkflowResult[];
  packageJson?: string;
  /** Repo-root lockfile names present. */
  lockfiles: readonly string[];
}

/** Workflows when they yield any check, else the package.json fallback. */
export function proposeChecks(input: ProposeInput): ChecksProposal {
  const fromWorkflows = proposeFromWorkflows(input.workflows);
  if (fromWorkflows.checks.length > 0) return fromWorkflows;
  if (input.packageJson === undefined) {
    return {
      ...fromWorkflows,
      warnings: [
        ...fromWorkflows.warnings,
        'No usable workflows or package.json to propose checks from',
      ],
    };
  }
  const fallback = proposeFromPackageScripts(input.packageJson, input.lockfiles);
  return { ...fallback, warnings: [...fromWorkflows.warnings, ...fallback.warnings] };
}
