import { describe, expect, it } from 'vitest';
import { canStart, projectLabel, toRunRequest, type NewRunState } from './newRun';

const ok: NewRunState = {
  projectId: 'p1',
  baseRef: 'main',
  source: 'paste',
  description: '',
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

describe('canStart in describe mode', () => {
  const d: NewRunState = {
    ...ok,
    source: 'describe',
    description: 'Add a login page',
    planText: '',
    planValid: false,
  };
  it('needs a description of 1-20000 characters, not a valid plan', () => {
    expect(canStart(d)).toBe(true);
    expect(canStart({ ...d, description: '  ' })).toBe(false);
    expect(canStart({ ...d, description: 'x'.repeat(20000) })).toBe(true);
    expect(canStart({ ...d, description: 'x'.repeat(20001) })).toBe(false);
    expect(canStart({ ...d, projectId: '' })).toBe(false);
  });
  it('ignores a pasted plan in describe mode, and a description in paste mode', () => {
    expect(canStart({ ...d, planText: '# Plan', planValid: true, description: '' })).toBe(false);
    expect(canStart({ ...ok, description: 'something', planValid: false })).toBe(false);
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

describe('toRunRequest source', () => {
  it('sends only the description in describe mode', () => {
    const body = toRunRequest({
      ...ok,
      source: 'describe',
      description: ' Add login ',
      planText: '# Old',
    });
    expect(body.description).toBe('Add login');
    expect('planText' in body).toBe(false);
  });
  it('sends only the plan text in paste mode', () => {
    const body = toRunRequest({ ...ok, description: 'ignored' });
    expect(body.planText).toBe('# Plan');
    expect('description' in body).toBe(false);
  });
});
