import { useEffect, useState } from 'react';
import { api, ApiError, jsonBody } from '../api';
import { canStart, projectLabel, toRunRequest, type NewRunState } from '../lib/newRun';
import { HOME_HREF, runHref } from '../lib/route';
import type { Project, ValidatePlanResponse } from '../types';
import { TopBar } from './Home';
import { headingText, sectionHeading } from './RunEvidence';

const ADD = '__add__';
const DEBOUNCE_MS = 400;
const field =
  'w-full rounded-md border border-line bg-surface px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-accent';
const btn =
  'rounded-md border border-line bg-surface-elevated px-2.5 py-1 text-sm hover:bg-surface-hover disabled:opacity-50';

function errorList(err: unknown): string[] {
  if (err instanceof ApiError && Array.isArray(err.body.errors)) {
    return err.body.errors.filter((e): e is string => typeof e === 'string');
  }
  return [];
}

type Validation =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'done'; result: ValidatePlanResponse }
  | { state: 'error'; message: string };

/** The form behind `?new-run`: pick a project, paste a plan, start the run. */
export function NewRun() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [choice, setChoice] = useState('');
  const [addPath, setAddPath] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [baseRef, setBaseRef] = useState('');
  const [planText, setPlanText] = useState('');
  const [validation, setValidation] = useState<Validation>({ state: 'idle' });
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<'pane' | 'headless'>('pane');
  const [model, setModel] = useState('');
  const [publish, setPublish] = useState(true);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<{ message: string; errors: string[] } | null>(null);
  const [fileMsg, setFileMsg] = useState<string | null>(null);

  useEffect(() => {
    api<{ projects: Project[] }>('/api/projects').then(
      (r) => {
        setProjects(r.projects);
        if (r.projects.length === 0) setChoice(ADD);
      },
      (e: Error) => setLoadError(e.message),
    );
  }, []);

  const selectProject = (id: string, list: Project[] | null = projects) => {
    setChoice(id);
    const p = list?.find((x) => x.id === id);
    if (p) setBaseRef(p.defaultBase);
  };

  // Validate the plan once typing pauses; a stale answer never overwrites a newer one.
  useEffect(() => {
    if (planText.trim() === '') {
      setValidation({ state: 'idle' });
      return;
    }
    setValidation({ state: 'checking' });
    let current = true;
    const timer = setTimeout(() => {
      api<ValidatePlanResponse>('/api/plans/validate', {
        method: 'POST',
        ...jsonBody({ text: planText }),
      }).then(
        (result) => current && setValidation({ state: 'done', result }),
        (e: Error) => current && setValidation({ state: 'error', message: e.message }),
      );
    }, DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [planText]);

  const addProject = async () => {
    setAdding(true);
    setAddError(null);
    try {
      const { project } = await api<{ project: Project }>('/api/projects', {
        method: 'POST',
        ...jsonBody({ path: addPath.trim() }),
      });
      const list = [...(projects ?? []).filter((p) => p.id !== project.id), project];
      setProjects(list);
      selectProject(project.id, list);
      setAddPath('');
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  };

  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      setPlanText(await file.text());
      setFileMsg(null);
    } catch (e) {
      setFileMsg(`Could not read the file: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const state: NewRunState = {
    projectId: choice === ADD ? '' : choice,
    baseRef,
    planText,
    planValid: validation.state === 'done' && validation.result.ok,
    title,
    mode,
    model,
    publish,
  };
  const startable = canStart(state) && !starting;

  const start = async () => {
    setStarting(true);
    setStartError(null);
    try {
      const { runId } = await api<{ runId: string }>('/api/runs', {
        method: 'POST',
        ...jsonBody(toRunRequest(state)),
      });
      location.search = runHref(runId);
    } catch (e) {
      setStartError({
        message: e instanceof Error ? e.message : String(e),
        errors: errorList(e),
      });
      setStarting(false);
    }
  };

  const label = 'mb-1 block text-sm font-medium';
  const section = 'mb-6';

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <TopBar />
      <h1 className="mb-4 text-xl font-semibold">New run</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (startable) void start();
        }}
      >
        <section className={section}>
          <h2 className={sectionHeading}>Project</h2>
          {loadError && (
            <p className="mb-2 text-sm text-error" role="alert">
              Could not load projects: {loadError}
            </p>
          )}
          <label className={label} htmlFor="nr-project">
            Project
          </label>
          <select
            id="nr-project"
            className={field}
            value={choice}
            disabled={projects === null}
            onChange={(e) => selectProject(e.target.value)}
          >
            <option value="">{projects === null ? 'Loading…' : 'Select a project…'}</option>
            {(projects ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {projectLabel(p)}
              </option>
            ))}
            <option value={ADD}>Add a project…</option>
          </select>
          {choice === ADD && (
            <div className="mt-2">
              <label className={label} htmlFor="nr-path">
                Local path of the repository
              </label>
              <div className="flex gap-2">
                <input
                  id="nr-path"
                  className={field}
                  value={addPath}
                  placeholder="/Users/you/code/repo"
                  onChange={(e) => setAddPath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      if (addPath.trim() && !adding) void addProject();
                    }
                  }}
                />
                <button
                  type="button"
                  className={btn}
                  disabled={adding || addPath.trim() === ''}
                  onClick={() => void addProject()}
                >
                  {adding ? 'Adding…' : 'Add'}
                </button>
              </div>
              {addError && (
                <p className="mt-1 text-sm text-error" role="alert">
                  {addError}
                </p>
              )}
            </div>
          )}
        </section>

        <section className={section}>
          <h2 className={sectionHeading}>Base</h2>
          <label className={label} htmlFor="nr-base">
            Base ref
          </label>
          <input
            id="nr-base"
            className={field}
            value={baseRef}
            onChange={(e) => setBaseRef(e.target.value)}
          />
        </section>

        <section className={section}>
          <h2 className={sectionHeading}>Plan</h2>
          <label className={label} htmlFor="nr-plan">
            Plan (Markdown)
          </label>
          <textarea
            id="nr-plan"
            className={`${field} h-64 font-mono`}
            value={planText}
            onChange={(e) => setPlanText(e.target.value)}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <label htmlFor="nr-file" className="text-muted">
              Or load a file
            </label>
            <input
              id="nr-file"
              type="file"
              accept=".md,text/markdown"
              onChange={(e) => {
                void loadFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </div>
          {fileMsg && (
            <p className="mt-1 text-sm text-error" role="alert">
              {fileMsg}
            </p>
          )}
          <div className="mt-3" aria-live="polite">
            {validation.state === 'checking' && <p className="text-sm text-muted">Checking…</p>}
            {validation.state === 'error' && (
              <p className="text-sm text-error">
                Could not validate the plan: {validation.message}
              </p>
            )}
            {validation.state === 'done' && validation.result.ok && (
              <div className="rounded-md border border-line px-3 py-2">
                <p className="font-medium">{validation.result.title}</p>
                <p className={`mt-2 ${headingText}`}>Acceptance criteria</p>
                <ul className="list-disc pl-5 text-sm">
                  {validation.result.acceptanceCriteria.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>
            )}
            {validation.state === 'done' && !validation.result.ok && (
              <div className="rounded-md bg-error-soft px-3 py-2 text-sm text-error" role="alert">
                <p className="font-medium">This plan is not valid:</p>
                <ul className="list-disc pl-5">
                  {validation.result.errors.map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>

        <section className={section}>
          <h2 className={sectionHeading}>Options</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className={label} htmlFor="nr-title">
                Title (optional)
              </label>
              <input
                id="nr-title"
                className={field}
                value={title}
                placeholder="Defaults to the plan title"
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div>
              <label className={label} htmlFor="nr-mode">
                Mode
              </label>
              <select
                id="nr-mode"
                className={field}
                value={mode}
                onChange={(e) => setMode(e.target.value === 'headless' ? 'headless' : 'pane')}
              >
                <option value="pane">pane</option>
                <option value="headless">headless</option>
              </select>
            </div>
            <div>
              <label className={label} htmlFor="nr-model">
                Model (optional)
              </label>
              <input
                id="nr-model"
                className={field}
                value={model}
                placeholder="Default"
                onChange={(e) => setModel(e.target.value)}
              />
            </div>
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={publish}
              onChange={(e) => setPublish(e.target.checked)}
            />
            Open a draft PR at the end
          </label>
        </section>

        {startError && (
          <div className="mb-3 rounded-md bg-error-soft px-3 py-2 text-sm text-error" role="alert">
            <p>{startError.message}</p>
            {startError.errors.length > 0 && (
              <ul className="list-disc pl-5">
                {startError.errors.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            disabled={!startable}
          >
            {starting ? 'Starting…' : 'Start run'}
          </button>
          <a href={HOME_HREF} className="text-sm text-muted hover:underline">
            Cancel
          </a>
        </div>
      </form>
    </div>
  );
}
