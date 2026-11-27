import { writeArtifact } from './artifacts.js';
import { attachCommand, type Ctx } from './context.js';
import type { Finding } from '../reviewer/findings.js';
import type { DecisionAnswer, DecisionKind, DecisionOption, FindingStatus } from '../store/runs.js';
import type { RunState } from './run-state.js';
import type { ResolutionKind, ReviewRoundInput } from './publish.js';
import { DecisionDismissedError } from './wait.js';
import {
  assessFix,
  BROAD_FIX_OPTIONS,
  broadFixBody,
  disputeBody,
  DISPUTE_OPTIONS,
  FINAL_RULINGS,
  mayInherit,
  statusForRuling,
  triageBody,
  triageOf,
  TRIAGE_OPTIONS,
  withRuling,
  type RulingKind,
} from './triage.js';

/** What the triage steps need from the pipeline, which owns stage moves and halting. */
export interface LoopEnv {
  setStage(ctx: Ctx, stage: RunState['stage'], note: string | null): Promise<void>;
  /** The error that ends the run `blocked` with `note`. */
  halt(note: string): Error;
}

/** A finding that goes to the implementer in a fix round. */
export interface FixItem {
  round: number;
  id: string;
  key: string;
  finding: Finding;
  /** Later findings that raise this one again: they get the same resolution. */
  also: { round: number; id: string }[];
}

export const keyOf = (round: number, id: string) => `r${round}:${id}`;

export function fixItem(round: number, finding: Finding): FixItem {
  return { round, id: finding.id, key: keyOf(round, finding.id), finding, also: [] };
}

/** Writes the owner's rulings so far where the fix brief points the implementer. */
export async function writeRulings(ctx: Ctx): Promise<string> {
  const art = await writeArtifact(ctx.runDir, 'inputs/rulings.json', ctx.rulings);
  ctx.rulingsWritten = true;
  return art.path;
}

export async function recordRuling(
  ctx: Ctx,
  key: string,
  ruling: RulingKind,
  note: string | null,
): Promise<void> {
  ctx.rulings = withRuling(ctx.rulings, { key, ruling, note: note ?? '' });
  await writeRulings(ctx);
}

/** Marks upheld findings in `items` as having had their extra fix turn. */
export async function markSpent(ctx: Ctx, items: FixItem[]): Promise<void> {
  const keys = new Set(items.map((i) => i.key));
  let changed = false;
  ctx.rulings = ctx.rulings.map((r) => {
    if (r.ruling !== 'uphold' || r.spent || !keys.has(r.key)) return r;
    changed = true;
    return { ...r, spent: true };
  });
  if (changed) await writeRulings(ctx);
}

/** Records a finding's status in its row and in the round's resolutions. */
export function setStatus(
  ctx: Ctx,
  round: number,
  id: string,
  status: FindingStatus,
  note: string | null,
): void {
  ctx.rec.setFindingStatus(round, id, status, note);
  const r = ctx.rounds.find((x) => x.round === round);
  if (!r) return;
  if (status === 'open') delete r.resolutions[id];
  else r.resolutions[id] = { resolution: status as ResolutionKind, note: note ?? '' };
}

/** The finding `key` (`r<round>:<id>`) with its round, if this run knows it. */
export function findingOfKey(
  ctx: Ctx,
  key: string,
): { round: number; finding: Finding } | undefined {
  const m = /^r(\d+):(.+)$/.exec(key);
  if (!m) return undefined;
  const round = ctx.rounds.find((r) => r.round === Number(m[1]));
  const finding = round?.findings.find((f) => f.id === m[2]);
  return round && finding ? { round: round.round, finding } : undefined;
}

/** The status of finding `key` as this run knows it. */
export function statusOfKey(ctx: Ctx, key: string): FindingStatus | undefined {
  const found = findingOfKey(ctx, key);
  if (!found) return undefined;
  const round = ctx.rounds.find((r) => r.round === found.round)!;
  return (round.resolutions[found.finding.id]?.resolution ?? 'open') as FindingStatus;
}

/** "2 P2 findings", "1 P1, 2 P2 findings". */
function severityCounts(findings: Finding[]): string {
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);
  const parts = [...counts].sort().map(([sev, n]) => `${n} ${sev}`);
  return `${parts.join(', ')} ${findings.length === 1 ? 'finding' : 'findings'}`;
}

/** A line naming the owner's earlier ruling on what `f` raises again, for decision bodies. */
function earlierRuling(ctx: Ctx, f: Finding): string | undefined {
  const r = f.repeatOf ? ctx.rulings.find((x) => x.key === f.repeatOf) : undefined;
  return r
    ? `This finding raises ${r.key} again, which you ruled "${r.ruling}"${r.note ? ` (${r.note})` : ''}.`
    : undefined;
}

/**
 * Moves the run to `awaiting_decision` and opens one decision per spec. A run database that
 * cannot take them halts the run: nothing could answer, so waiting would never end.
 */
export async function openDecisions(
  env: LoopEnv,
  ctx: Ctx,
  kind: DecisionKind,
  specs: { title: string; body: string; options: DecisionOption[] }[],
  waitNote: string,
): Promise<number[]> {
  await env.setStage(ctx, 'awaiting_decision', waitNote);
  const ids: number[] = [];
  for (const spec of specs) {
    const id = ctx.rec.openDecision(kind, spec.title, spec.body, attachCommand(ctx), spec.options);
    if (id === null) {
      throw env.halt(
        `Cannot ask about ${waitNote}: the run database is unavailable, so nothing could answer.`,
      );
    }
    ids.push(id);
  }
  return ids;
}

/** Waits for every answer; a dismissed question halts the run. */
export async function awaitAnswers(
  env: LoopEnv,
  ctx: Ctx,
  ids: number[],
): Promise<DecisionAnswer[]> {
  const answers: DecisionAnswer[] = [];
  for (const id of ids) {
    try {
      answers.push(await ctx.rec.awaitDecision(id, ctx.input.signal));
    } catch (e) {
      if (e instanceof DecisionDismissedError) {
        throw env.halt(
          `A question (decision ${id}) was dismissed without an answer, so the run cannot go on.`,
        );
      }
      throw e;
    }
  }
  return answers;
}

/**
 * Opens an informational `cap_reached` item for the entries no open item with that title
 * already names; entries already covered are left out, and nothing opens if all are.
 */
function openInfoOnce(
  ctx: Ctx,
  title: string,
  intro: string,
  entries: { key: string; line: string }[],
): void {
  let fresh = entries;
  try {
    const open = ctx.deps.store?.listDecisions({ runId: ctx.st.id, status: 'open' }) ?? [];
    const same = open.filter((d) => d.kind === 'cap_reached' && d.title === title);
    fresh = entries.filter((e) => !same.some((d) => d.body.includes(`${e.key} `)));
  } catch {
    // A failing store only risks a duplicate item.
  }
  if (fresh.length === 0) return;
  ctx.rec.openDecision(
    'cap_reached',
    title,
    `${intro}\n${fresh.map((e) => e.line).join('\n')}`,
    null,
  );
}

/**
 * A finding that raises a `fixed` one again stops the run when it is one the loop acts on
 * (auto-fix or ask): the fix did not hold. A recorded-only repeat is just noted.
 */
export function haltOnRepeatOfFixed(env: LoopEnv, ctx: Ctx, rec: ReviewRoundInput): void {
  const policy = ctx.input.config.policy;
  for (const f of rec.findings) {
    if (!f.repeatOf || statusOfKey(ctx, f.repeatOf) !== 'fixed') continue;
    const key = keyOf(rec.round, f.id);
    if (triageOf(policy, f.severity) === 'record') {
      ctx.rec.event('repeat.recorded', { key, repeatOf: f.repeatOf });
      continue;
    }
    throw env.halt(
      `Finding ${key} raises ${f.repeatOf} again, but ${f.repeatOf} was marked fixed.`,
    );
  }
}

/**
 * A finding that raises one the owner already ruled on (skip, defer, accepted dispute) takes
 * the same ruling, if it is no more severe and no stricter in triage than the ruled one;
 * otherwise it is triaged normally. Returns the ids that inherited.
 */
export async function inheritRulings(ctx: Ctx, rec: ReviewRoundInput): Promise<Set<string>> {
  const policy = ctx.input.config.policy;
  const inherited = new Set<string>();
  for (const f of rec.findings) {
    const earlier = f.repeatOf ? ctx.rulings.find((r) => r.key === f.repeatOf) : undefined;
    if (!f.repeatOf || !earlier || !FINAL_RULINGS.includes(earlier.ruling)) continue;
    const ruled = findingOfKey(ctx, f.repeatOf)?.finding;
    if (!ruled || !mayInherit(policy, ruled.severity, f.severity)) continue;
    inherited.add(f.id);
    const note = `Same as ${f.repeatOf}, which you ruled ${earlier.ruling}`;
    setStatus(ctx, rec.round, f.id, statusForRuling(earlier.ruling), note);
    await recordRuling(ctx, keyOf(rec.round, f.id), earlier.ruling, note);
  }
  return inherited;
}

/** The round's findings that would be asked about. */
function askable(ctx: Ctx, rec: ReviewRoundInput, skip: Set<string>): Finding[] {
  const policy = ctx.input.config.policy;
  return rec.findings.filter(
    (f) => triageOf(policy, f.severity) === 'ask' && !skip.has(f.id) && !rec.resolutions[f.id],
  );
}

/** Asks about the round's `ask` findings; returns the ids the owner wants fixed. */
export async function askTriage(
  env: LoopEnv,
  ctx: Ctx,
  rec: ReviewRoundInput,
  skip: Set<string>,
): Promise<Set<string>> {
  const asked = askable(ctx, rec, skip);
  const toFix = new Set<string>();
  if (asked.length === 0) return toFix;
  const ids = await openDecisions(
    env,
    ctx,
    'finding_triage',
    asked.map((f) => ({
      title: `Fix, skip or defer: ${f.title}`,
      body: triageBody(f, earlierRuling(ctx, f)),
      options: TRIAGE_OPTIONS,
    })),
    `${severityCounts(asked)} to triage`,
  );
  ctx.rec.event('triage.asked', {
    round: rec.round,
    findings: asked.map((f) => keyOf(rec.round, f.id)),
    decisions: ids,
  });
  const answers = await awaitAnswers(env, ctx, ids);
  for (const [i, f] of asked.entries()) {
    const { choice, note } = answers[i]!;
    const key = keyOf(rec.round, f.id);
    ctx.rec.event('triage.answered', { key, choice });
    const ruling = choice as RulingKind;
    await recordRuling(ctx, key, ruling, note);
    if (ruling === 'fix') toFix.add(f.id);
    else setStatus(ctx, rec.round, f.id, statusForRuling(ruling), note ?? `Owner ruled ${ruling}`);
  }
  await env.setStage(ctx, 'reviewing', 'triage answered');
  return toFix;
}

/** Past the cap nothing is asked: say which findings went untriaged. */
export function reportNotAsked(ctx: Ctx, rec: ReviewRoundInput, skip: Set<string>): void {
  const left = askable(ctx, rec, skip);
  if (left.length === 0) return;
  const keys = left.map((f) => keyOf(rec.round, f.id));
  ctx.rec.event('triage.not_asked', { round: rec.round, findings: keys });
  openInfoOnce(
    ctx,
    'Findings not triaged',
    'The fix-round cap was reached, so these findings were not asked about:',
    left.map((f) => ({
      key: keyOf(rec.round, f.id),
      line: `- ${keyOf(rec.round, f.id)} ${f.severity} ${f.title}`,
    })),
  );
}

/** Findings the owner upheld that have not had their extra fix turn yet and are still open. */
export function pendingUpheld(ctx: Ctx): FixItem[] {
  const items: FixItem[] = [];
  for (const r of ctx.rulings) {
    if (r.ruling !== 'uphold' || r.spent || statusOfKey(ctx, r.key) !== 'open') continue;
    const found = findingOfKey(ctx, r.key);
    if (found) items.push(fixItem(found.round, found.finding));
  }
  return items;
}

/**
 * The fix set: pending upheld findings, then (below the cap) the round's auto-fix findings
 * and the ones the owner wants fixed. A finding that raises an upheld one again is folded
 * into it, at the cap too, so the same problem is not sent twice and gets the same outcome.
 */
export function buildFixSet(
  ctx: Ctx,
  rec: ReviewRoundInput,
  inherited: Set<string>,
  answeredFix: Set<string>,
  capReached: boolean,
): FixItem[] {
  const upheld = pendingUpheld(ctx);
  const policy = ctx.input.config.policy;
  const byKey = new Map(upheld.map((u) => [u.key, u]));
  const fresh: FixItem[] = [];
  for (const f of rec.findings) {
    if (inherited.has(f.id)) continue;
    if (triageOf(policy, f.severity) !== 'auto_fix' && !answeredFix.has(f.id)) continue;
    const dup = f.repeatOf ? byKey.get(f.repeatOf) : undefined;
    if (dup) dup.also.push({ round: rec.round, id: f.id });
    else if (!capReached) fresh.push(fixItem(rec.round, f));
  }
  return [...upheld, ...fresh];
}

/** Upheld findings whose extra turn is used and which are still not resolved: tell the owner. */
export function escalateUpheld(ctx: Ctx): void {
  const stuck = ctx.rulings.filter((r) => {
    if (r.ruling !== 'uphold' || !r.spent) return false;
    const s = statusOfKey(ctx, r.key);
    return s === 'open' || s === 'disputed';
  });
  if (stuck.length === 0) return;
  openInfoOnce(
    ctx,
    'Upheld findings still unresolved',
    'You asked for these to be fixed anyway, but they are still not fixed after their extra fix turn:',
    stuck.map((r) => {
      const f = findingOfKey(ctx, r.key)?.finding;
      return { key: r.key, line: `- ${r.key}${f ? ` ${f.severity} ${f.title}` : ''}` };
    }),
  );
}

/**
 * After a fix turn: applies the implementer's resolutions, stops for a broad fix, and has the
 * owner rule on disputes. An upheld finding that is disputed again after its extra turn is
 * not asked again; `escalateUpheld` reports it.
 */
export async function settleFix(
  env: LoopEnv,
  ctx: Ctx,
  items: FixItem[],
  said: Map<string, { resolution: ResolutionKind; note: string }>,
  fileId: (i: FixItem) => string,
): Promise<void> {
  const policy = ctx.input.config.policy;
  const disputed: { item: FixItem; note: string }[] = [];
  for (const i of items) {
    const x = said.get(fileId(i));
    if (!x) continue;
    for (const t of [i, ...i.also]) setStatus(ctx, t.round, t.id, x.resolution, x.note);
    if (x.resolution !== 'disputed') continue;
    const again = ctx.rulings.some((r) => r.key === i.key && r.ruling === 'uphold' && r.spent);
    if (!again) disputed.push({ item: i, note: x.note });
  }

  let waited = false;
  const { from, to } = ctx.lastFix ?? {};
  if (from && to && from !== to) {
    const { files } = await ctx.deps.git.diffFiles(ctx.st.worktreePath, from, to);
    const a = assessFix(
      files,
      items.map((i) => i.finding),
      policy,
    );
    if (a.broad) {
      ctx.rec.event('fix.broad', {
        files: a.files,
        lines: a.lines,
        lineBudget: a.lineBudget,
        deletedFiles: a.deletedFiles,
        outsideFiles: a.outsideFiles,
      });
      const [id] = await openDecisions(
        env,
        ctx,
        'broad_fix',
        [
          {
            title: 'Fix is much broader than its findings',
            body: broadFixBody(a, files, items.length),
            options: BROAD_FIX_OPTIONS,
          },
        ],
        `broad fix: ${a.reasons.join('; ')}`,
      );
      waited = true;
      const [answer] = await awaitAnswers(env, ctx, [id!]);
      if (answer!.choice === 'stop') {
        throw env.halt(
          `Stopped at your request: the fix was much broader than its findings (${a.reasons.join('; ')}).`,
        );
      }
    }
  }

  if (disputed.length > 0) {
    const ids = await openDecisions(
      env,
      ctx,
      'dispute',
      disputed.map((d) => ({
        title: `Disputed: ${d.item.finding.title}`,
        body: disputeBody(d.item.key, d.item.finding, d.note, earlierRuling(ctx, d.item.finding)),
        options: DISPUTE_OPTIONS,
      })),
      `${disputed.length} disputed ${disputed.length === 1 ? 'finding' : 'findings'} to rule on`,
    );
    waited = true;
    ctx.rec.event('dispute.opened', { findings: disputed.map((d) => d.item.key), decisions: ids });
    const answers = await awaitAnswers(env, ctx, ids);
    for (const [k, d] of disputed.entries()) {
      const { choice, note } = answers[k]!;
      ctx.rec.event('dispute.answered', { key: d.item.key, choice });
      const ruling = choice as RulingKind;
      await recordRuling(ctx, d.item.key, ruling, note);
      const targets = [d.item, ...d.item.also];
      if (ruling === 'accept_dispute') {
        const why = `Owner agreed with the dispute: ${d.note}${note ? ` (${note})` : ''}`;
        for (const t of targets) setStatus(ctx, t.round, t.id, 'wont_fix', why);
      } else {
        for (const t of targets) setStatus(ctx, t.round, t.id, 'open', null);
      }
    }
  }
  if (waited) await env.setStage(ctx, 'checking', 'questions answered');
}
