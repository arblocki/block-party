import type { StartRunRequest } from '../types';

/** The server accepts 1-20000 characters of description. */
export const MAX_DESCRIPTION_CHARS = 20000;

export interface NewRunState {
  /** The prepared project of the chosen repo; empty until the repo is ready. */
  projectId: string;
  /** The repo's default branch, known once the repo is ready. */
  defaultBranch: string;
  /** A branch typed under Advanced; blank means the default branch. */
  baseRef: string;
  /** Describe the feature for the planner, or paste a finished plan. */
  source: 'describe' | 'paste';
  description: string;
  planText: string;
  /** The plan text passed validation. */
  planValid: boolean;
  title: string;
  mode: 'pane' | 'headless';
  model: string;
  publish: boolean;
}

/** The branch the work starts from: the one typed under Advanced, else the repo's default. */
export const startBranch = (s: Pick<NewRunState, 'baseRef' | 'defaultBranch'>): string =>
  s.baseRef.trim() || s.defaultBranch.trim();

/** Start needs a ready repo, a start branch, and a description or a plan the server accepted. */
export function canStart(s: NewRunState): boolean {
  if (s.projectId === '' || startBranch(s) === '') return false;
  if (s.source === 'describe') {
    const d = s.description.trim();
    return d !== '' && d.length <= MAX_DESCRIPTION_CHARS;
  }
  return s.planText.trim() !== '' && s.planValid;
}

/** The POST /api/runs body: fields trimmed, blank optionals left out. */
export function toRunRequest(s: NewRunState): StartRunRequest {
  const title = s.title.trim();
  const model = s.model.trim();
  return {
    projectId: s.projectId,
    baseRef: startBranch(s),
    ...(s.source === 'describe' ? { description: s.description.trim() } : { planText: s.planText }),
    ...(title ? { title } : {}),
    mode: s.mode,
    ...(model ? { model } : {}),
    publish: s.publish,
  };
}
