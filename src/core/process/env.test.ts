import { describe, expect, it } from 'vitest';
import { scrubbedEnv } from './env.js';

describe('scrubbedEnv', () => {
  it('drops GitHub and block-party credentials', () => {
    const out = scrubbedEnv({ GITHUB_TOKEN: 'a', GH_TOKEN: 'b', BLOCK_PARTY_TOKEN: 'c', X: '1' });
    expect(out).toEqual({ X: '1' });
  });

  it("drops the parent Claude Code session's markers and messaging credentials", () => {
    const out = scrubbedEnv({
      CLAUDECODE: '1',
      CLAUDE_PID: '42',
      CLAUDE_EFFORT: 'high',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_EXECPATH: '/x/claude',
      CLAUDE_CODE_SESSION_ID: 's',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ATTENDED: '1',
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/sock',
      CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
      PATH: '/bin',
    });
    expect(out).toEqual({ PATH: '/bin' });
  });

  it("keeps the user's Claude Code configuration", () => {
    const env = {
      CLAUDE_CONFIG_DIR: '/c',
      CLAUDE_CODE_USE_BEDROCK: '1',
      ANTHROPIC_MODEL: 'm',
    };
    expect(scrubbedEnv(env)).toEqual(env);
  });

  it('does not modify its input', () => {
    const env = { GH_TOKEN: 'b' };
    scrubbedEnv(env);
    expect(env).toEqual({ GH_TOKEN: 'b' });
  });
});
