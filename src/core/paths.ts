import { homedir } from 'node:os';
import { join } from 'node:path';

type Env = Record<string, string | undefined>;

/** Data directory (database, caches): $BLOCK_PARTY_HOME or ~/.block-party. */
export function dataDir(env: Env = process.env, home: string = homedir()): string {
  return env.BLOCK_PARTY_HOME || join(home, '.block-party');
}

/** Config directory: $XDG_CONFIG_HOME/block-party or ~/.config/block-party. */
export function configDir(env: Env = process.env, home: string = homedir()): string {
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'block-party');
}

export function dbPath(env: Env = process.env, home: string = homedir()): string {
  return join(dataDir(env, home), 'block-party.db');
}
