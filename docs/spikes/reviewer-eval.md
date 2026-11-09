# Reviewer eval: can Codex's "no findings" be trusted?

Date: 2026-11-09. Codex: `codex-cli 0.162.1`, default model (no `--model`), reviewer `CODEX_HOME`
(auth only), read-only sandbox, one round, no prior findings. Run with `pnpm eval:reviewer`
(about 3 minutes, 7 cases, one run each). Scoring is `src/core/reviewer/eval-score.ts`; cases are
`test/fixtures/reviewer-eval/*.json`.

## Cases and results

| Case | Kind | Expected | Matched | False positives (P0-P2) | Duration |
| --- | --- | --- | --- | --- | --- |
| sql-injection (string-interpolated `ILIKE`) | synthetic | 1 | 1 (P0) | n/a | 25.1 s |
| pagination-off-by-one (`offset < total - 1`) | synthetic | 1 | 1 (P1, by line) | n/a | 20.2 s |
| missing-await (`store.write` not awaited in try/catch) | synthetic | 1 | 1 (P1) | n/a | 20.5 s |
| missing-acceptance-criterion (plan requires constructor `RangeError`) | synthetic | 1 | 1 (P1) | n/a | 22.3 s |
| negative-slugify (correct util + tests) | negative | 0 | n/a | 0 | 21.4 s |
| negative-correct-query-and-pagination (parameterized, validated) | negative | 0 | n/a | 0 | 22.1 s |
| real-codex-cli-config (`f03fe43`, fixed later by `f5195e2`) | git | 2 | 0 | n/a | 49.0 s |

Headline: recall 4/4 on planted bugs, 0/2 on the real-history case (4/6 overall), 0 false positives
on 2 negative cases, 0 failed runs. Cost was roughly 60-80k input tokens per synthetic case
(mostly cached) and 168k for the real range.

Extra findings (not matched to an expectation):

- sql-injection: P2 "Escape LIKE metacharacters", a legitimate secondary issue.
- real-codex-cli-config: P2 `--cd` unavailable so the checkout is not honored
  (`codex-cli.ts:83`), P1 `--allowedTools` is not a read-only restriction (`claude-cli.ts`),
  P2 abort/timeout errors lost while reading the response body (`openrouter.ts`).

## Interpretation

What it catches: all four planted bugs were found at the right file, at P0/P1 with high
confidence, in about 20-25 s each. That includes the two that need more than pattern matching: the
off-by-one (found and anchored on the exact `while` line) and the plan-vs-code gap (it read the plan
and flagged the missing constructor validation). It also volunteered a real secondary issue on the
SQL case.

What it misses: both expectations on the real-history case. Those two expectations were what
`f5195e2` fixed: the codex adapter not passing `--ignore-user-config` (a user's MCP plugins needing
OAuth break `codex exec`), and the default model `gpt-5-codex` being rejected on ChatGPT-account
logins. Both are environment-dependent failures that cannot be derived from the diff alone, so a
miss is not strong evidence of weakness; they do show the reviewer does not reason about "what
happens on a real developer machine" unprompted. The review was not empty, though: its first extra
finding (`--cd` unsupported, so the child inherits the wrong cwd) is the bug fixed by `d1697ab`, a
genuine real-history hit that the expectation list did not include (the case was written from
`f5195e2` only). The other two extras are plausible but unverified. Treat the 0/2 as "the
expectations were unobservable", not as a measured recall of 0.

Can empty findings be trusted yet? Not as "clean". The sample is small (4 planted bugs, 2
negatives, one run each, no variance measurement), the planted bugs are textbook-shaped and 1-3
files long, and the single real case was a 1,450-line, 19-file change where it found real but
different issues and missed environment-dependent ones. The data supports: on small, local,
well-specified diffs, an empty result is meaningful and false positives are rare. It does not
support: large diffs, bugs that depend on runtime environment, or subtle cross-file interactions.
Keep the PR body wording "Codex found nothing" rather than "clean" until a larger eval says
otherwise.

## Suggested next steps

Recall on planted bugs is strong, so no prompt change is warranted from this data. For the gap the
real case exposed, a concrete prompt addition to try (and re-measure with this harness): "For each
external process or service the change calls, consider how it behaves on a machine with a normal
user configuration and different account type (user-level config files, plugins, auth, model
availability), and report assumptions the code makes about them." Before relying on recall
numbers, extend the eval with: several runs per case to measure variance, 5+ more negatives
including larger correct diffs, and more real-history cases whose bug is visible in the diff
(add `d1697ab` and `bf0bc09`, both fixes to `f03fe43`, as expectations for the real case).
