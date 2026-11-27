import { scrubbedEnv } from '../process/env.js';

/**
 * `BLOCK_PARTY_*` variables an agent still gets: `block-party hook` runs inside the agent's
 * environment and finds the data directory (and so the runs directory it may write under)
 * through `BLOCK_PARTY_HOME`; `BLOCK_PARTY_RUN_ID` names the run for anything that logs it.
 */
const KEPT_BLOCK_PARTY = new Set(['BLOCK_PARTY_HOME', 'BLOCK_PARTY_RUN_ID']);

/** API keys an agent adapter may need (Claude Code and Codex authenticate with these). */
const KEPT_API_KEYS = new Set(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);

/**
 * The environment an agent process (Claude Code, Codex) starts with: everything in `base`
 * except credentials. Drops GitHub tokens (including `GH_ENTERPRISE_TOKEN`), every
 * `BLOCK_PARTY_*` variable but the two the hook needs, every `*_API_KEY` but the two adapters
 * authenticate with, and a parent Claude Code session's markers (see scrubbedEnv). PATH,
 * HOME and the rest pass through. Does not modify `base`.
 */
export function agentEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = scrubbedEnv(base);
  for (const k of Object.keys(out)) {
    const drop =
      k === 'GH_ENTERPRISE_TOKEN' ||
      (k.startsWith('BLOCK_PARTY_') && !KEPT_BLOCK_PARTY.has(k)) ||
      (k.endsWith('_API_KEY') && !KEPT_API_KEYS.has(k));
    if (drop) delete out[k];
  }
  return out;
}
