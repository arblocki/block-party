import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openStore } from './index.js';
import { MIGRATIONS } from './schema.js';

const ref = { owner: 'o', repo: 'r', number: 1 };
const other = { owner: 'o', repo: 'r', number: 2 };
const base = { path: 'a.ts', side: 'RIGHT' as const, line: 3, body: 'hi', headSha: 'abc' };

describe('store drafts', () => {
  it('creates, lists, updates and deletes', () => {
    const s = openStore(':memory:');
    expect(s.listDrafts(ref)).toEqual([]);
    const d = s.upsertDraft(ref, { ...base, startLine: 1, hunkId: 'h1' });
    expect(d).toMatchObject({ path: 'a.ts', startLine: 1, startSide: 'RIGHT', hunkId: 'h1' });
    expect(d.id).toBeTruthy();

    const updated = s.upsertDraft(ref, { ...base, id: d.id, body: 'changed' });
    expect(updated.id).toBe(d.id);
    expect(updated.body).toBe('changed');
    expect(updated.startLine).toBeUndefined();
    expect(s.listDrafts(ref)).toHaveLength(1);

    expect(s.deleteDraft(ref, d.id)).toBe(true);
    expect(s.deleteDraft(ref, d.id)).toBe(false);
    expect(s.listDrafts(ref)).toEqual([]);
  });

  it('scopes drafts to a pull request', () => {
    const s = openStore(':memory:');
    const d = s.upsertDraft(ref, base);
    expect(s.listDrafts(other)).toEqual([]);
    expect(s.deleteDraft(other, d.id)).toBe(false);
    expect(() => s.upsertDraft(other, { ...base, id: d.id })).toThrow(/different pull request/);
    expect(s.listDrafts(ref)[0]?.body).toBe('hi');
  });

  it('deletes several drafts and records submitted reviews', () => {
    const s = openStore(':memory:');
    const a = s.upsertDraft(ref, base);
    const b = s.upsertDraft(ref, { ...base, line: 9 });
    s.deleteDrafts(ref, [a.id, b.id]);
    expect(s.listDrafts(ref)).toEqual([]);
    expect(() =>
      s.recordSubmittedReview(ref, { headSha: 'abc', event: 'COMMENT', githubReviewId: 5 }),
    ).not.toThrow();
  });

  it('bumps the revision on every upsert, even within the same millisecond', () => {
    const s = openStore(':memory:');
    const a = s.upsertDraft(ref, base);
    expect(a.revision).toBe(1);
    const b = s.upsertDraft(ref, { ...base, id: a.id });
    expect(b.revision).toBe(2);
  });

  it('deletes only drafts unchanged since the snapshot and reports the rest', () => {
    const s = openStore(':memory:');
    const a = s.upsertDraft(ref, base);
    const b = s.upsertDraft(ref, { ...base, line: 9 });
    const c = s.upsertDraft(ref, { ...base, line: 10 });
    const snapshot = [a, b, c].map((d) => ({ id: d.id, revision: d.revision }));
    s.upsertDraft(ref, { ...base, id: b.id, line: 9, body: 'edited' });
    s.deleteDraft(ref, c.id); // removed by the user meanwhile: nothing to keep
    expect(s.deleteDraftsIfUnchanged(ref, snapshot)).toEqual([b.id]);
    expect(s.listDrafts(ref).map((d) => [d.id, d.body])).toEqual([[b.id, 'edited']]);
  });
});

describe('store review state', () => {
  it('marks, lists and unmarks reviewed hunks per pull request', () => {
    const s = openStore(':memory:');
    s.markReviewed(ref, ['h1', 'h2'], 'sha1');
    s.markReviewed(ref, ['h2', 'h3'], 'sha2'); // h2 keeps its original record
    s.markReviewed(other, ['x'], 'sha9');
    const list = s.listReviewed(ref);
    expect(list.map((r) => r.hunkId).sort()).toEqual(['h1', 'h2', 'h3']);
    expect(list.find((r) => r.hunkId === 'h2')?.headSha).toBe('sha1');
    expect(list.find((r) => r.hunkId === 'h3')?.headSha).toBe('sha2');
    s.unmarkReviewed(ref, ['h1', 'nope']);
    expect(s.listReviewed(ref).map((r) => r.hunkId)).not.toContain('h1');
    expect(s.listReviewed(other)).toHaveLength(1);
  });

  it('stores verify checks keyed by group and item', () => {
    const s = openStore(':memory:');
    s.setVerifyCheck(ref, 'g', 0, true);
    s.setVerifyCheck(ref, 'g', 1, true);
    s.setVerifyCheck(ref, 'g', 0, false);
    expect(s.listVerifyChecks(ref)).toEqual([
      { groupKey: 'g', itemIndex: 0, checked: false },
      { groupKey: 'g', itemIndex: 1, checked: true },
    ]);
    expect(s.listVerifyChecks(other)).toEqual([]);
  });

  it('derives the review baseline from checkpoints and submitted reviews, not hunk marks', async () => {
    const s = openStore(':memory:');
    expect(s.getReviewBaselineHeadSha(ref)).toBeUndefined();
    // No checkpoint or review: the earliest mark, and later marks do not advance it.
    s.markReviewed(ref, ['h1'], 'sha1');
    expect(s.getReviewBaselineHeadSha(ref)).toBe('sha1');
    await new Promise((r) => setTimeout(r, 5));
    s.markReviewed(ref, ['h2'], 'sha2');
    expect(s.getReviewBaselineHeadSha(ref)).toBe('sha1');
    await new Promise((r) => setTimeout(r, 5));
    s.setReviewCheckpoint(ref, 'sha2');
    expect(s.getReviewBaselineHeadSha(ref)).toBe('sha2');
    await new Promise((r) => setTimeout(r, 5));
    s.markReviewed(ref, ['h3'], 'sha3');
    expect(s.getReviewBaselineHeadSha(ref)).toBe('sha2');
    await new Promise((r) => setTimeout(r, 5));
    s.recordSubmittedReview(ref, { headSha: 'sha3', event: 'COMMENT', githubReviewId: 1 });
    expect(s.getReviewBaselineHeadSha(ref)).toBe('sha3');
    expect(s.getReviewBaselineHeadSha(other)).toBeUndefined();
  });

  it('keeps the first-mark baseline when that hunk is unmarked after a push', async () => {
    const s = openStore(':memory:');
    s.markReviewed(ref, ['x'], 'shaA');
    await new Promise((r) => setTimeout(r, 5));
    // Head B arrives: unmark X, then mark a hunk on B. Nothing chose "Done reviewing".
    s.unmarkReviewed(ref, ['x']);
    s.markReviewed(ref, ['y'], 'shaB');
    expect(s.getReviewBaselineHeadSha(ref)).toBe('shaA');
    // Even with no marks left at all.
    s.unmarkReviewed(ref, ['y']);
    expect(s.getReviewBaselineHeadSha(ref)).toBe('shaA');
  });

  it('keeps anchors, and moves or outdates drafts', () => {
    const s = openStore(':memory:');
    const d = s.upsertDraft(ref, {
      ...base,
      hunkId: 'h',
      startLine: 2,
      anchor: { index: 4, startIndex: 3, text: 'x' },
    });
    expect(d).toMatchObject({ outdated: false, anchor: { index: 4, startIndex: 3, text: 'x' } });
    s.moveDraft(ref, d.id, { line: 9, startLine: 8, headSha: 'new' });
    expect(s.listDrafts(ref)[0]).toMatchObject({ line: 9, startLine: 8, headSha: 'new' });
    s.markDraftOutdated(ref, d.id);
    expect(s.listDrafts(ref)[0]?.outdated).toBe(true);
    // Editing the draft makes it live again.
    expect(s.upsertDraft(ref, { ...base, id: d.id }).outdated).toBe(false);
  });
});

describe('repository casing', () => {
  const lower = { owner: 'org', repo: 'my-repo', number: 7 };
  const mixed = { owner: 'Org', repo: 'My-Repo', number: 7 };
  const draft = { path: 'a.ts', side: 'RIGHT' as const, line: 1, body: 'hi', headSha: 'h1' };

  it('treats spellings of the same repository as one PR', () => {
    const s = openStore(':memory:');
    s.upsertDraft(mixed, draft);
    s.markReviewed(mixed, ['h-a'], 'h1');
    s.setVerifyCheck(mixed, 'g', 0, true);
    s.setReviewCheckpoint(mixed, 'h1');
    expect(s.listDrafts(lower)).toHaveLength(1);
    expect(s.listReviewed(lower).map((r) => r.hunkId)).toEqual(['h-a']);
    expect(s.listVerifyChecks(lower)).toHaveLength(1);
    expect(s.getReviewBaselineHeadSha(lower)).toBe('h1');
    s.close();
  });

  it('folds mixed-case rows from older databases into the lowercase key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rd-store-'));
    const file = join(dir, 'db.sqlite');
    try {
      // A database at the schema version before the casing migration, written by hand.
      const old = new Database(file);
      for (const m of MIGRATIONS.slice(0, MIGRATIONS.length - 1)) old.exec(m);
      old.pragma(`user_version = ${MIGRATIONS.length - 1}`);
      const now = '2026-01-01T00:00:00Z';
      old
        .prepare(
          `INSERT INTO drafts (id, repo, pr, path, side, line, body, head_sha, updated_at)
           VALUES ('d1', 'Org/My-Repo', 7, 'a.ts', 'RIGHT', 1, 'hi', 'h1', ?)`,
        )
        .run(now);
      const reviewed = old.prepare(
        'INSERT INTO reviewed_hunks (repo, pr, hunk_id, reviewed_at, head_sha) VALUES (?, 7, ?, ?, ?)',
      );
      // The same hunk marked under both spellings, plus one only under the mixed spelling.
      reviewed.run('Org/My-Repo', 'h-a', now, 'h1');
      reviewed.run('org/my-repo', 'h-a', now, 'h1');
      reviewed.run('Org/My-Repo', 'h-b', now, 'h1');
      old
        .prepare(
          'INSERT INTO review_checkpoints (repo, pr, head_sha, created_at) VALUES (?, 7, ?, ?)',
        )
        .run('ORG/MY-REPO', 'h1', now);
      old.close();

      const s = openStore(file);
      expect(s.listDrafts(lower).map((d) => d.id)).toEqual(['d1']);
      expect(
        s
          .listReviewed(lower)
          .map((r) => r.hunkId)
          .sort(),
      ).toEqual(['h-a', 'h-b']);
      expect(s.getReviewBaselineHeadSha(mixed)).toBe('h1');
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
