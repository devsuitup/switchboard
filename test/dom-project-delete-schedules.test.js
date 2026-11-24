'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { JSDOM } = require('jsdom');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

function bridgeDeletionChannel(api) {
  const ipcRenderer = new EventEmitter();
  const preload = path.join(__dirname, '../preload.js');
  vm.runInNewContext(fs.readFileSync(preload, 'utf8'), {
    process: { platform: process.platform, argv: [] },
    require: name => {
      assert.equal(name, 'electron');
      return { contextBridge: { exposeInMainWorld: (_name, exposed) => {
        api.onProjectDeleteSchedulesChanged = exposed.onProjectDeleteSchedulesChanged;
      } }, ipcRenderer, webUtils: {} };
    },
  }, { filename: preload });
  return payload => ipcRenderer.emit('project-delete-schedules-changed', { sender: 'main' }, payload);
}

test('preload exposes the project deletion schedule notification without the Electron event', () => {
  const api = {};
  const emit = bridgeDeletionChannel(api);
  const received = [];
  api.onProjectDeleteSchedulesChanged((...args) => received.push(args));
  const payload = { invalidation: {}, operationId: 'op', expectedProjectEpoch: 1, committedRevision: 2 };
  emit(payload);
  assert.deepEqual(received, [[payload]], 'the renderer callback receives only the payload');
});

function setup(t, activeTab) {
  const dom = new JSDOM('<body><div id="app-notices"></div><div id="memory-content"></div><div id="schedules-content"></div></body>', {
    url: 'http://localhost/', runScripts: 'outside-only',
  });
  const w = dom.window;
  const context = dom.getInternalVMContext();
  let scheduleReads = 0;
  let memoryReads = 0;
  const data = { now: Date.now(), catchUpActive: true, projects: [{ projectPath: '/p', shortName: 'p', known: true, archived: false,
    schedules: [{ file: 'schedule-nightly.md', filePath: '/p/schedule-nightly.md', name: 'Nightly', slug: 'nightly', cron: '* * * * *',
      cronText: 'every min', enabled: true, linked: false, problems: [], nextRunMs: Date.now() + 60000, catchUp: false, runs: [] }] }] };
  const memory = { global: { files: [{ filename: 'schedule-nightly.md', filePath: '/p/schedule-nightly.md',
    modified: '2026-01-01', displayPath: 'Global', schedule: { enabled: true, cron: '* * * * *' } }] }, projects: [] };
  const timers = new Map();
  let timerId = 0;
  w.setTimeout = (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; };
  w.clearTimeout = id => timers.delete(id);
  w.activeTab = activeTab;
  w.memoryContent = w.document.getElementById('memory-content');
  w.api = {
    listSchedules: async () => { scheduleReads++; return data; },
    getMemories: async () => { memoryReads++; return memory; },
  };
  const emit = bridgeDeletionChannel(w.api);
  for (const name of ['utils.js', 'icons.js', 'setting-defaults.js', 'app-notices.js', 'memory-workfiles-view.js', 'schedules-view.js']) {
    const filename = path.join(__dirname, '../public', name);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  }
  t.after(() => { w.setSchedulesVisible(false); w.close(); });
  return { w, data, memory, get scheduleReads() { return scheduleReads; }, get memoryReads() { return memoryReads; },
    notify() { emit({ invalidation: {}, operationId: 'deleted', expectedProjectEpoch: 1, committedRevision: 2 }); },
    flushReload() { for (const [id, timer] of timers) if (timer.ms === 900) { timers.delete(id); timer.fn(); } },
  };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('deletion refreshes the visible Schedules list and coalesces repeated notifications', async t => {
  const h = setup(t, 'schedules');
  h.w.setSchedulesVisible(true);
  await settle();
  assert.ok(h.w.document.querySelector('.schedule-item'));
  h.data.projects = [];
  h.notify();
  h.notify();
  assert.equal(h.scheduleReads, 1, 'refresh uses the existing debounce');
  h.flushReload();
  await settle();
  assert.equal(h.w.document.querySelector('.schedule-item'), null, 'deleted project schedules must leave the visible list');
  assert.equal(h.scheduleReads, 2);
  assert.equal(h.memoryReads, 0);
});

test('deletion refreshes the visible Agent Files schedule list', async t => {
  const h = setup(t, 'memory');
  h.w.schedulesTabEnabled = false;
  await h.w.loadMemories();
  assert.match(h.w.memoryContent.textContent, /schedule-nightly/);
  h.memory.global.files = [];
  h.notify();
  await settle();
  assert.doesNotMatch(h.w.memoryContent.textContent, /schedule-nightly/, 'deleted project schedules must leave Agent Files');
  assert.equal(h.memoryReads, 2);
  assert.equal(h.scheduleReads, 0);
});

test('deletion does not load hidden lists; opening Schedules reads the current inventory', async t => {
  const h = setup(t, 'sessions');
  h.data.projects = [];
  h.notify();
  h.flushReload();
  await settle();
  assert.equal(h.scheduleReads, 0);
  assert.equal(h.memoryReads, 0);
  h.w.setSchedulesVisible(true);
  await settle();
  assert.equal(h.scheduleReads, 1);
  assert.equal(h.w.document.querySelector('.schedule-item'), null);
});

function setupUnsettledDeletion(t) {
  const h = setupSidebarDom();
  t.after(() => h.destroy());
  const w = h.window, p = makeSampleProject();
  const defaults = path.join(__dirname, '../public/setting-defaults.js');
  vm.runInContext(fs.readFileSync(defaults, 'utf8'), h.context, { filename: defaults });
  const emit = bridgeDeletionChannel(w.api);
  let memoryReads = 0, applied = 0, scheduleQueues = 0;
  const memory = { global: { files: [{ filename: 'schedule-nightly.md', filePath: '/p/schedule-nightly.md',
    modified: '2026-01-01', displayPath: 'Global', schedule: { enabled: true, cron: '* * * * *' } }] }, projects: [] };
  w.api.getMemories = async () => { memoryReads++; return memory; };
  w.applyProjectDeletion = async () => { applied++; };
  w.loadProjects = async () => {};
  w.queueSchedulesReload = () => { scheduleQueues++; };
  w.schedulesTabEnabled = false;
  w.activeTab = 'memory';
  w.cachedAllProjects = w.cachedProjects = [p];
  w.renderProjects([p]);
  const filename = path.join(__dirname, '../public/memory-workfiles-view.js');
  vm.runInContext(fs.readFileSync(filename, 'utf8'), h.context, { filename });
  return { ...h, w, p, memory, emit, get memoryReads() { return memoryReads; }, get applied() { return applied; },
    get scheduleQueues() { return scheduleQueues; } };
}

for (const [label, result, options] of [
  ['an unresolved execute', { state: 'unknown', operationId: 'op', code: 'EXECUTION_PENDING' }, {}],
  ['a pending execute whose state read became unavailable', { state: 'unknown', operationId: 'op', code: 'STATE_READ_UNAVAILABLE' }, {}],
  ['a historical committed receipt', { ok: true, state: 'committed', operationId: 'op', invalidation: { sessionIds: [], restoreTargets: [] } }, { historical: true }],
]) test(`a deletion committed after ${label} refreshes the open Agent Files list`, async t => {
  const h = setupUnsettledDeletion(t);
  await h.w.loadMemories();
  assert.match(h.w.memoryContent.textContent, /schedule-nightly/);
  await h.w.settleProjectDeletion(h.p, result, options);
  assert.equal(h.applied, 0, 'this settle does not apply the deletion, so it cannot refresh Agent Files');
  assert.equal(h.memoryReads, 1);
  h.memory.global.files = [];
  h.emit({ invalidation: {}, operationId: 'op', expectedProjectEpoch: 1, committedRevision: 2 });
  await settle();
  assert.equal(h.memoryReads, 2, 'the late commit notification must reload Agent Files');
  assert.doesNotMatch(h.w.memoryContent.textContent, /schedule-nightly/, 'deleted project schedules must leave Agent Files');
  assert.equal(h.scheduleQueues, 1);
});
