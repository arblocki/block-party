import { describe, expect, it } from 'vitest';
import { fixBaseOf, resumePoint, type ResumeEvidence, type StageEvidence } from './resume.js';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

const st = (
  kind: StageEvidence['kind'],
  round: number,
  state: StageEvidence['state'] = 'succeeded',
  input: unknown = {},
  output: unknown = {},
): StageEvidence => ({ kind, round, state, input, output });

const checks = (head = HEAD) => st('checks', 1, 'succeeded', { headSha: head });
const review = (blocking = 0, head = HEAD) =>
  st('review', 1, 'succeeded', { reviewedSha: head }, { blocking });
const publish = (head = HEAD) => st('publish', 1, 'succeeded', { headSha: head });
const waitCi = (head = HEAD, state: StageEvidence['state'] = 'succeeded') =>
  st('wait-ci', 1, state, { headSha: head });

function ev(over: Partial<ResumeEvidence> = {}): ResumeEvidence {
  return {
    stage: 'interrupted',
    worktreePath: '/wt',
    planApproved: true,
    planFeedback: null,
    recordedHead: HEAD,
    head: HEAD,
    dirtyFiles: [],
    newCommits: [],
    stages: [st('implement', 1)],
    reportPending: false,
    prNumber: null,
    publish: true,
    waitForCi: true,
    ...over,
  };
}

describe('resumePoint', () => {
  it('plans again when no plan was approved, with the last feedback', () => {
    expect(
      resumePoint(ev({ planApproved: false, recordedHead: null, stages: [], planFeedback: 'x' })),
    ).toEqual({ kind: 'plan', feedback: 'x' });
  });

  it('resumes the turn when the last agent turn did not finish', () => {
    expect(
      resumePoint(ev({ recordedHead: null, stages: [st('implement', 1, 'cancelled')] })),
    ).toEqual({ kind: 'turn', turnKind: 'implement', n: 1, reportPending: false, dirtyFiles: [] });
    expect(
      resumePoint(
        ev({
          stages: [st('implement', 1), checks(OTHER), st('check-fix', 2, 'running')],
          reportPending: true,
        }),
      ),
    ).toEqual({ kind: 'turn', turnKind: 'check-fix', n: 2, reportPending: true, dirtyFiles: [] });
  });

  it('starts the first turn again when none was recorded', () => {
    expect(resumePoint(ev({ recordedHead: null, stages: [] }))).toEqual({
      kind: 'turn',
      turnKind: 'implement',
      n: 1,
      reportPending: false,
      dirtyFiles: [],
    });
  });

  it('explains commits made during an unfinished turn instead of asking', () => {
    const p = resumePoint(
      ev({
        recordedHead: OTHER,
        newCommits: [{ sha: HEAD, subject: 'wip' }],
        stages: [st('implement', 1), st('review-fix', 1, 'running')],
      }),
    );
    expect(p.kind).toBe('turn');
  });

  it('runs local CI when the head has no passing checks', () => {
    expect(resumePoint(ev())).toEqual({ kind: 'checks' });
    expect(resumePoint(ev({ stages: [st('implement', 1), checks(OTHER)] }))).toEqual({
      kind: 'checks',
    });
    expect(
      resumePoint(
        ev({ stages: [st('implement', 1), st('checks', 1, 'failed', { headSha: HEAD })] }),
      ),
    ).toEqual({ kind: 'checks' });
  });

  it('reviews when checks passed but no review finished on the head', () => {
    expect(resumePoint(ev({ stages: [st('implement', 1), checks()] }))).toEqual({ kind: 'review' });
    expect(resumePoint(ev({ stages: [st('implement', 1), checks(), review(0, OTHER)] }))).toEqual({
      kind: 'review',
    });
    expect(
      resumePoint(
        ev({
          stages: [
            st('implement', 1),
            checks(),
            st('review', 1, 'cancelled', { reviewedSha: HEAD }),
          ],
        }),
      ),
    ).toEqual({ kind: 'review' });
  });

  it('reviews again when the review on the head left blocking findings', () => {
    expect(resumePoint(ev({ stages: [st('implement', 1), checks(), review(2)] }))).toEqual({
      kind: 'review',
    });
  });

  it('publishes when review is clean but the head was not pushed', () => {
    const base = [st('implement', 1), checks(), review()];
    expect(resumePoint(ev({ stages: base }))).toEqual({ kind: 'publish' });
    // Pushed once, on another head.
    expect(resumePoint(ev({ stages: [...base, publish(OTHER)] }))).toEqual({ kind: 'publish' });
    // The pull request's head is not this one.
    expect(resumePoint(ev({ stages: [...base, publish()], prNumber: 7, prHead: OTHER }))).toEqual({
      kind: 'publish',
    });
  });

  it('waits for CI when pushed with no CI result', () => {
    const base = [st('implement', 1), checks(), review(), publish()];
    expect(resumePoint(ev({ stages: base, prNumber: 7, prHead: HEAD }))).toEqual({
      kind: 'wait_ci',
    });
    expect(resumePoint(ev({ stages: [...base, waitCi(HEAD, 'failed')], prNumber: 7 }))).toEqual({
      kind: 'wait_ci',
    });
  });

  it('treats a head whose findings the loop accepted as reviewed', () => {
    const base = [st('implement', 1), checks(), review(2)];
    expect(resumePoint(ev({ stages: base, acceptedHeads: [HEAD] }))).toEqual({ kind: 'publish' });
    expect(resumePoint(ev({ stages: base, acceptedHeads: [OTHER] }))).toEqual({ kind: 'review' });
    // Older runs: a push of this head shows it was accepted.
    expect(resumePoint(ev({ stages: [...base, publish()], prNumber: 7, prHead: HEAD }))).toEqual({
      kind: 'wait_ci',
    });
  });

  it('rests for review when everything is done', () => {
    const base = [st('implement', 1), checks(), review(), publish()];
    expect(resumePoint(ev({ stages: [...base, waitCi()], prNumber: 7 }))).toEqual({
      kind: 'rest_review',
    });
    expect(resumePoint(ev({ stages: base, waitForCi: false, prNumber: 7 }))).toEqual({
      kind: 'rest_review',
    });
    expect(
      resumePoint(ev({ stages: [st('implement', 1), checks(), review()], publish: false })),
    ).toEqual({ kind: 'rest_review' });
  });

  describe('asks instead of guessing', () => {
    it('on uncommitted changes, listing the files', () => {
      const p = resumePoint(ev({ dirtyFiles: [' M a.ts', '?? b.ts'] }));
      expect(p).toMatchObject({ kind: 'ask', canKeep: true });
      expect((p as { reason: string }).reason).toContain('a.ts, b.ts');
    });

    it('on a moved HEAD, listing the commits', () => {
      const p = resumePoint(
        ev({
          recordedHead: OTHER,
          newCommits: [{ sha: HEAD, subject: 'hand fix' }],
          stages: [st('implement', 1), checks(OTHER)],
        }),
      );
      expect(p.kind).toBe('ask');
      const reason = (p as { reason: string }).reason;
      expect(reason).toContain('aaaaaaa hand fix');
      expect(reason).toContain('1 new commit');
    });

    it('on both at once', () => {
      const p = resumePoint(
        ev({ dirtyFiles: [' M a.ts'], recordedHead: OTHER, stages: [st('implement', 1)] }),
      );
      expect((p as { reason: string }).reason).toContain('uncommitted');
      expect((p as { reason: string }).reason).toContain('moved');
    });

    it('on a dirty worktree once past the agent turn', () => {
      for (const stages of [
        [st('implement', 1)],
        [st('implement', 1), checks()],
        [st('implement', 1), checks(), review(), publish()],
      ]) {
        expect(resumePoint(ev({ dirtyFiles: [' M a.ts'], stages })).kind).toBe('ask');
      }
    });

    it('but not in the middle of a turn: its uncommitted work is its own', () => {
      expect(
        resumePoint(ev({ dirtyFiles: [' M a.ts'], stages: [st('implement', 1, 'running')] })),
      ).toMatchObject({ kind: 'turn', dirtyFiles: [' M a.ts'] });
    });

    it('and does not let the owner keep a missing worktree', () => {
      expect(resumePoint(ev({ head: null }), { keep: true })).toMatchObject({
        kind: 'ask',
        canKeep: false,
      });
    });

    it('but settles kept uncommitted changes with a commit turn before anything else', () => {
      const stages = [st('implement', 1), checks(), review()];
      expect(resumePoint(ev({ dirtyFiles: [' M a.ts'], stages }), { keep: true })).toEqual({
        kind: 'turn',
        turnKind: 'resume-commit',
        n: 1,
        reportPending: false,
        dirtyFiles: [' M a.ts'],
      });
      // A second settling gets the next number; an unfinished one is picked up again.
      const again = resumePoint(
        ev({
          dirtyFiles: [' M a.ts'],
          stages: [...stages, st('resume-commit', 1, 'running')],
        }),
        { keep: true },
      );
      expect(again).toMatchObject({ kind: 'turn', turnKind: 'resume-commit', n: 1 });
      expect(
        resumePoint(ev({ dirtyFiles: [' M a.ts'], stages: [...stages, st('resume-commit', 1)] }), {
          keep: true,
        }),
      ).toMatchObject({ turnKind: 'resume-commit', n: 2 });
    });

    it('and keep on a moved HEAD with a clean tree just continues from the evidence', () => {
      expect(
        resumePoint(
          ev({
            recordedHead: OTHER,
            stages: [st('implement', 1), checks(OTHER), review(0, OTHER)],
          }),
          { keep: true },
        ),
      ).toEqual({ kind: 'checks' });
    });

    it('but proceeds when the owner chose to keep a moved HEAD and a clean tree', () => {
      const p = resumePoint(
        ev({ recordedHead: OTHER, stages: [st('implement', 1), checks(OTHER)] }),
        { keep: true },
      );
      // New head, no evidence on it: local CI.
      expect(p).toEqual({ kind: 'checks' });
    });
  });
});

describe('fixBaseOf', () => {
  it('does not count a resumed turn as another round', () => {
    expect(
      fixBaseOf([
        st('check-fix', 1),
        st('check-fix', 1, 'cancelled'),
        st('review-fix', 1),
        st('review-fix', 1),
        st('feedback', 1),
      ]),
    ).toEqual({ checkFix: 1, reviewFix: 1, ciFix: 0 });
  });

  it('is zero without a send-back', () => {
    expect(fixBaseOf([st('check-fix', 1), st('review-fix', 1)])).toEqual({
      checkFix: 0,
      reviewFix: 0,
      ciFix: 0,
    });
  });

  it('counts the fix rounds before the last send-back', () => {
    expect(
      fixBaseOf([
        st('check-fix', 1),
        st('review-fix', 1),
        st('review-fix', 2),
        st('ci-fix', 1),
        st('feedback', 1),
        st('check-fix', 2),
      ]),
    ).toEqual({ checkFix: 1, reviewFix: 2, ciFix: 1 });
  });
});
