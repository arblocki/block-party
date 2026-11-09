/** Credentials that must never reach agents, local checks or the herdr server. */
export const SECRET_ENV_VARS = ['GITHUB_TOKEN', 'GH_TOKEN', 'BLOCK_PARTY_TOKEN'] as const;

/** A copy of `env` without the secret variables. */
export function scrubbedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of SECRET_ENV_VARS) delete out[k];
  return out;
}
