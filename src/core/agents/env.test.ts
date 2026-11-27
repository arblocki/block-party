import { describe, expect, it } from 'vitest';
import { agentEnv } from './env.js';

describe('agentEnv', () => {
  it('drops GitHub and block-party secrets and other API keys', () => {
    const out = agentEnv({
      GITHUB_TOKEN: 'a',
      GH_TOKEN: 'b',
      GH_ENTERPRISE_TOKEN: 'c',
      BLOCK_PARTY_TOKEN: 'd',
      BLOCK_PARTY_SESSION_SECRET: 'e',
      OPENROUTER_API_KEY: 'f',
      STRIPE_API_KEY: 'g',
      PATH: '/bin',
    });
    expect(out).toEqual({ PATH: '/bin' });
  });

  it('keeps PATH, HOME, the hook variables and the adapters API keys', () => {
    const env = {
      PATH: '/bin',
      HOME: '/home/x',
      BLOCK_PARTY_HOME: '/data',
      BLOCK_PARTY_RUN_ID: 'run-1',
      ANTHROPIC_API_KEY: 'k1',
      OPENAI_API_KEY: 'k2',
      CLAUDE_CONFIG_DIR: '/c',
    };
    expect(agentEnv(env)).toEqual(env);
  });

  it('drops a parent Claude Code session markers and does not modify its input', () => {
    const env = { CLAUDECODE: '1', GH_TOKEN: 'x', PATH: '/bin' };
    expect(agentEnv(env)).toEqual({ PATH: '/bin' });
    expect(env).toEqual({ CLAUDECODE: '1', GH_TOKEN: 'x', PATH: '/bin' });
  });
});
