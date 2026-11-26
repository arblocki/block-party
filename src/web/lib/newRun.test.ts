import { describe, expect, it } from 'vitest';
import { canStart, projectLabel, toRunRequest, type NewRunState } from './newRun';

const ok: NewRunState = {
  projectId: 'p1',
  baseRef: 'main',
  planText: '# Plan',
  planValid: true,
  title: '',
  mode: 'pane',
  model: '',
  publish: true,
};

describe('canStart', () => {
  it('needs everything', () => {
    expect(canStart(ok)).toBe(true);
    expect(canStart({ ...ok, projectId: '' })).toBe(false);
    expect(canStart({ ...ok, baseRef: '  ' })).toBe(false);
    expect(canStart({ ...ok, planText: ' ' })).toBe(false);
    expect(canStart({ ...ok, planValid: false })).toBe(false);
  });
});

describe('projectLabel', () => {
  it('shows owner/repo and path', () => {
    expect(projectLabel({ owner: 'a', repo: 'b', localPath: '/x/b' })).toBe('a/b — /x/b');
  });
});

describe('toRunRequest', () => {
  it('omits blank title and model', () => {
    expect(toRunRequest(ok)).toEqual({
      projectId: 'p1',
      baseRef: 'main',
      planText: '# Plan',
      mode: 'pane',
      publish: true,
    });
  });
  it('trims and keeps set fields', () => {
    expect(
      toRunRequest({
        ...ok,
        baseRef: ' dev ',
        title: ' T ',
        model: ' m ',
        mode: 'headless',
        publish: false,
      }),
    ).toEqual({
      projectId: 'p1',
      baseRef: 'dev',
      planText: '# Plan',
      title: 'T',
      mode: 'headless',
      model: 'm',
      publish: false,
    });
  });
});
