/** Credentials that must never reach agents, local checks or the herdr server. */
export const SECRET_ENV_VARS = ['GITHUB_TOKEN', 'GH_TOKEN', 'BLOCK_PARTY_TOKEN'] as const;

/**
 * Set by a Claude Code session for its child processes when block-party itself runs inside
 * one. Agents must start as their own sessions (a child-session marker disables transcript
 * saving), and the messaging socket and token would let any agent or check talk to the
 * parent session. User configuration such as `CLAUDE_CONFIG_DIR` or
 * `CLAUDE_CODE_USE_BEDROCK` is not in this list and is kept.
 */
export const PARENT_SESSION_ENV_VARS = [
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
] as const;

/** A copy of `env` without secrets or a parent Claude Code session's markers. */
export function scrubbedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of [...SECRET_ENV_VARS, ...PARENT_SESSION_ENV_VARS]) delete out[k];
  return out;
}
