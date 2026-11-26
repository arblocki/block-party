import type { Project, StartRunRequest } from '../types';

export interface NewRunState {
  projectId: string;
  baseRef: string;
  planText: string;
  /** The plan text passed validation. */
  planValid: boolean;
  title: string;
  mode: 'pane' | 'headless';
  model: string;
  publish: boolean;
}

/** Start needs a project, a base ref and a plan the server accepted. */
export function canStart(s: NewRunState): boolean {
  return s.projectId !== '' && s.baseRef.trim() !== '' && s.planText.trim() !== '' && s.planValid;
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
    planText: s.planText,
    ...(title ? { title } : {}),
    mode: s.mode,
    ...(model ? { model } : {}),
    publish: s.publish,
  };
}
