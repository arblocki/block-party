import { homedir } from 'node:os';
import { join } from 'node:path';
import { dataDir } from '../paths.js';

type Env = Record<string, string | undefined>;

const SAFE = /^[A-Za-z0-9._-]+$/;

function safeSegment(label: string, value: string): string {
  if (!SAFE.test(value) || value === '.' || value === '..') {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}

export function runsRoot(env: Env = process.env, home: string = homedir()): string {
  return join(dataDir(env, home), 'runs');
}

export function runDir(runId: string, env: Env = process.env, home: string = homedir()): string {
  return join(runsRoot(env, home), safeSegment('runId', runId));
}

export function worktreesRoot(env: Env = process.env, home: string = homedir()): string {
  return join(dataDir(env, home), 'worktrees');
}

export function worktreePath(
  owner: string,
  repo: string,
  runId: string,
  env: Env = process.env,
  home: string = homedir(),
): string {
  return join(
    worktreesRoot(env, home),
    `${safeSegment('owner', owner)}__${safeSegment('repo', repo)}`,
    safeSegment('runId', runId),
  );
}
