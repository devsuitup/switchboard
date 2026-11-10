'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const espree = require('espree');
const { extractFunction } = require('./app-source');
const filename = path.resolve(__dirname, '../main.js');
const source = fs.readFileSync(filename, 'utf8');

test('the outer exit guard reaches the broker instantiated inside startApplication', () => {
  const ast = espree.parse(source, { ecmaVersion: 2024, sourceType: 'commonjs', range: true });
  const variable = (nodes, name) => nodes.find(node => node.type === 'VariableDeclaration' && node.declarations.some(d => d.id.name === name));
  const startup = ast.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'startApplication').body.body;
  const revocations = [];
  const context = vm.createContext({ ipcMain: {}, createUnsavedGuard: options => options,
    require: () => ({ createTriggerRendererBridge: () => ({ revoke: (...args) => revocations.push(args) }) }) });
  for (const node of [variable(ast.body, 'revokeTriggerActions'), variable(ast.body, 'unsavedGuard'), variable(startup, 'triggerRendererBridge'),
    startup.find(node => node.type === 'ExpressionStatement' && node.expression.left?.name === 'revokeTriggerActions')]) {
    assert.ok(node, 'the shipped bootstrap must retain the exit-to-broker wiring');
    vm.runInContext(source.slice(...node.range), context, { filename });
  }
  const guard = vm.runInContext('unsavedGuard', context); const win = {};
  guard.onCommitted(win);
  assert.deepEqual(revocations, [[win, 'Switchboard is closing.']]);
});

test('trigger project snapshot retains hidden provenance and rejects changes while querying', async () => {
  let global = { hiddenProjects: ['/hidden'], hiddenProjectKinds: { '/hidden': 'delete' } };
  let mutate = false;
  const context = vm.createContext({ structuredClone, getSetting: () => global,
    getProjectsSnapshot: async mode => {
      assert.equal(mode, 'both');
      if (mutate) global = { hiddenProjects: ['/newly-hidden'], hiddenProjectKinds: {} };
      return { allProjects: [{ projectPath: '/project' }] };
    } });
  vm.runInContext(extractFunction(source, 'getTriggerProjectSnapshot'), context, { filename });
  const query = context.getTriggerProjectSnapshot;
  const snapshot = await query(); assert.deepEqual(snapshot.hiddenProjects, ['/hidden']);
  assert.equal(snapshot.hiddenProjectKinds['/hidden'], 'delete');
  mutate = true; await assert.rejects(query(), /project lookup unavailable/);
});

test('trigger validation receives the frozen host scope of a hidden mark', async () => {
  const { resolveProject } = require('../src/main/triggers/trigger-actions');
  const project = path.resolve(__dirname, '..');
  const global = { hiddenProjects: [project], hiddenProjectKinds: { [project]: 'delete' },
    hiddenProjectScopes: { [project]: { alias: 'box' } } };
  const context = vm.createContext({ structuredClone, getSetting: () => global,
    getProjectsSnapshot: async () => ({ allProjects: [{ projectPath: project }] }) });
  vm.runInContext(extractFunction(source, 'getTriggerProjectSnapshot'), context, { filename });
  const snapshot = await context.getTriggerProjectSnapshot();
  global.hiddenProjectScopes[project].alias = null;
  const admitted = await resolveProject(project, { getProjectSnapshot: async () => snapshot });
  assert.equal(admitted.ok, true, 'a remote-scoped hidden mark must admit the same-path local project');
  const refused = await resolveProject(project, { getProjectSnapshot: context.getTriggerProjectSnapshot });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'project is archived');
});

test('trigger project snapshot refuses a scope-only change while querying', async () => {
  const global = { hiddenProjects: ['/hidden'], hiddenProjectKinds: { '/hidden': 'delete' },
    hiddenProjectScopes: { '/hidden': { alias: 'box' } } };
  const context = vm.createContext({ structuredClone, getSetting: () => global,
    getProjectsSnapshot: async () => {
      global.hiddenProjectScopes['/hidden'].alias = null;
      return { allProjects: [] };
    } });
  vm.runInContext(extractFunction(source, 'getTriggerProjectSnapshot'), context, { filename });
  await assert.rejects(context.getTriggerProjectSnapshot(), /project lookup unavailable/,
    'scope-only changes must invalidate trigger project admission');
});
