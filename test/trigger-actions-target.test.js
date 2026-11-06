'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkProject } = require('../src/main/triggers/trigger-actions');

const project = '/work/project';
const snapshot = (hiddenProjects = [], allProjects = [{ projectPath: project }]) => ({
  allProjects, global: { hiddenProjects, hiddenProjectKinds: {} },
});

test('settings-hidden projects take precedence over membership and directory existence', async () => {
  for (const kind of ['archive', 'delete', undefined]) {
    const state = snapshot([project], []);
    if (kind) state.global.hiddenProjectKinds[project] = kind;
    assert.equal(await checkProject(project, async () => state, () => false), 'project is archived');
  }
});

test('group archive, kind-only and remote entries do not hide a known local project', async () => {
  const state = snapshot(['remote:/work/project']);
  state.archivedProjects = { [project]: {} };
  state.global.hiddenProjectKinds[project] = 'archive';
  assert.equal(await checkProject(project, async () => state, () => true), null);
  assert.equal(await checkProject('/work/unknown', async () => state, () => false), 'unknown project');
  assert.equal(await checkProject(project, async () => state, () => false), 'project directory does not exist');
});

test('unavailable project snapshot or provenance refuses admission', async () => {
  assert.equal(await checkProject(project, async () => { throw new Error('unavailable'); }, () => true), 'project lookup unavailable');
  assert.equal(await checkProject(project, async () => ({ allProjects: [] }), () => true), 'project lookup unavailable');
});
