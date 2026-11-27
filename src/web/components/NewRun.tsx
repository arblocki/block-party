import { useEffect, useState } from 'react';
import { api, ApiError, jsonBody } from '../api';
import { canStart, MAX_DESCRIPTION_CHARS, toRunRequest, type NewRunState } from '../lib/newRun';
import { HOME_HREF, runHref } from '../lib/route';
import type { Project, ValidatePlanResponse } from '../types';
import { headingText, sectionHeading, TopBar } from './AppShell';
import { RepoChooser } from './RepoChooser';

const DEBOUNCE_MS = 400;
const field =
  'w-full rounded-md border border-line bg-surface px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-accent';

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

/** The form behind `?new-run`: choose a repo, say what to build, start the run. */
export function NewRun() {
  const [project, setProject] = useState<Project | null>(null);
  const [baseRef, setBaseRef] = useState('');
  const [source, setSource] = useState<'describe' | 'paste'>('describe');
  const [description, setDescription] = useState('');
  const [planText, setPlanText] = useState('');
  const [validation, setValidation] = useState<Validation>({ state: 'idle' });
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<'pane' | 'headless'>('pane');
  const [model, setModel] = useState('');
  const [publish, setPublish] = useState(true);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<{ message: string; errors: string[] } | null>(null);
  const [fileMsg, setFileMsg] = useState<string | null>(null);

  // Validate the plan once typing pauses; a stale answer never overwrites a newer one.
  useEffect(() => {
    if (source !== 'paste' || planText.trim() === '') {
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
  }, [planText, source]);

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
    projectId: project?.id ?? '',
    defaultBranch: project?.defaultBase ?? '',
    baseRef,
    source,
    description,
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
  const hint = 'mt-1 text-xs text-muted';
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
          <h2 className={sectionHeading}>Which repo?</h2>
          <RepoChooser
            onReady={(p) => {
              // A branch typed for one repo means nothing for another.
              if (p?.id !== project?.id) setBaseRef('');
              setProject(p);
            }}
          />
        </section>

        <section className={section}>
          <h2 className={sectionHeading}>What should it build?</h2>
          {source === 'describe' ? (
            <>
              <label className="sr-only" htmlFor="nr-description">
                What should it build?
              </label>
              <textarea
                id="nr-description"
                className={`${field} h-40`}
                value={description}
                maxLength={MAX_DESCRIPTION_CHARS}
                placeholder="Describe the change you want, in your own words."
                onChange={(e) => setDescription(e.target.value)}
              />
              <p className={hint}>
                A planner agent writes a plan first. Nothing is changed until you approve it.
              </p>
              <p className={hint}>
                {description.length} / {MAX_DESCRIPTION_CHARS}
              </p>
              <button
                type="button"
                className="mt-1 text-sm text-accent hover:underline"
                onClick={() => setSource('paste')}
              >
                I already have a plan
              </button>
            </>
          ) : (
            <>
              <label className={label} htmlFor="nr-plan">
                Your plan (Markdown)
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
                    Could not check the plan: {validation.message}
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
                  <div
                    className="rounded-md bg-error-soft px-3 py-2 text-sm text-error"
                    role="alert"
                  >
                    <p className="font-medium">This plan is not valid:</p>
                    <ul className="list-disc pl-5">
                      {validation.result.errors.map((m, i) => (
                        <li key={i}>{m}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
              <button
                type="button"
                className="mt-2 text-sm text-accent hover:underline"
                onClick={() => setSource('describe')}
              >
                Describe it instead
              </button>
            </>
          )}
        </section>

        <details className="mb-6 rounded-md border border-line px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">Advanced</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label className={label} htmlFor="nr-branch">
                Start from branch
              </label>
              <input
                id="nr-branch"
                className={field}
                value={baseRef}
                placeholder={project?.defaultBase ?? "The repo's default branch"}
                onChange={(e) => setBaseRef(e.target.value)}
              />
              <p className={hint}>The branch the new work starts from.</p>
            </div>
            <div>
              <label className={label} htmlFor="nr-title">
                Run title
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
              <label className={label} htmlFor="nr-model">
                Model
              </label>
              <input
                id="nr-model"
                className={field}
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
              <p className={hint}>Leave empty for the default.</p>
            </div>
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={mode === 'pane'}
              onChange={(e) => setMode(e.target.checked ? 'pane' : 'headless')}
            />
            Watch the agent in a terminal
          </label>
          <p className={hint}>Off runs it in the background.</p>
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={publish}
              onChange={(e) => setPublish(e.target.checked)}
            />
            Open a draft PR when done
          </label>
        </details>

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
