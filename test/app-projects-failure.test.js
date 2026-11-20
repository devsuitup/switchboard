'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

function setup() {
  const h = setupSidebarDom();
  const w = h.window;
  w.loadingStatus = w.document.createElement('div');
  w.cachedProjects = [{ projectPath: '/previous', sessions: [] }];
  w.cachedAllProjects = w.cachedProjects;
  for (const name of ['reportActivityFocus', 'reportActivityTitles', 'refreshSidebar', 'renderDefaultStatus']) w[name] = () => {};
  w.pollActiveSessions = async () => {};
  w.api = { getProjects: async () => { throw new Error('worker failed'); }, getSetting: async () => ({}), getActiveTerminals: async () => [] };
  w.api.onTriggerSessionAction = () => {};
  w.api.onProjectDeleteRecovery = () => {};
  w.handleTriggerSessionAction = () => {};
  w.console = { ...console, warn: () => {} };
  loadAppFunctions(h.context, { functions: ['dedup', 'loadProjects'], declarations: ['startupProjectsHandedOver'] });
  return h;
}

test('startup retries a failed project load and restores even when both attempts fail', async () => {
  for (const recover of [true, false]) {
    const h = setup();
    let calls = 0;
    let restores = 0;
    h.window.api.getProjects = async () => {
      if (++calls === 1 || !recover) throw new Error('worker failed');
      return { defaultProjects: [], allProjects: [] };
    };
    h.window.restoreStartupSessions = async () => { restores++; };
    h.window.setTimeout = () => 1;
    const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
    if (source.includes('async function loadStartupProjects(')) loadAppFunctions(h.context, { functions: ['loadStartupProjects'] });
    const start = source.indexOf('\n}', source.indexOf('async function restoreStartupSessions(')) + 2;
    const end = source.indexOf('// Live-reload sidebar', start);
    try {
      let startup;
      assert.doesNotThrow(() => { startup = vm.runInContext(source.slice(start, end), h.context, { filename: path.join(__dirname, '../public/app.js') }); });
      await Promise.resolve(startup).catch(() => {});
      assert.equal(calls, 2, 'startup must retry its first failed load');
      assert.equal(restores, 1, 'saved working-set restore must run after failed loads');
    } finally { h.destroy(); }
  }
});

test('startup recovers cached rows after two failures without a filesystem event', async () => {
  const h = setup();
  const timers = [];
  let calls = 0, restores = 0, refreshed;
  const painted = new Promise(resolve => { refreshed = resolve; });
  h.window.cachedProjects = [];
  h.window.cachedAllProjects = [];
  h.window.setTimeout = callback => { timers.push(callback); return timers.length; };
  h.window.api.getProjects = async () => {
    if (++calls <= 2) throw new Error('temporary IPC failure');
    return { defaultProjects: [{ projectPath: '/cached', sessions: [] }], allProjects: [] };
  };
  h.window.restoreStartupSessions = async () => { restores++; };
  h.window.refreshSidebar = () => refreshed();
  loadAppFunctions(h.context, { functions: ['loadStartupProjects', 'reloadProjects'] });
  try {
    await h.window.loadStartupProjects();
    assert.equal(restores, 1, 'restore must not wait for the delayed retry');
    assert.equal(timers.length, 1, 'startup must schedule recovery after both immediate attempts fail');
    timers.shift()();
    await painted;
    assert.equal(calls, 3);
    assert.equal(h.window.cachedProjects[0].projectPath, '/cached');
    assert.equal(timers.length, 0, 'a successful retry must stop the retry chain');
  } finally { h.destroy(); }
});

test('startup recovery stops after its bounded retry budget', async () => {
  const h = setup();
  const timers = [];
  let calls = 0;
  h.window.setTimeout = callback => { timers.push(callback); return timers.length; };
  h.window.api.getProjects = async () => { calls++; throw new Error('persistent IPC failure'); };
  h.window.restoreStartupSessions = async () => {};
  loadAppFunctions(h.context, { functions: ['loadStartupProjects', 'reloadProjects'] });
  try {
    await h.window.loadStartupProjects();
    for (let i = 0; i < 3; i++) {
      assert.equal(timers.length, 1);
      await timers.shift()();
    }
    assert.equal(calls, 5);
    assert.equal(timers.length, 0);
  } finally { h.destroy(); }
});

test('a failed event reload keeps both previous lists and settles without rejection', async () => {
  const h = setup();
  try {
    const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
    if (source.includes('async function reloadProjects(')) loadAppFunctions(h.context, { functions: ['reloadProjects'] });
    const reload = h.window.reloadProjects || h.window.loadProjects;
    let rejected = false;
    await reload().catch(() => { rejected = true; });
    assert.equal(rejected, false, 'event callers must handle worker rejection');
    assert.equal(h.window.cachedProjects[0].projectPath, '/previous');
    assert.equal(h.window.cachedAllProjects[0].projectPath, '/previous');
  } finally { h.destroy(); }
});

test('a later successful reload announces trigger readiness after every startup attempt failed', async () => {
  const h = setup();
  const timers = [];
  let calls = 0, ready = 0;
  h.window.setTimeout = callback => { timers.push(callback); return timers.length; };
  h.window.restoreStartupSessions = async () => {};
  h.window.api.triggerActionsReady = async () => { ready++; };
  h.window.api.getProjects = async () => { calls++; throw new Error('Projects changed while loading; reload to retry.'); };
  loadAppFunctions(h.context, { functions: ['loadStartupProjects', 'reloadProjects'] });
  try {
    await h.window.loadStartupProjects();
    for (let i = 0; i < 3; i++) await timers.shift()();
    assert.equal(calls, 5);
    assert.equal(timers.length, 0);
    assert.equal(ready, 0, 'failed loads cannot announce readiness');
    h.window.api.getProjects = async () => ({ defaultProjects: [], allProjects: [] });
    assert.equal(await h.window.reloadProjects(), true);
    assert.equal(ready, 1, 'a successful reload after exhausted startup retries must announce readiness');
    assert.equal(await h.window.reloadProjects(), true);
    assert.equal(ready, 2, 'later successful reloads may repeat the idempotent handshake');
  } finally { h.destroy(); }
});

test('a successful delayed startup retry restores before announcing trigger readiness', async () => {
  const h = setup();
  const timers = [], order = [];
  let calls = 0;
  h.window.setTimeout = callback => { timers.push(callback); return timers.length; };
  h.window.api.getProjects = async () => {
    if (++calls <= 2) throw new Error('temporary IPC failure');
    return { defaultProjects: [], allProjects: [] };
  };
  h.window.restoreStartupSessions = async ({ projectsLoaded = true } = {}) => {
    if (!projectsLoaded) return;
    order.push('restore started');
    await Promise.resolve();
    order.push('restore resolved');
  };
  h.window.api.triggerActionsReady = async () => { order.push('ready'); };
  loadAppFunctions(h.context, { functions: ['loadStartupProjects', 'reloadProjects'] });
  try {
    await h.window.loadStartupProjects();
    await timers.shift()();
    assert.deepEqual(order, ['restore started', 'restore resolved', 'ready'], 'delayed startup must restore before its only readiness announcement');
  } finally { h.destroy(); }
});

test('an accepted reload cannot announce while startup restoration is pending', async () => {
  for (const delayed of [false, true]) {
    const h = setup();
    const timers = [];
    let calls = 0, ready = 0, releaseRestore, enteredRestore;
    const restoring = new Promise(resolve => { enteredRestore = resolve; });
    const restored = new Promise(resolve => { releaseRestore = resolve; });
    h.window.setTimeout = callback => { timers.push(callback); return timers.length; };
    h.window.api.getProjects = async () => {
      if (++calls <= 2 && delayed) throw new Error('temporary IPC failure');
      return { defaultProjects: [], allProjects: [] };
    };
    h.window.restoreStartupSessions = async ({ projectsLoaded = true } = {}) => {
      if (!projectsLoaded) return;
      enteredRestore();
      await restored;
    };
    h.window.api.triggerActionsReady = async () => { ready++; };
    loadAppFunctions(h.context, { functions: ['loadStartupProjects', 'reloadProjects'] });
    let startup;
    try {
      startup = h.window.loadStartupProjects();
      if (delayed) { await startup; startup = timers.shift()(); }
      await restoring;
      assert.equal(await h.window.reloadProjects(), true);
      assert.equal(ready, 0, 'an accepted reload must not announce before startup restore resolves');
      releaseRestore();
      await startup;
      assert.equal(ready, 1, 'startup owns the first handshake after restore');
      assert.equal(await h.window.reloadProjects(), true);
      assert.equal(ready, 2, 'startup hands over subsequent accepted reloads');
    } finally { releaseRestore(); await startup; h.destroy(); }
  }
});

test('a rejected readiness announcement leaves an accepted reload successful', async () => {
  const h = setup();
  let restoreRetries = 0;
  h.window.api.getProjects = async () => ({ defaultProjects: [], allProjects: [] });
  h.window.restoreStartupSessions = async () => {};
  h.window.api.triggerActionsReady = async () => {};
  h.window.maybeRetryRestoreWorkingSet = async () => { restoreRetries++; };
  loadAppFunctions(h.context, { functions: ['loadStartupProjects', 'reloadProjects'] });
  try {
    await h.window.loadStartupProjects();
    h.window.api.triggerActionsReady = async () => { throw new Error('No handler registered'); };
    assert.equal(await h.window.reloadProjects({ restoreRetry: true }), true, 'readiness rejection must not fail an accepted project reload');
    assert.equal(restoreRetries, 1, 'readiness rejection must not skip working-set recovery');
  } finally { h.destroy(); }
});

test('renderer project actions do not leave floating loadProjects rejections', () => {
  const floating = [];
  for (const name of ['app.js', 'sidebar.js', 'dialogs.js', 'settings-panel.js']) {
    const source = fs.readFileSync(path.join(__dirname, '../public', name), 'utf8');
    source.split('\n').forEach((line, index) => {
      if (/^\s*loadProjects\([^;]*\);\s*$/.test(line)) floating.push(`${name}:${index + 1}`);
    });
  }
  assert.deepEqual(floating, [], 'floating renderer reloads must catch worker rejection');
});

test('scheduled persistence cannot overwrite the saved working set before startup reads it', async () => {
  const h = setup();
  const saved = [{ sessionId: 'saved', projectPath: '/saved', active: true }];
  const settings = { openWorkingSet: saved };
  const timers = [];
  h.window.setTimeout = callback => { timers.push(callback); return 1; };
  h.window.api.getSetting = async () => structuredClone(settings);
  h.window.api.setSetting = async (_key, value) => Object.assign(settings, structuredClone(value));
  h.window._persistChain = Promise.resolve();
  h.window.pendingRestoreEntries = () => [];
  loadAppFunctions(h.context, {
    functions: ['persistWorkingSet', 'schedulePersistWorkingSet'],
    declarations: ['savedWorkingSetRead', 'persistWorkingSetTimer', 'restoringWorkingSet', 'exitingApp', 'persistSkippedWhileExiting', 'skippedWorkingSetEntries', 'dormantWorkingSet'],
  });
  try {
    h.window.schedulePersistWorkingSet();
    timers.splice(0).forEach(callback => callback());
    await h.window._persistChain;
    assert.deepEqual(settings.openWorkingSet, saved);
    vm.runInContext('savedWorkingSetRead = true;', h.context);
    h.window.schedulePersistWorkingSet();
    timers.splice(0).forEach(callback => callback());
    await h.window._persistChain;
    assert.deepEqual(settings.openWorkingSet, []);
  } finally { h.destroy(); }
});
