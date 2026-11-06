import { parse as parseYaml } from 'yaml';

export interface RunStep {
  kind: 'run';
  /** Position within the job's `steps` (0-based, counting every step). */
  index: number;
  name?: string;
  command: string;
  workingDirectory?: string;
  shell?: string;
  /** Step-level `if:` condition, as written. */
  condition?: string;
}

export interface UsesStep {
  kind: 'uses';
  index: number;
  name?: string;
  uses: string;
}

export type WorkflowStep = RunStep | UsesStep;

export interface WorkflowJob {
  id: string;
  name?: string;
  needs: string[];
  /** Job-level `if:` condition, as written. */
  condition?: string;
  /** Keys of `strategy.matrix` (not expanded). Empty when the job has no matrix. */
  matrixKeys: string[];
  /** True when the matrix is a `${{ fromJSON(...) }}` expression, so its keys are unknown. */
  matrixDynamic: boolean;
  steps: WorkflowStep[];
}

export interface Workflow {
  /** File name (basename), e.g. `ci.yml`. */
  file: string;
  name?: string;
  /** Triggers on `pull_request` or `pull_request_target`. */
  runsOnPullRequest: boolean;
  /** Trigger event names, e.g. ['push', 'pull_request']. */
  events: string[];
  jobs: WorkflowJob[];
}

export type ParseWorkflowResult =
  { ok: true; workflow: Workflow } | { ok: false; file: string; error: string };

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

function baseName(file: string): string {
  return file.split(/[\\/]/).pop() ?? file;
}

function triggerEvents(on: unknown): string[] {
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.filter((e): e is string => typeof e === 'string');
  if (isObj(on)) return Object.keys(on);
  return [];
}

function parseMatrix(strategy: unknown): { keys: string[]; dynamic: boolean } {
  if (!isObj(strategy)) return { keys: [], dynamic: false };
  const matrix = strategy['matrix'];
  if (typeof matrix === 'string') return { keys: [], dynamic: true };
  if (!isObj(matrix)) return { keys: [], dynamic: false };
  return { keys: Object.keys(matrix), dynamic: false };
}

function runDefaults(raw: unknown): { workingDirectory?: string; shell?: string } {
  if (!isObj(raw) || !isObj(raw['defaults'])) return {};
  const run = raw['defaults']['run'];
  if (!isObj(run)) return {};
  const out: { workingDirectory?: string; shell?: string } = {};
  const wd = str(run['working-directory']);
  if (wd !== undefined) out.workingDirectory = wd;
  const shell = str(run['shell']);
  if (shell !== undefined) out.shell = shell;
  return out;
}

type RunDefaults = ReturnType<typeof runDefaults>;

function parseStep(raw: unknown, index: number, defaults: RunDefaults): WorkflowStep | undefined {
  if (!isObj(raw)) return undefined;
  const name = str(raw['name']);
  const base = name !== undefined ? { name } : {};
  const run = raw['run'];
  if (typeof run === 'string') {
    const step: RunStep = { kind: 'run', index, ...base, command: run.trim() };
    // Effective values: step > job defaults.run > workflow defaults.run.
    const wd = str(raw['working-directory']) ?? defaults.workingDirectory;
    if (wd !== undefined) step.workingDirectory = wd;
    const shell = str(raw['shell']) ?? defaults.shell;
    if (shell !== undefined) step.shell = shell;
    const cond = str(raw['if']);
    if (cond !== undefined) step.condition = cond;
    return step;
  }
  const uses = str(raw['uses']);
  if (uses !== undefined) return { kind: 'uses', index, ...base, uses };
  return undefined;
}

function parseJob(id: string, raw: unknown, wfDefaults: RunDefaults): WorkflowJob | undefined {
  if (!isObj(raw)) return undefined;
  const needsRaw = raw['needs'];
  const needs =
    typeof needsRaw === 'string'
      ? [needsRaw]
      : Array.isArray(needsRaw)
        ? needsRaw.filter((n): n is string => typeof n === 'string')
        : [];
  const matrix = parseMatrix(raw['strategy']);
  const defaults = { ...wfDefaults, ...runDefaults(raw) };
  const steps: WorkflowStep[] = [];
  if (Array.isArray(raw['steps'])) {
    raw['steps'].forEach((s: unknown, i) => {
      const step = parseStep(s, i, defaults);
      if (step) steps.push(step);
    });
  }
  const job: WorkflowJob = {
    id,
    needs,
    matrixKeys: matrix.keys,
    matrixDynamic: matrix.dynamic,
    steps,
  };
  const name = str(raw['name']);
  if (name !== undefined) job.name = name;
  const cond = str(raw['if']);
  if (cond !== undefined) job.condition = cond;
  return job;
}

/** Parses GitHub Actions workflow YAML. Never throws on user content. */
export function parseWorkflow(file: string, text: string): ParseWorkflowResult {
  const name = baseName(file);
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    return {
      ok: false,
      file: name,
      error: `invalid YAML: ${(err as Error).message.split('\n')[0]}`,
    };
  }
  if (!isObj(raw))
    return { ok: false, file: name, error: 'not a workflow: expected a YAML mapping' };
  const jobsRaw = raw['jobs'];
  if (!isObj(jobsRaw))
    return { ok: false, file: name, error: 'not a workflow: missing `jobs` mapping' };
  // YAML 1.1 parsers read the bare key `on` as boolean true; accept both.
  const events = triggerEvents(raw['on'] ?? raw['true']);
  const jobs: WorkflowJob[] = [];
  for (const [id, j] of Object.entries(jobsRaw)) {
    const job = parseJob(id, j, runDefaults(raw));
    if (job) jobs.push(job);
  }
  const workflow: Workflow = {
    file: name,
    runsOnPullRequest: events.includes('pull_request') || events.includes('pull_request_target'),
    events,
    jobs,
  };
  const wfName = str(raw['name']);
  if (wfName !== undefined) workflow.name = wfName;
  return { ok: true, workflow };
}

export function kebab(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Stable key for a run step inside its job: the kebab-cased step name when it is non-empty and
 * unique among the job's run steps, otherwise the step index.
 */
export function stepKey(job: WorkflowJob, step: RunStep): string {
  const slug = step.name ? kebab(step.name) : '';
  if (!slug) return String(step.index);
  const clash = job.steps.some(
    (s) => s.kind === 'run' && s !== step && s.name && kebab(s.name) === slug,
  );
  return clash ? String(step.index) : slug;
}

/** `ci.yml#<job>/<step key>` */
export function ciRef(workflow: Workflow, job: WorkflowJob, step: RunStep): string {
  return `${workflow.file}#${job.id}/${stepKey(job, step)}`;
}
