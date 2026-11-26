import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { renderChecksYaml } from '../../core/checks/config.js';
import { loadProjectChecks } from '../../core/checks/load.js';
import { runChecks } from '../../core/checks/run.js';
import { REPO_CONFIG_FILES } from '../../core/risk/repo-config.js';

const CHECKS_USAGE = `Usage: block-party checks init [--repo <dir>] [--write]
       block-party checks run [--repo <dir>]`;

function fail(message: string): void {
  console.error(message);
  process.exitCode = 2;
}

function printDrift(drift: NonNullable<ReturnType<typeof loadProjectChecks>['drift']>): void {
  if (drift.missing.length === 0 && drift.stale.length === 0 && drift.warnings.length === 0) {
    console.log('\nCI parity: no drift.');
    return;
  }
  console.log('\nCI parity drift:');
  for (const m of drift.missing) console.log(`  missing: ${m.ref} (${m.command.split('\n')[0]})`);
  for (const s of drift.stale) console.log(`  stale: ${s.check} -> ${s.ref}`);
  for (const w of drift.warnings) console.log(`  warning: ${w}`);
}

function init(dir: string, write: boolean): void {
  const loaded = loadProjectChecks(dir);
  for (const e of loaded.errors) console.error(`warning: ${e}`);
  const yaml = renderChecksYaml(loaded.proposal);
  console.log(yaml);
  if (!loaded.parityMeasurable) console.log('CI parity cannot be measured (no PR workflows).');
  if (loaded.drift) printDrift(loaded.drift);
  if (!write) return;
  const existing = REPO_CONFIG_FILES.find((f) => existsSync(join(dir, f)));
  if (existing) {
    fail(
      `${existing} already exists; not overwriting. Paste the printed checks: block into it instead.`,
    );
    return;
  }
  writeFileSync(join(dir, REPO_CONFIG_FILES[0]), yaml, { flag: 'wx' });
  console.log(`Wrote ${REPO_CONFIG_FILES[0]}`);
}

async function runCommand(dir: string): Promise<void> {
  const loaded = loadProjectChecks(dir);
  for (const e of loaded.errors) console.error(`warning: ${e}`);
  if (!loaded.config) {
    fail('No checks: section in .block-party.yaml. Run `block-party checks init` first.');
    return;
  }
  const logDir = mkdtempSync(join(tmpdir(), 'block-party-checks-'));
  const { passed, results } = await runChecks({
    cwd: dir,
    checks: loaded.config.required,
    logDir,
    headSha: 'local',
  });
  const width = Math.max(4, ...results.map((r) => r.name.length));
  for (const r of results) {
    const status = r.timedOut ? 'TIMEOUT' : r.exitCode === 0 ? 'PASS' : `FAIL (${r.exitCode})`;
    console.log(
      `${r.name.padEnd(width)}  ${status.padEnd(10)} ${(r.durationMs / 1000).toFixed(1)}s  ${r.logPath}`,
    );
  }
  console.log(passed ? '\nAll required checks passed.' : '\nSome required checks failed.');
  if (!passed) process.exitCode = 1;
}

export async function checksMain(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === '--help' || sub === '-h') {
    console.log(CHECKS_USAGE);
    return;
  }
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: { repo: { type: 'string' }, write: { type: 'boolean', default: false } },
    }));
  } catch (err) {
    fail(`${(err as Error).message}\n\n${CHECKS_USAGE}`);
    return;
  }
  const dir = resolve(values.repo ?? process.cwd());
  if (sub === 'init') return init(dir, values.write);
  if (sub === 'run') return runCommand(dir);
  fail(`Unknown checks command: ${sub}\n\n${CHECKS_USAGE}`);
}
