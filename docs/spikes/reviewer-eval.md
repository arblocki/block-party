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
| real-codex-cli-adapter (`f03fe43`; bugs fixed later by `d1697ab` and `bf0bc09`) | git | 2 | 1 (P2, cwd) | n/a | 49.0 s |

Headline: recall 4/4 on planted bugs, 1/2 on the real-history case (5/6 overall), 0 false positives
on 2 negative cases, 0 failed runs. Cost was roughly 60-80k input tokens per synthetic case
(mostly cached) and 168k for the real range.

Extra findings (not matched to an expectation):

- sql-injection: P2 "Escape LIKE metacharacters", a legitimate secondary issue.
- real-codex-cli-adapter: P1 `--allowedTools` is not a read-only restriction (`claude-cli.ts`) and
  P2 abort/timeout errors lost while reading the response body (`openrouter.ts`); plausible,
  unverified.

## Interpretation

What it catches: all four planted bugs were found at the right file, at P0/P1 with high
confidence, in about 20-25 s each. That includes the two that need more than pattern matching: the
off-by-one (found and anchored on the exact `while` line) and the plan-vs-code gap (it read the plan
and flagged the missing constructor validation). It also volunteered a real secondary issue on the
SQL case.

What it misses: one of the two real bugs in the real-history case. The reviewed range is `f03fe43`
(1,450 lines, 19 files). Two bugs visible in its diff were fixed later: `d1697ab` (without `--cd`
support the codex child inherits the wrong cwd; `cwd: req.cwd ? undefined : dir`), which Codex found
at P2, and `bf0bc09` (`--json` only requested when `--output-last-message` is unsupported, so usage
is lost on the preferred path), which it missed. Note `f5195e2` is deliberately not used for
expectations: it fixed environment-dependent problems (user MCP config breaking `codex exec`,
`gpt-5-codex` rejected on ChatGPT logins) that cannot be seen in any diff. The first version of this
eval used those and scored 0/2, which measured nothing; the saved results were re-scored against the
visible-bug expectations without re-running Codex.

Can empty findings be trusted yet? Not as "clean". The sample is small (4 planted bugs, 2
negatives, one run each, no variance measurement), the planted bugs are textbook-shaped and 1-3
files long, and the single real case was a 1,450-line, 19-file change where it found one of two known
bugs plus unverified extras. The data supports: on small, local,
well-specified diffs, an empty result is meaningful and false positives are rare. It does not
support: large diffs, bugs that depend on runtime environment, or subtle cross-file interactions.
Keep the PR body wording "Codex found nothing" rather than "clean" until a larger eval says
otherwise.

## Suggested next steps

Recall on planted bugs is strong, so no prompt change is warranted from this data. The one real
miss (`bf0bc09`) is a "declared-but-unused data path" bug: usage is parsed from the event stream,
but the flag that produces that stream is conditionally omitted. A prompt addition to try (and
re-measure with this harness): "For every value the code reads or parses, trace where it is
produced and check each branch that decides whether it is produced at all." Also consider a
larger-diff strategy (review per directory) since attention on a 19-file change is thinner.
Before relying on recall numbers, extend the eval with: several runs per case to measure variance,
5+ more negatives including larger correct diffs, and more real-history cases whose bug is visible
in the diff. Environment-dependent bugs (like those `f5195e2` fixed) need a different kind of check,
not diff review.
