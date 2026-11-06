# Spike: CI parity (`checks init` and drift detection)

Pure core in `src/core/checks/` for ARCHITECTURE 5.4. No CLI wiring and no process spawning yet.

## What it does

- `workflows.ts`: `parseWorkflow(file, text)` turns workflow YAML into workflows, jobs and steps
  (run steps with name, command, working-directory, shell, `if`; `uses` steps), plus `needs`,
  job `if`, matrix keys (not expanded) and whether it runs on `pull_request` or
  `pull_request_target`. Bad input returns `{ ok: false, error }`; it never throws.
- `propose.ts`: `proposeChecks(...)` proposes one check per meaningful run step in PR-triggered
  jobs. `uses:` steps and pure install/setup commands are skipped; the install command becomes
  `setup`. Names are kebab-case and deduped; `ci` is `file#job/<step-name-or-index>`. `${{ }}`
  commands and conditional steps/jobs get `needsReview` (rendered commented out). Multi-line
  `run:` stays one check. With no usable workflows it falls back to well-known `package.json`
  scripts using the lockfile-detected package manager, with `source: 'package-scripts'`.
- `drift.ts`: `detectDrift(config, workflows)` returns CI run steps with no local check and not
  in `ciParity.ignore` (`missing`), and configured `ci` refs that no longer resolve (`stale`).
  A job-only ref (`ci.yml#lint`) covers all of that job's run steps. `ignore` accepts a job id,
  `file#job`, or a full step ref. Scope is `ciParity.workflows`, else every PR-triggered workflow.
- `config.ts`: zod schema for `checks:` (`setup`, `required[]`, `optional[]`,
  `ciParity { workflows, ignore }`; each check is `name`, `run`, `ci?`, `cwd?`),
  `parseChecksConfig(text)`, and `renderChecksYaml(proposal)`.

## Proposal for this repo

This repo has no `.github/` directory, so the fallback applies (pnpm via `pnpm-lock.yaml`):

```yaml
# No GitHub Actions workflows found: CI parity cannot be measured
checks:
  setup: pnpm install --frozen-lockfile
  required:
    - { name: typecheck, run: pnpm typecheck }
    - { name: lint, run: pnpm lint }
    - { name: test, run: pnpm test }
    - { name: build, run: pnpm build }
```

## Limitations

- Step matching is by index or kebab-cased step name; renaming a step makes its ref stale (by
  design: the user is told).
- Matrices are not expanded; one configuration is proposed and a note is added.
- Install detection is a conservative regex; compound commands (`pnpm i && pnpm test`) are treated
  as real checks.
- Reusable workflows (`jobs.<id>.uses`), composite actions, and `workflow_call` are not followed;
  steps inside them are invisible to proposal and drift.
- Env, secrets, services containers, and `runs-on` are ignored, so a proposed command may need
  environment the local run lacks.
- Working directory resolves step > job `defaults.run` > workflow `defaults.run`. Install steps with a
  condition, `${{ }}`, or their own working directory are not emitted as `setup`; they are rendered
  as a commented-out `setup` with a review note.
- `cwd` is the name chosen for a step's `working-directory`; ARCHITECTURE 5.4 does not specify it.

## Notes for Phase 1

- `act` is not installed here; Docker is (`/usr/local/bin/docker`). The `act` mode stays optional.
- The loader (read `.github/workflows/*.yml`, `package.json`, lockfile names) is not written;
  feed `parseWorkflow` file texts and pass `lockfiles` to `proposeChecks`.
- Run drift on every run and surface `missing` and `stale` in the evidence panel; show
  `source: 'package-scripts'` as "CI parity cannot be measured".
- Decide whether `needsReview` checks should block `checks init` output or stay as comments.
