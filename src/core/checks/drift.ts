import type { ChecksConfig } from './config.js';
import { isSetupCommand } from './propose.js';
import { ciRef, stepKey, type ParseWorkflowResult, type Workflow } from './workflows.js';

export interface DriftReport {
  /** CI run-steps with no local check and no ignore entry (`ci` ref form). */
  missing: { ref: string; name?: string; command: string }[];
  /** Configured `ci` refs that no longer exist in the workflows. */
  stale: { check: string; ref: string }[];
  warnings: string[];
}

function inScope(w: Workflow, scope: readonly string[]): boolean {
  if (scope.length === 0) return w.runsOnPullRequest;
  return scope.some((p) => p.split('/').pop() === w.file);
}

function splitRef(ref: string): { file: string; job: string; step?: string } | undefined {
  const hash = ref.indexOf('#');
  if (hash <= 0) return undefined;
  const rest = ref.slice(hash + 1);
  const slash = rest.indexOf('/');
  const job = slash === -1 ? rest : rest.slice(0, slash);
  if (!job) return undefined;
  return slash === -1
    ? { file: ref.slice(0, hash), job }
    : { file: ref.slice(0, hash), job, step: rest.slice(slash + 1) };
}

/**
 * Compares the configured checks with the workflows. `ignore` entries are a job id, `file#job`,
 * or a full step ref. A `ci` ref without a step covers every run step of that job.
 */
export function detectDrift(
  config: ChecksConfig,
  results: readonly ParseWorkflowResult[],
): DriftReport {
  const report: DriftReport = { missing: [], stale: [], warnings: [] };
  const all: Workflow[] = [];
  for (const r of results) {
    if (r.ok) all.push(r.workflow);
    else report.warnings.push(`Could not parse ${r.file}: ${r.error}`);
  }
  const scope = config.ciParity?.workflows ?? [];
  const workflows = all.filter((w) => inScope(w, scope));
  const ignore = new Set(config.ciParity?.ignore ?? []);
  const checks = [...config.required, ...(config.optional ?? [])];
  const refs = checks.flatMap((c) =>
    c.ci ? [{ check: c.name, ref: c.ci, parts: splitRef(c.ci) }] : [],
  );

  for (const r of refs) {
    const p = r.parts;
    const wf = p ? all.find((w) => w.file === p.file) : undefined;
    const job = p && wf ? wf.jobs.find((j) => j.id === p.job) : undefined;
    const ok =
      p !== undefined &&
      job !== undefined &&
      (p.step === undefined ||
        job.steps.some(
          (s) => s.kind === 'run' && (String(s.index) === p.step || stepKey(job, s) === p.step),
        ));
    if (!ok) report.stale.push({ check: r.check, ref: r.ref });
  }

  for (const w of workflows) {
    for (const job of w.jobs) {
      for (const step of job.steps) {
        if (step.kind !== 'run' || isSetupCommand(step.command)) continue;
        const ref = ciRef(w, job, step);
        const jobRef = `${w.file}#${job.id}`;
        if (ignore.has(job.id) || ignore.has(jobRef) || ignore.has(ref)) continue;
        const covered = refs.some((r) => {
          const p = r.parts;
          if (!p || p.file !== w.file || p.job !== job.id) return false;
          return (
            p.step === undefined || p.step === String(step.index) || p.step === stepKey(job, step)
          );
        });
        if (covered) continue;
        report.missing.push({
          ref,
          ...(step.name ? { name: step.name } : {}),
          command: step.command,
        });
      }
    }
  }
  return report;
}
