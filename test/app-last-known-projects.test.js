'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLastKnownProjectsStore } = require('../src/main/projects/last-known-projects');
const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions, readAppSource } = require('./app-source');

const flush = async (count = 4) => { for (let i = 0; i < count; i++) await new Promise(resolve => setImmediate(resolve)); };
const lastKnown = {
  defaultProjects: [{ projectPath: '/last-known', sessions: [{ sessionId: 'old', summary: 'yesterday' }] }],
  allProjects: [{ projectPath: '/last-known', sessions: [{ sessionId: 'old', summary: 'yesterday' }] }],
  savedAt: 1,
};
const fresh = { defaultProjects: [{ projectPath: '/fresh', sessions: [] }], allProjects: [{ projectPath: '/fresh', sessions: [] }] };

test('compact disk snapshots retain the rendered sidebar for local, archived, scheduled, remote and subagent rows', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-snapshot-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const row = { sessionId: 'root-123', summary: 'original prompt', firstPrompt: 'original prompt',
    name: 'Named conversation', aiTitle: 'Generated title', modified: '2026-11-22T10:20:30.000Z', messageCount: 42,
    starred: 1, runtime: 'claude', projectPath: '/fixture', cwd: '/fixture', sourceFolder: '-fixture', canLaunch: true };
  const allProjects = [
    { projectPath: '/fixture', folder: '-fixture', reenableOffer: { names: ['nightly'],
      failed: [{ name: 'nightly', error: 'schedule unavailable' }] }, sessions: [row,
      { ...row, sessionId: 'scheduled-123', name: 'Scheduled audit', scheduleSlug: 'nightly' },
      { ...row, sessionId: 'child-123', parentSessionId: row.sessionId, agentId: 'agent-one', subagentType: 'explorer', description: 'Read source' },
      { ...row, sessionId: 'child-456', parentSessionId: row.sessionId, agentId: 'agent-two', subagentType: 'explorer' },
      { ...row, sessionId: 'archived-123', archived: 1, name: 'Archived chat', runtime: 'codex', runtimeLabel: 'Codex' },
    ] },
    { projectPath: '/remote', remoteAlias: 'host', missing: true, sessions: [
      { ...row, sessionId: 'remote-123', name: 'Remote chat', projectPath: '/remote', remoteAlias: 'host', remoteAttachable: false },
    ] },
  ];
  const defaultProjects = [{ ...allProjects[0], sessions: allProjects[0].sessions.filter(s => !s.archived) }];
  const store = createLastKnownProjectsStore({ dir, appVersion: 'test' });
  store.remember({ defaultProjects, allProjects });
  await store.flush();
  const loaded = await store.load();
  function paint(projects, archived) {
    const h = setupSidebarDom();
    try {
      h.window.showArchived = archived;
      h.window.cachedAllProjects = projects;
      h.window.cachedProjects = projects;
      loadAppFunctions(h.context, { functions: ['dedup'] });
      h.window.dedup(projects);
      h.window.renderProjects(projects, true);
      return h.window.sidebarContent.innerHTML;
    } finally { h.destroy(); }
  }
  const expected = paint(structuredClone(defaultProjects), false);
  assert.match(expected, /schedule-reenable-notice/);
  assert.match(expected, /Could not turn back on: nightly: schedule unavailable/);
  assert.equal(paint(loaded.defaultProjects, false), expected);
  assert.equal(paint(loaded.allProjects, true), paint(structuredClone(allProjects), true));
});

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
    assert.equal(s.w.loadingStatus.textContent, '', 'the provisional rows show no status text while the load runs');
    assert.equal(s.w.loadingStatus.style.display, 'none');
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

test('a late disk snapshot preserves the failure after every startup retry has failed', async t => {
  const s = setup({ projects: new Error('worker failed') });
  t.after(() => s.h.destroy());
  s.releaseLoad();
  await s.w.loadStartupProjects();
  assert.equal(s.calls.loads, 2);
  for (let retry = 0; retry < 3; retry++) {
    assert.equal(s.timers.length, 1);
    await s.timers.shift()();
  }
  assert.equal(s.calls.loads, 5);
  assert.equal(s.timers.length, 0, 'startup exhausted its retry budget');
  assert.equal(s.w.loadingStatus.textContent, 'Could not load projects. Reload to retry.');
  s.releaseLast();
  await flush();
  assert.equal(s.w.cachedProjects[0].projectPath, '/last-known');
  assert.equal(s.w.cachedAllProjects[0].projectPath, '/last-known');
  assert.equal(s.w.sidebarContent.classList.contains('projects-provisional'), true);
  s.item.click();
  assert.equal(s.calls.opened, 0, 'late provisional rows stay inert');
  assert.equal(s.w.loadingStatus.style.display, '');
  assert.equal(s.w.loadingStatus.className, 'active');
  assert.equal(s.w.loadingStatus.textContent, 'Could not load projects. Reload to retry.',
    'late provisional paint must preserve the failure; no load or retry remains in flight');
});
