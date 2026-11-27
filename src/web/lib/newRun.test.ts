import { describe, expect, it } from 'vitest';
import { canStart, startBranch, toRunRequest, type NewRunState } from './newRun';

const ok: NewRunState = {
  projectId: 'p1',
  defaultBranch: 'main',
  baseRef: '',
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
    expect(canStart({ ...ok, defaultBranch: ' ' })).toBe(false);
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

describe('start branch', () => {
  it('defaults to the repo default branch and lets Advanced override it', () => {
    expect(startBranch({ defaultBranch: 'trunk', baseRef: '' })).toBe('trunk');
    expect(startBranch({ defaultBranch: 'trunk', baseRef: '  ' })).toBe('trunk');
    expect(startBranch({ defaultBranch: 'trunk', baseRef: ' dev ' })).toBe('dev');
  });
  it('can start without typing a branch, but not without any branch', () => {
    expect(canStart({ ...ok, defaultBranch: 'trunk', baseRef: '' })).toBe(true);
    expect(canStart({ ...ok, defaultBranch: '', baseRef: '' })).toBe(false);
    expect(canStart({ ...ok, defaultBranch: '', baseRef: 'dev' })).toBe(true);
  });
});

describe('toRunRequest', () => {
  it('omits blank title and model', () => {
    expect(toRunRequest({ ...ok, defaultBranch: 'trunk' })).toEqual({
      projectId: 'p1',
      baseRef: 'trunk',
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
