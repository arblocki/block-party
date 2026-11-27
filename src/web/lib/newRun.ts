import type { Project, StartRunRequest } from '../types';

/** The server accepts 1-20000 characters of description. */
export const MAX_DESCRIPTION_CHARS = 20000;

export interface NewRunState {
  projectId: string;
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

/** Start needs a project, a base ref, and a description or a plan the server accepted. */
export function canStart(s: NewRunState): boolean {
  if (s.projectId === '' || s.baseRef.trim() === '') return false;
  if (s.source === 'describe') {
    const d = s.description.trim();
    return d !== '' && d.length <= MAX_DESCRIPTION_CHARS;
  }
  return s.planText.trim() !== '' && s.planValid;
}

export function projectLabel(p: Pick<Project, 'owner' | 'repo' | 'localPath'>): string {
  return `${p.owner}/${p.repo} — ${p.localPath}`;
}

/** The POST /api/runs body: fields trimmed, blank optionals left out. */
export function toRunRequest(s: NewRunState): StartRunRequest {
  const title = s.title.trim();
  const model = s.model.trim();
  return {
    projectId: s.projectId,
    baseRef: s.baseRef.trim(),
    ...(s.source === 'describe' ? { description: s.description.trim() } : { planText: s.planText }),
    ...(title ? { title } : {}),
    mode: s.mode,
    ...(model ? { model } : {}),
    publish: s.publish,
  };
}
