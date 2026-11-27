import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, jsonBody } from './api';
import { splitByFile, visibleFindings } from './lib/findingPlacement';
import { useReview } from './state';
import type {
  FindingRow,
  RunDecision,
  RunDetailResponse,
  RunFindings,
  RunSummary,
  StageRow,
} from './types';

const POLL_MS = 5000;
const NO_FINDINGS: FindingRow[] = [];

/** A comment of the reviewer's own, as the send-back endpoint takes it. */
export interface SendComment {
  path: string;
  line: number | null;
  body: string;
}

/** What the review page knows about the run that opened this PR. */
export interface RunLink {
  run: RunDetailResponse['run'];
  stages: StageRow[];
  decisions: RunDecision[];
  /** The open final review, when the run is resting for one. */
  finalReview: RunDecision | undefined;
  criteria: string[];
  /** Every finding of every round, for history. */
  allFindings: FindingRow[];
  /** The findings worth showing on this head, by file path of the diff. */
  byPath: ReadonlyMap<string, FindingRow[]>;
  /** Shown findings with no place in the diff. */
  unplaced: FindingRow[];
  /** Keys of the findings in the send tray, and the ids of the drafts in it. */
  selected: ReadonlySet<string>;
  draftIds: ReadonlySet<string>;
  toggleFinding(key: string): void;
  toggleDraft(id: string): void;
  note: string;
  setNote(note: string): void;
  busy: boolean;
  error: string | null;
  /** Set once a send-back started a fix round. */
  sent: boolean;
  send(comments: SendComment[]): Promise<void>;
  approve(): Promise<void>;
  reload(): Promise<void>;
}

const RunLinkContext = createContext<RunLink | null>(null);

/** The run behind this PR, or null for a PR with no run (the page then renders as before). */
export function useRunLink(): RunLink | null {
  return useContext(RunLinkContext);
}

/** The findings to show on one file's diff; a stable empty list without a run. */
export function useFileFindings(path: string): FindingRow[] {
  return useContext(RunLinkContext)?.byPath.get(path) ?? NO_FINDINGS;
}

const toggled = <T,>(set: ReadonlySet<T>, v: T): Set<T> => {
  const next = new Set(set);
  if (!next.delete(v)) next.add(v);
  return next;
};

/** Looks the PR's run up once; provides nothing (null) when there is none or the lookup fails. */
export function RunLinkProvider({ children }: { children: ReactNode }) {
  const { session, pr, files } = useReview();
  const { owner, repo, number } = session.pr;
  const [runId, setRunId] = useState<string | null>(null);
  const [data, setData] = useState<{
    detail: RunDetailResponse;
    rounds: RunFindings['rounds'];
    criteria: string[];
  } | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [draftIds, setDraftIds] = useState<ReadonlySet<string>>(new Set());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    const q = new URLSearchParams({ owner, repo, pr: String(number) });
    api<{ run: RunSummary | null }>(`/api/pr-run?${q}`).then(
      (res) => alive.current && setRunId(res.run?.id ?? null),
      () => undefined,
    );
  }, [owner, repo, number]);

  const reload = useCallback(async () => {
    if (!runId) return;
    try {
      const base = `/api/runs/${encodeURIComponent(runId)}`;
      const [detail, found, plan] = await Promise.all([
        api<RunDetailResponse>(base),
        api<RunFindings>(`${base}/findings`),
        api<{ acceptanceCriteria: string[] }>(`${base}/plan`).catch(() => null),
      ]);
      if (alive.current) {
        setData({ detail, rounds: found.rounds, criteria: plan?.acceptanceCriteria ?? [] });
      }
    } catch {
      // keep what is shown; the next poll retries
    }
  }, [runId]);

  useEffect(() => {
    if (!runId) return;
    void reload();
    const timer = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(timer);
  }, [runId, reload]);

  const allFindings = useMemo(() => data?.rounds.flatMap((r) => r.findings) ?? [], [data]);
  const placed = useMemo(() => {
    const paths = new Set(files.map((f) => f.path));
    return splitByFile(visibleFindings(allFindings, pr.headSha, paths), paths);
  }, [allFindings, files, pr.headSha]);

  const finalReview = data?.detail.decisions.find(
    (d) => d.kind === 'final_review' && d.status === 'open',
  );

  const act = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        await reload();
      } catch (e) {
        if (alive.current) setError((e as Error).message);
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [reload],
  );

  const value = useMemo<RunLink | null>(() => {
    if (!runId || !data) return null;
    const base = `/api/runs/${encodeURIComponent(runId)}`;
    return {
      run: data.detail.run,
      stages: data.detail.stages,
      decisions: data.detail.decisions,
      finalReview,
      criteria: data.criteria,
      allFindings,
      byPath: placed.byPath,
      unplaced: placed.unplaced,
      selected,
      draftIds,
      toggleFinding: (key) => setSelected((s) => toggled(s, key)),
      toggleDraft: (id) => setDraftIds((s) => toggled(s, id)),
      note,
      setNote,
      busy,
      error,
      sent,
      reload,
      send: (comments) =>
        act(async () => {
          await api(`${base}/send-back`, {
            method: 'POST',
            ...jsonBody({
              findingKeys: [...selected],
              comments,
              ...(note.trim() ? { note } : {}),
            }),
          });
          setSelected(new Set());
          setDraftIds(new Set());
          setNote('');
          setSent(true);
        }),
      approve: () =>
        act(async () => {
          if (!finalReview) throw new Error('the run is not waiting for review');
          await api(`/api/inbox/${finalReview.id}/answer`, {
            method: 'POST',
            ...jsonBody({ choice: 'approve' }),
          });
        }),
    };
  }, [
    runId,
    data,
    finalReview,
    allFindings,
    placed,
    selected,
    draftIds,
    note,
    busy,
    error,
    sent,
    reload,
    act,
  ]);

  return <RunLinkContext.Provider value={value}>{children}</RunLinkContext.Provider>;
}
