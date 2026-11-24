'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

test('preload exposes the project deletion schedule notification without the Electron event', () => {
  const source = fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8');
  assert.match(source, /onProjectDeleteSchedulesChanged:\s*callback => ipcRenderer\.on\('project-delete-schedules-changed', \(_event, payload\) => callback\(payload\)\)/,
    'preload must bridge the schedule invalidation to the renderer');
});

function setup(t, activeTab) {
  const dom = new JSDOM('<body><div id="app-notices"></div><div id="memory-content"></div><div id="schedules-content"></div></body>', {
    url: 'http://localhost/', runScripts: 'outside-only',
  });
  const w = dom.window;
  const context = dom.getInternalVMContext();
  let listener;
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
    onProjectDeleteSchedulesChanged: callback => { listener = callback; },
    listSchedules: async () => { scheduleReads++; return data; },
    getMemories: async () => { memoryReads++; return memory; },
  };
  for (const name of ['utils.js', 'icons.js', 'setting-defaults.js', 'app-notices.js', 'memory-workfiles-view.js', 'schedules-view.js']) {
    const filename = path.join(__dirname, '../public', name);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  }
  t.after(() => { w.setSchedulesVisible(false); w.close(); });
  return { w, data, memory, get scheduleReads() { return scheduleReads; }, get memoryReads() { return memoryReads; },
    notify() { listener?.({ invalidation: {}, operationId: 'deleted', expectedProjectEpoch: 1, committedRevision: 2 }); },
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
