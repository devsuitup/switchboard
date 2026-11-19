'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions, readAppSource } = require('./app-source');

const flush = async (count = 4) => { for (let i = 0; i < count; i++) await new Promise(resolve => setImmediate(resolve)); };
const lastKnown = {
  defaultProjects: [{ projectPath: '/last-known', sessions: [{ sessionId: 'old', summary: 'yesterday' }] }],
  allProjects: [{ projectPath: '/last-known', sessions: [{ sessionId: 'old', summary: 'yesterday' }] }],
  savedAt: 1,
};
const fresh = { defaultProjects: [{ projectPath: '/fresh', sessions: [] }], allProjects: [{ projectPath: '/fresh', sessions: [] }] };

function setup({ last = lastKnown, projects = fresh } = {}) {
  const h = setupSidebarDom();
  const w = h.window;
  w.loadingStatus = w.document.createElement('div');
  w.cachedProjects = [];
  w.cachedAllProjects = [];
  const calls = { refreshes: 0, loads: 0 };
  w.refreshSidebar = () => { calls.refreshes++; };
  for (const name of ['reportActivityFocus', 'reportActivityTitles', 'renderDefaultStatus']) w[name] = () => {};
  w.pollActiveSessions = async () => {};
  w.restoreStartupSessions = async () => {};
  w.handleTriggerSessionAction = () => {};
  w.reconcileProjectDeletions = () => {};
  const timers = [];
  w.setTimeout = callback => { timers.push(callback); return timers.length; };
  let releaseLoad, releaseLast;
  const loadGate = new Promise(resolve => { releaseLoad = resolve; });
  const lastGate = new Promise(resolve => { releaseLast = resolve; });
  w.api.getLastKnownProjects = async () => { await lastGate; return last; };
  w.api.getProjects = async () => { calls.loads++; await loadGate; if (projects instanceof Error) throw projects; return projects; };
  w.api.getSetting = async () => ({});
  w.api.getActiveTerminals = async () => [];
  w.api.triggerActionsReady = async () => {};
  w.console = { ...console, warn: () => {} };
  const functions = ['dedup', 'loadProjects', 'reloadProjects', 'loadStartupProjects'];
  if (readAppSource().includes('async function paintLastKnownProjects(')) functions.push('paintLastKnownProjects');
  loadAppFunctions(h.context, { functions, declarations: ['startupProjectsHandedOver'] });
  const item = w.document.createElement('div');
  item.className = 'session-item';
  calls.opened = 0;
  item.onclick = () => { calls.opened++; };
  w.sidebarContent.append(item);
  return { h, w, calls, timers, item, releaseLoad, releaseLast };
}

test('startup paints the last known projects as inert provisional rows and the first accepted load replaces them', async () => {
  const s = setup();
  try {
    const startup = s.w.loadStartupProjects();
    s.releaseLast();
    await flush();
    assert.equal(s.w.cachedProjects[0]?.projectPath, '/last-known', 'the sidebar shows the last known rows before the first load lands');
    assert.equal(s.w.cachedAllProjects[0]?.projectPath, '/last-known');
    assert.equal(s.w.sidebarContent.classList.contains('projects-provisional'), true);
    assert.equal(s.calls.refreshes, 1, 'one paint');
    assert.equal(s.w.loadingStatus.textContent, 'Refreshing…');
    s.item.click();
    assert.equal(s.calls.opened, 0, 'a provisional row is inert');
    s.releaseLoad();
    await startup;
    assert.equal(s.w.cachedProjects[0].projectPath, '/fresh');
    assert.equal(s.w.sidebarContent.classList.contains('projects-provisional'), false);
    assert.equal(s.calls.refreshes, 2);
    s.item.click();
    assert.equal(s.calls.opened, 1, 'rows act again once real data is in');
    assert.equal(s.calls.loads, 1);
  } finally { s.h.destroy(); }
});

test('a first load that lands before the last known rows are read wins and nothing provisional is painted', async () => {
  const s = setup();
  try {
    const startup = s.w.loadStartupProjects();
    s.releaseLoad();
    await startup;
    assert.equal(s.w.cachedProjects[0].projectPath, '/fresh');
    s.releaseLast();
    await flush();
    assert.equal(s.w.cachedProjects[0].projectPath, '/fresh');
    assert.equal(s.w.sidebarContent.classList.contains('projects-provisional'), false);
    assert.equal(s.calls.refreshes, 1);
  } finally { s.h.destroy(); }
});

test('when every startup load fails the provisional rows stay inert and the status says so', async () => {
  const s = setup({ projects: new Error('worker failed') });
  try {
    s.releaseLast();
    s.releaseLoad();
    await s.w.loadStartupProjects();
    assert.equal(s.w.cachedProjects[0].projectPath, '/last-known');
    assert.equal(s.w.sidebarContent.classList.contains('projects-provisional'), true);
    assert.equal(s.w.loadingStatus.textContent, 'Could not load projects. Reload to retry.');
    s.item.click();
    assert.equal(s.calls.opened, 0);
    assert.equal(s.timers.length, 1, 'the startup retry chain still runs');
  } finally { s.h.destroy(); }
});

test('nothing is painted when main has no last known projects or the payload is malformed', async () => {
  for (const last of [null, { defaultProjects: 'rows', allProjects: [] }, {}]) {
    const s = setup({ last });
    try {
      const startup = s.w.loadStartupProjects();
      s.releaseLast();
      await flush();
      assert.deepEqual(s.w.cachedProjects, []);
      assert.equal(s.w.sidebarContent.classList.contains('projects-provisional'), false);
      assert.equal(s.calls.refreshes, 0);
      s.releaseLoad();
      await startup;
      assert.equal(s.w.cachedProjects[0].projectPath, '/fresh');
    } finally { s.h.destroy(); }
  }
});
