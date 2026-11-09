import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_CONFIG_FILES } from '../risk/repo-config.js';
import { parseChecksConfig, type ChecksConfig } from './config.js';
import { detectDrift, type DriftReport } from './drift.js';
import { proposeChecks, type ChecksProposal } from './propose.js';
import { parseWorkflow, type ParseWorkflowResult } from './workflows.js';

const LOCKFILES = [
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
  'bun.lock',
  'bun.lockb',
] as const;

export interface ProjectChecks {
  config: ChecksConfig | undefined;
  proposal: ChecksProposal;
  /** Only computed when `config` exists. */
  drift: DriftReport | undefined;
  /** True when at least one PR-triggered workflow was parsed. */
  parityMeasurable: boolean;
  errors: string[];
}

function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/** Reads the project's checks config, workflows, lockfiles and package.json from disk. */
export function loadProjectChecks(dir: string): ProjectChecks {
  const errors: string[] = [];

  let config: ChecksConfig | undefined;
  for (const file of REPO_CONFIG_FILES) {
    let text: string | undefined;
    try {
      text = readIfExists(join(dir, file));
    } catch (err) {
      errors.push(`Could not read ${file}: ${(err as Error).message}`);
      break;
    }
    if (text === undefined) continue;
    try {
      config = parseChecksConfig(text);
    } catch (err) {
      errors.push(`${file}: ${(err as Error).message}`);
    }
    break;
  }

  const workflows: ParseWorkflowResult[] = [];
  const wfDir = join(dir, '.github', 'workflows');
  let names: string[] = [];
  try {
    names = readdirSync(wfDir)
      .filter((n) => /\.ya?ml$/.test(n))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      errors.push(`Could not read .github/workflows: ${(err as Error).message}`);
    }
  }
  for (const name of names) {
    try {
      workflows.push(parseWorkflow(name, readFileSync(join(wfDir, name), 'utf8')));
    } catch (err) {
      errors.push(`Could not read .github/workflows/${name}: ${(err as Error).message}`);
    }
  }
  for (const w of workflows) if (!w.ok) errors.push(`${w.file}: ${w.error}`);

  const lockfiles = LOCKFILES.filter((f) => readIfExists(join(dir, f)) !== undefined);
  let packageJson: string | undefined;
  try {
    packageJson = readIfExists(join(dir, 'package.json'));
  } catch (err) {
    errors.push(`Could not read package.json: ${(err as Error).message}`);
  }

  const proposal = proposeChecks({
    workflows,
    lockfiles,
    ...(packageJson !== undefined ? { packageJson } : {}),
  });
  const drift = config ? detectDrift(config, workflows) : undefined;
  const parityMeasurable = workflows.some((w) => w.ok && w.workflow.runsOnPullRequest);
  return { config, proposal, drift, parityMeasurable, errors };
}
