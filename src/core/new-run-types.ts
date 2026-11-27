/** One repo in the new-run form (GET /api/new-run/repos). */
export interface NewRunRepo {
  owner: string;
  repo: string;
  private: boolean;
  pushedAt: string | null;
  /** Known only for a registered project. */
  defaultBranch: string | null;
  /** Real paths of the clones on this computer; a registered project's copy comes first. */
  clones: string[];
  /** The registered project (most recently used) for this repo, if any. */
  projectId: string | null;
  lastUsedAt: string | null;
}
