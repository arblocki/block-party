import { describe, expect, it } from 'vitest';
import { createGitHubClient } from './client.js';
import { resolveToken } from './token.js';
import type { GraphqlLike, RestLike } from './types.js';

const ref = { owner: 'o', repo: 'r', number: 1 };
const noGql: GraphqlLike = async () => ({});

describe('resolveToken', () => {
  it('prefers gh, then env, else throws', async () => {
    expect(await resolveToken({ GITHUB_TOKEN: 'env' }, async () => 'gh-token\n')).toBe('gh-token');
    const fail = async () => {
      throw new Error('no gh');
    };
    expect(await resolveToken({ GITHUB_TOKEN: 'env' }, fail)).toBe('env');
    await expect(resolveToken({}, fail)).rejects.toThrow(/No GitHub token/);
    expect(await resolveToken({ GITHUB_TOKEN: 'env' }, async () => '  ')).toBe('env');
  });
});

describe('github client', () => {
  it('falls back to the full diff once for files missing a patch', async () => {
    const calls: { route: string; params?: Record<string, unknown> }[] = [];
    const rest: RestLike = {
      async request(route, params) {
        calls.push({ route, params });
        if (route.endsWith('/files')) {
          return {
            data: [
              {
                filename: 'a.ts',
                status: 'modified',
                additions: 1,
                deletions: 0,
                changes: 1,
                patch: '@@ -1 +1 @@\n+x',
              },
              { filename: 'big1.ts', status: 'modified', additions: 5, deletions: 5, changes: 10 },
              { filename: 'big2.ts', status: 'modified', additions: 5, deletions: 5, changes: 10 },
              { filename: 'bin.png', status: 'added', additions: 0, deletions: 0, changes: 0 },
            ],
          };
        }
        return {
          data:
            'diff --git a/big1.ts b/big1.ts\n--- a/big1.ts\n+++ b/big1.ts\n@@ -1 +1 @@\n-a\n+b\n' +
            'diff --git a/big2.ts b/big2.ts\n--- a/big2.ts\n+++ b/big2.ts\n@@ -2 +2 @@\n-c\n+d\n',
        };
      },
    };
    const files = await createGitHubClient({ rest, gql: noGql }).fetchFiles(ref);
    expect(files.find((f) => f.filename === 'big1.ts')?.patch).toBe('@@ -1 +1 @@\n-a\n+b\n');
    expect(files.find((f) => f.filename === 'big2.ts')?.patch).toContain('@@ -2 +2 @@');
    expect(files.find((f) => f.filename === 'bin.png')?.patch).toBeUndefined();
    const diffCalls = calls.filter((c) =>
      (c.params?.headers as { accept?: string } | undefined)?.accept?.includes('diff'),
    );
    expect(diffCalls).toHaveLength(1);
  });

  it("lists the viewer's repositories, latest push first", async () => {
    const calls: { route: string; params?: Record<string, unknown> }[] = [];
    const rest: RestLike = {
      async request(route, params) {
        calls.push({ route, params });
        return {
          data: [
            {
              name: 'hello-world',
              owner: { login: 'octocat' },
              description: 'My first repo',
              private: true,
              archived: false,
              fork: true,
              html_url: 'https://github.com/octocat/hello-world',
              pushed_at: '2026-01-02T00:00:00Z',
            },
            { name: 'bare', owner: { login: 'o' }, description: null },
          ],
        };
      },
    };
    const repos = await createGitHubClient({ rest, gql: noGql }).listRepos();
    expect(calls).toEqual([
      {
        route: 'GET /user/repos',
        params: {
          affiliation: 'owner,collaborator,organization_member',
          sort: 'pushed',
          direction: 'desc',
          per_page: 100,
          page: 1,
        },
      },
    ]);
    expect(repos).toEqual([
      {
        owner: 'octocat',
        name: 'hello-world',
        description: 'My first repo',
        private: true,
        archived: false,
        fork: true,
        url: 'https://github.com/octocat/hello-world',
        pushedAt: '2026-01-02T00:00:00Z',
      },
      {
        owner: 'o',
        name: 'bare',
        description: '',
        private: false,
        archived: false,
        fork: false,
        url: '',
        pushedAt: '',
      },
    ]);
  });

  it('lists open pull requests, newest update first', async () => {
    const calls: { route: string; params?: Record<string, unknown> }[] = [];
    const rest: RestLike = {
      async request(route, params) {
        calls.push({ route, params });
        return {
          data: [
            {
              number: 7,
              title: 'Add retries',
              user: { login: 'hubot' },
              draft: true,
              html_url: 'https://github.com/o/r/pull/7',
              head: { ref: 'retries' },
              base: { ref: 'main' },
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-02T00:00:00Z',
              labels: [{ name: 'backend' }, {}],
              requested_reviewers: [{ login: 'octocat' }],
            },
            { number: 8, user: null, head: {}, base: {} },
          ],
        };
      },
    };
    const prs = await createGitHubClient({ rest, gql: noGql }).listOpenPrs({
      owner: 'o',
      repo: 'r',
    });
    expect(calls).toEqual([
      {
        route: 'GET /repos/{owner}/{repo}/pulls',
        params: {
          owner: 'o',
          repo: 'r',
          state: 'open',
          sort: 'updated',
          direction: 'desc',
          per_page: 100,
          page: 1,
        },
      },
    ]);
    expect(prs[0]).toEqual({
      number: 7,
      title: 'Add retries',
      author: 'hubot',
      draft: true,
      url: 'https://github.com/o/r/pull/7',
      headRef: 'retries',
      baseRef: 'main',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      labels: ['backend'],
      requestedReviewers: ['octocat'],
    });
    expect(prs[1]).toMatchObject({ number: 8, title: '', author: 'ghost', draft: false });
  });

  it('paginates files', async () => {
    let pages = 0;
    const rest: RestLike = {
      async request(_route, params) {
        pages++;
        const n = params?.page === 1 ? 100 : 3;
        return {
          data: Array.from({ length: n }, (_, i) => ({
            filename: `f${params?.page}-${i}`,
            status: 'added',
            additions: 1,
            deletions: 0,
            changes: 1,
            patch: '@@ -0,0 +1 @@\n+x',
          })),
        };
      },
    };
    const files = await createGitHubClient({ rest, gql: noGql }).fetchFiles(ref);
    expect(files).toHaveLength(103);
    expect(pages).toBe(2);
  });

  it('decodes and caches file content by path and sha', async () => {
    let n = 0;
    const rest: RestLike = {
      async request() {
        n++;
        return { data: { encoding: 'base64', content: Buffer.from('héllo').toString('base64') } };
      },
    };
    const c = createGitHubClient({ rest, gql: noGql });
    expect(await c.fetchFileContent(ref, 'a.ts', 'sha1')).toBe('héllo');
    await c.fetchFileContent(ref, 'a.ts', 'sha1');
    expect(n).toBe(1);
    await c.fetchFileContent(ref, 'a.ts', 'sha2');
    expect(n).toBe(2);
  });

  it('normalizes GraphQL review threads across pages', async () => {
    const gql: GraphqlLike = async (_q, vars) => {
      const first = vars.after === null;
      return {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: first, endCursor: 'c1' },
              nodes: [
                {
                  id: first ? 't1' : 't2',
                  isResolved: false,
                  isOutdated: false,
                  path: 'a.ts',
                  line: 3,
                  originalLine: 3,
                  diffSide: 'RIGHT',
                  startLine: null,
                  comments: {
                    nodes: [
                      {
                        id: 'C1',
                        databaseId: 7,
                        author: { login: 'bob' },
                        body: 'x',
                        createdAt: 'now',
                        url: 'u',
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      };
    };
    const threads = await createGitHubClient({
      rest: { request: async () => ({ data: {} }) },
      gql,
    }).fetchReviewThreads(ref);
    expect(threads.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(threads[0]?.comments[0]).toMatchObject({ databaseId: 7, author: 'bob' });
  });

  it('pages through comments of a thread with more than 100', async () => {
    const comment = (n: number) => ({
      id: `C${n}`,
      databaseId: n,
      author: { login: 'bob' },
      body: `b${n}`,
      createdAt: 'now',
      url: 'u',
    });
    const queries: Record<string, unknown>[] = [];
    const gql: GraphqlLike = async (q, vars) => {
      queries.push(vars);
      if (q.includes('node(id')) {
        return {
          node: {
            comments: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [comment(101), comment(102)],
            },
          },
        };
      }
      return {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: 'T1',
                  path: 'a.ts',
                  diffSide: 'RIGHT',
                  comments: {
                    pageInfo: { hasNextPage: true, endCursor: 'cc1' },
                    nodes: Array.from({ length: 100 }, (_, i) => comment(i + 1)),
                  },
                },
                {
                  id: 'T2',
                  path: 'b.ts',
                  diffSide: 'RIGHT',
                  comments: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [comment(500)],
                  },
                },
              ],
            },
          },
        },
      };
    };
    const threads = await createGitHubClient({
      rest: { request: async () => ({ data: {} }) },
      gql,
    }).fetchReviewThreads(ref);
    expect(threads[0]?.comments.map((c) => c.databaseId)).toEqual(
      Array.from({ length: 102 }, (_, i) => i + 1),
    );
    expect(threads[1]?.comments).toHaveLength(1);
    expect(queries).toHaveLength(2);
    expect(queries[1]).toEqual({ id: 'T1', after: 'cc1' });
  });

  it('posts reviews with commit_id', async () => {
    let seen: Record<string, unknown> | undefined;
    const rest: RestLike = {
      async request(_r, params) {
        seen = params;
        return { data: { id: 5, html_url: 'u' } };
      },
    };
    const res = await createGitHubClient({ rest, gql: noGql }).submitReview(ref, {
      headSha: 'h',
      event: 'COMMENT',
      body: 'b',
      comments: [],
    });
    expect(res).toEqual({ id: 5, url: 'u' });
    expect(seen).toMatchObject({ commit_id: 'h', event: 'COMMENT', pull_number: 1 });
  });
});

describe('github client compare', () => {
  it('maps commits and files, and returns undefined on 404/422', async () => {
    const calls: string[] = [];
    const rest: RestLike = {
      async request(route, params) {
        calls.push(`${route} ${String(params?.basehead)}`);
        if (params?.basehead === 'gone...new') {
          throw Object.assign(new Error('Not Found'), { status: 404 });
        }
        if (params?.basehead === 'bad...new') {
          throw Object.assign(new Error('Unprocessable'), { status: 422 });
        }
        if (params?.basehead === 'boom...new') {
          throw Object.assign(new Error('boom'), { status: 500 });
        }
        return {
          data: {
            commits: [
              {
                sha: 'c1',
                author: { login: 'octocat' },
                commit: { message: 'fix', author: { name: 'O', date: '2026-01-01T00:00:00Z' } },
              },
            ],
            files: [{ filename: 'a.ts' }, { filename: 'b.ts' }],
          },
        };
      },
    };
    const gh = createGitHubClient({ rest, gql: noGql });
    expect(await gh.compareCommits(ref, 'old', 'new')).toEqual({
      commits: [{ sha: 'c1', message: 'fix', author: 'octocat', date: '2026-01-01T00:00:00Z' }],
      files: ['a.ts', 'b.ts'],
      totalCommits: 1,
    });
    expect(calls[0]).toBe('GET /repos/{owner}/{repo}/compare/{basehead} old...new');
    expect(await gh.compareCommits(ref, 'gone', 'new')).toBeUndefined();
    expect(await gh.compareCommits(ref, 'bad', 'new')).toBeUndefined();
    await expect(gh.compareCommits(ref, 'boom', 'new')).rejects.toThrow('boom');
  });

  const fakeCompare = (total: number, fileCount: number) => {
    const pages: number[] = [];
    const rest: RestLike = {
      async request(_route, params) {
        const page = Number(params?.page);
        pages.push(page);
        const from = (page - 1) * 100;
        const n = Math.max(0, Math.min(100, total - from));
        return {
          data: {
            total_commits: total,
            commits: Array.from({ length: n }, (_, i) => ({
              sha: `c${from + i}`,
              commit: { message: 'm' },
            })),
            files:
              page === 1
                ? Array.from({ length: fileCount }, (_, i) => ({ filename: `f${i}` }))
                : [],
          },
        };
      },
    };
    return { gh: createGitHubClient({ rest, gql: noGql }), pages };
  };

  it('follows pages until every commit is fetched', async () => {
    const { gh, pages } = fakeCompare(150, 3);
    const r = await gh.compareCommits(ref, 'a', 'b');
    expect(pages).toEqual([1, 2]);
    expect(r?.commits).toHaveLength(150);
    expect(r?.commits[149]?.sha).toBe('c149');
    expect(r).toMatchObject({ totalCommits: 150 });
    expect(r?.commitsTruncated).toBeUndefined();
    expect(r?.filesTruncated).toBeUndefined();
  });

  it('flags the 300-file limit and caps commits at 1,000', async () => {
    const { gh, pages } = fakeCompare(2500, 300);
    const r = await gh.compareCommits(ref, 'a', 'b');
    expect(pages).toHaveLength(10);
    expect(r?.commits).toHaveLength(1000);
    expect(r).toMatchObject({ totalCommits: 2500, commitsTruncated: true, filesTruncated: true });
    expect(r?.files).toHaveLength(300);
  });
});

describe('github client publish methods', () => {
  const repo = { owner: 'o', repo: 'r' };
  const prData = { number: 7, head: { sha: 'abc' }, html_url: 'https://x/pull/7', draft: true };

  function recorder(respond: (route: string) => unknown) {
    const calls: { route: string; params?: Record<string, unknown> }[] = [];
    const rest: RestLike = {
      async request(route, params) {
        calls.push({ route, params });
        return { data: respond(route) };
      },
    };
    return { calls, client: createGitHubClient({ rest, gql: noGql }) };
  }

  it('findOpenPrForBranch queries by owner:branch', async () => {
    const { calls, client } = recorder(() => [prData]);
    expect(await client.findOpenPrForBranch(repo, 'bp/x')).toEqual({
      number: 7,
      headSha: 'abc',
      url: 'https://x/pull/7',
      draft: true,
      state: 'open',
    });
    expect(calls[0]).toEqual({
      route: 'GET /repos/{owner}/{repo}/pulls',
      params: { owner: 'o', repo: 'r', head: 'o:bp/x', state: 'open' },
    });
    const none = recorder(() => []);
    expect(await none.client.findOpenPrForBranch(repo, 'bp/x')).toBeUndefined();
  });

  it('createPr posts a draft', async () => {
    const { calls, client } = recorder(() => prData);
    const pr = await client.createPr(repo, {
      head: 'bp/x',
      base: 'main',
      title: 'T',
      body: 'B',
      draft: true,
    });
    expect(pr.number).toBe(7);
    expect(calls[0]).toEqual({
      route: 'POST /repos/{owner}/{repo}/pulls',
      params: {
        owner: 'o',
        repo: 'r',
        head: 'bp/x',
        base: 'main',
        title: 'T',
        body: 'B',
        draft: true,
      },
    });
  });

  it('updatePr patches title and body', async () => {
    const { calls, client } = recorder(() => prData);
    expect((await client.updatePr(repo, 7, { title: 'T2', body: 'B2' })).number).toBe(7);
    expect(calls[0]).toEqual({
      route: 'PATCH /repos/{owner}/{repo}/pulls/{pull_number}',
      params: { owner: 'o', repo: 'r', pull_number: 7, title: 'T2', body: 'B2' },
    });
  });

  it('getPr reports closed and merged PRs', async () => {
    const closed = recorder(() => ({ ...prData, state: 'closed' }));
    expect((await closed.client.getPr(repo, 7)).state).toBe('closed');
    const merged = recorder(() => ({ ...prData, state: 'closed', merged: true }));
    expect((await merged.client.getPr(repo, 7)).state).toBe('merged');
  });

  it('getPr reads one PR', async () => {
    const { calls, client } = recorder(() => prData);
    expect((await client.getPr(repo, 7)).headSha).toBe('abc');
    expect(calls[0]).toEqual({
      route: 'GET /repos/{owner}/{repo}/pulls/{pull_number}',
      params: { owner: 'o', repo: 'r', pull_number: 7 },
    });
  });

  type Run = { name: string; status: string; conclusion: string | null };
  type St = { context: string; state: string };
  async function ci(runs: Run[], statuses: St[]) {
    const { calls, client } = recorder((route) =>
      route.endsWith('check-runs')
        ? { check_runs: runs.map((r) => ({ ...r, html_url: 'u' })) }
        : {
            state: statuses.some((x) => x.state === 'failure' || x.state === 'error')
              ? 'failure'
              : statuses.some((x) => x.state === 'pending')
                ? 'pending'
                : 'success',
            total_count: statuses.length,
            statuses,
          },
    );
    return { calls, status: await client.getCiStatus(repo, 'sha1') };
  }
  const run = (status: string, conclusion: string | null): Run => ({
    name: 'n',
    status,
    conclusion,
  });

  it('requests check-runs and status for the sha', async () => {
    const { calls } = await ci([], []);
    expect(calls.map((c) => c.route)).toEqual([
      'GET /repos/{owner}/{repo}/commits/{ref}/check-runs',
      'GET /repos/{owner}/{repo}/commits/{ref}/status',
    ]);
    expect(calls[0]!.params).toMatchObject({ ref: 'sha1', per_page: 100 });
  });

  it.each([
    ['nothing at all', [], [], 'none'],
    ['all success', [run('completed', 'success'), run('completed', 'skipped')], [], 'success'],
    ['neutral counts as ok', [run('completed', 'neutral')], [], 'success'],
    ['in progress', [run('in_progress', null)], [], 'pending'],
    ['queued', [run('queued', null)], [], 'pending'],
    ['failure', [run('completed', 'failure')], [], 'failure'],
    ['cancelled', [run('completed', 'cancelled')], [], 'failure'],
    ['timed_out', [run('completed', 'timed_out')], [], 'failure'],
    ['failure beats pending', [run('completed', 'failure'), run('queued', null)], [], 'failure'],
    ['pending + success', [run('completed', 'success'), run('queued', null)], [], 'pending'],
    ['status success only', [], [{ context: 'ci', state: 'success' }], 'success'],
    ['status pending', [], [{ context: 'ci', state: 'pending' }], 'pending'],
    ['status failure', [], [{ context: 'ci', state: 'failure' }], 'failure'],
    ['status error', [], [{ context: 'ci', state: 'error' }], 'failure'],
    [
      'run success + status failure',
      [run('completed', 'success')],
      [{ context: 'ci', state: 'failure' }],
      'failure',
    ],
  ] as [string, Run[], St[], string][])('CI state: %s -> %s', async (_n, runs, statuses, want) => {
    const { status } = await ci(runs, statuses);
    expect(status.state).toBe(want);
    expect(status.checks).toHaveLength(runs.length + statuses.length);
  });

  describe('CI pagination', () => {
    const mkRuns = (n: number, over: Partial<Run> = {}, offset = 0): Run[] =>
      Array.from({ length: n }, (_, i) => ({
        name: `c${offset + i}`,
        status: 'completed',
        conclusion: 'success',
        ...over,
      }));
    function paged(all: Run[], combined: Record<string, unknown> = {}) {
      const { calls, client } = (() => {
        const calls: { route: string; params?: Record<string, unknown> }[] = [];
        const rest: RestLike = {
          async request(route, params) {
            calls.push({ route, params });
            if (route.endsWith('check-runs')) {
              const page = params!.page as number;
              const slice = all.slice((page - 1) * 100, page * 100);
              return {
                data: {
                  total_count: all.length,
                  check_runs: slice.map((r) => ({ ...r, html_url: 'u' })),
                },
              };
            }
            return { data: { state: 'success', total_count: 0, statuses: [], ...combined } };
          },
        };
        return { calls, client: createGitHubClient({ rest, gql: noGql }) };
      })();
      return { calls, client };
    }

    it('failure on page 2 -> failure', async () => {
      const all = [...mkRuns(100), ...mkRuns(1, { conclusion: 'failure' }, 100)];
      const { client, calls } = paged(all);
      expect((await client.getCiStatus(repo, 's')).state).toBe('failure');
      expect(calls.filter((c) => c.route.endsWith('check-runs'))).toHaveLength(2);
    });

    it('pending on page 2 -> pending', async () => {
      const all = [...mkRuns(100), ...mkRuns(1, { status: 'queued', conclusion: null }, 100)];
      const { client } = paged(all);
      expect((await client.getCiStatus(repo, 's')).state).toBe('pending');
    });

    it('hitting the page cap never reports success', async () => {
      const { client, calls } = paged(mkRuns(1500));
      const status = await client.getCiStatus(repo, 's');
      expect(status.state).toBe('pending');
      expect(status.checks.at(-1)?.name).toBe('block-party: results truncated');
      expect(calls.filter((c) => c.route.endsWith('check-runs'))).toHaveLength(10);
    });

    it('combined failure with an empty statuses page -> failure', async () => {
      const { client } = paged(mkRuns(1), { state: 'failure', total_count: 150, statuses: [] });
      expect((await client.getCiStatus(repo, 's')).state).toBe('failure');
    });

    it('combined pending with statuses -> pending', async () => {
      const { client } = paged(mkRuns(1), { state: 'pending', total_count: 3, statuses: [] });
      expect((await client.getCiStatus(repo, 's')).state).toBe('pending');
    });
  });
});
