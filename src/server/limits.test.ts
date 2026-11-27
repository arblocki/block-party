import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, LimitsConfigError, readLimits } from './limits.js';

const FILE = '/fake/config.yaml';
const reading = (text: string | undefined) => ({ file: FILE, readFile: () => text });

describe('readLimits', () => {
  it('uses the defaults when there is no file', () => {
    expect(readLimits(reading(undefined))).toEqual({ maxRuns: 3, maxRunsPerProject: 2 });
    expect(DEFAULT_LIMITS).toEqual({ maxRuns: 3, maxRunsPerProject: 2 });
  });

  it('uses the defaults for an empty file or one without a limits key', () => {
    expect(readLimits(reading(''))).toEqual(DEFAULT_LIMITS);
    expect(readLimits(reading('other: 1\n'))).toEqual(DEFAULT_LIMITS);
    expect(readLimits(reading('limits:\n'))).toEqual(DEFAULT_LIMITS);
  });

  it('reads the limits key, defaulting what it leaves out', () => {
    expect(readLimits(reading('limits:\n  maxRuns: 5\n  maxRunsPerProject: 1\n'))).toEqual({
      maxRuns: 5,
      maxRunsPerProject: 1,
    });
    expect(readLimits(reading('limits:\n  maxRuns: 4\n'))).toEqual({
      maxRuns: 4,
      maxRunsPerProject: 2,
    });
  });

  it('reads only the limits key: other keys are never validated', () => {
    expect(readLimits(reading('theme: [not, checked]\nlimits:\n  maxRuns: 2\n')).maxRuns).toBe(2);
  });

  it.each([
    ['zero', 'limits:\n  maxRuns: 0\n'],
    ['negative', 'limits:\n  maxRunsPerProject: -1\n'],
    ['fractional', 'limits:\n  maxRuns: 2.5\n'],
    ['text', 'limits:\n  maxRuns: lots\n'],
    ['an unknown limit', 'limits:\n  maxRunz: 3\n'],
    ['a list', 'limits: [1, 2]\n'],
  ])('refuses %s with an error that names the file', (_name, text) => {
    expect(() => readLimits(reading(text))).toThrow(LimitsConfigError);
    expect(() => readLimits(reading(text))).toThrow(FILE);
  });

  it('refuses a file that is not YAML or not a mapping', () => {
    expect(() => readLimits(reading('limits: {unclosed'))).toThrow(/not valid YAML/);
    expect(() => readLimits(reading('- a\n- b\n'))).toThrow(/mapping/);
  });

  it('refuses a file that cannot be read', () => {
    expect(() =>
      readLimits({
        file: FILE,
        readFile: () => {
          throw new Error('EACCES');
        },
      }),
    ).toThrow(/could not be read/);
  });
});
