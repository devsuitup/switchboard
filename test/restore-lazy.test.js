// 'Restore on click' (restoreOnStartup: 'lazy'): the saved working set is marked
// dormant instead of resumed, and a dormant session spawns only when opened.
//
// The shipped persistWorkingSet, tickRestorePlanner and openSession are cut out
// of app.js by brace matching and run in a jsdom window with the real
// restore planner; collaborators outside the restore path are stubbed.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8').replace(/\r\n/g, '\n');
const APP_SRC = read('app.js');

function functionSource(src, name) {
  const start = src.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.notEqual(start, -1, `${name} not found`);
  const body = src.indexOf(') {', start) + 2;
  let depth = 0;
  for (let i = body; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

function topLevelDeclarations(src, names) {
  return names
    .map((name) => (src.match(new RegExp(`^(?:const|let) ${name} = .*;$`, 'm')) || [])[0])
    .filter(Boolean)
    .join('\n');
}

const SAVED = [
  { sessionId: 'a', projectPath: '/pa', active: false },
  { sessionId: 'x', projectPath: '/px', active: true },
  { sessionId: 'b', projectPath: '/pb', active: false },
];

function setup({ savedSet = SAVED } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' });
  const ctx = dom.getInternalVMContext();
  const settings = { global: { restoreOnStartup: 'lazy', openWorkingSet: savedSet } };
  const openTerminalCalls = [];
  let sidebarRefreshes = 0;

  dom.window.api = {
    getSetting: async (key) => JSON.parse(JSON.stringify(settings[key] || null)),
    setSetting: async (key, value) => { settings[key] = JSON.parse(JSON.stringify(value)); },
    getSessionLiveElsewhere: async () => null,
    getSessionsLiveElsewhere: async () => ({}),
    openTerminal: async (sessionId) => { openTerminalCalls.push(sessionId); return { ok: true }; },
  };
  dom.window.refreshSidebar = () => { sidebarRefreshes++; };

  vm.runInContext(read('utils.js'), ctx);
  vm.runInContext(read('resume-guard.js'), ctx);
  vm.runInContext(read('restore-plan.js'), ctx);
  vm.runInContext(`
    var openSessions = new Map();
    var sessionMap = new Map();
    var activeSessionId = null;
    var restoringWorkingSet = false;
    var sessionOpenedOutsideRestore = false;
    var restoreIndexingDone = false;
    var restoreMode = 'lazy';
    var _persistChain = Promise.resolve();
    function createTerminalEntry(session) {
      const entry = { session, closed: false, terminal: { write() {} }, initialSize: {} };
      openSessions.set(session.sessionId, entry);
      return entry;
    }
    function showSession(id) { activeSessionId = id; }
    function destroySession(id) { openSessions.delete(id); }
    async function resolveDefaultSessionOptions() { return {}; }
    function syncPtySizeAfterOpen() {}
    function setSessionMcpState() {}
    function setSessionSandboxed() {}
    function forgetSessionExit() {}
    function beginPtyOpen() {}
    function settlePtyOpen() {}
    function schedulePersistWorkingSet() {}
    function pollActiveSessions() {}
    function showColdCacheNotice() {}
    function showNotRestoredNotice() {}
    async function runRestore() { throw new Error('lazy restore must not resume anything'); }
  `, ctx);
  vm.runInContext(topLevelDeclarations(APP_SRC, ['skippedWorkingSetEntries', 'restoreSavedIndex', 'dormantWorkingSet'])
    .replace(/^const /gm, 'var ').replace(/^let /gm, 'var '), ctx);
  for (const name of ['persistWorkingSet', 'tickRestorePlanner', 'openSession']) {
    vm.runInContext(functionSource(APP_SRC, name), ctx);
  }
  ctx.savedSet = savedSet;
  vm.runInContext(`
    restoreSavedIndex = new Map(savedSet.map((item, index) => [item.sessionId, index]));
    var restorePlanner = createRestorePlanner({ savedSet });
  `, ctx);

  const index = (ids) => {
    for (const id of ids) {
      const item = savedSet.find((i) => i.sessionId === id);
      vm.runInContext(`sessionMap.set(${JSON.stringify(id)}, ${JSON.stringify({ sessionId: id, projectPath: item.projectPath })});`, ctx);
    }
  };
  return {
    dom, ctx, settings, openTerminalCalls, index,
    sidebarRefreshes: () => sidebarRefreshes,
    tick: () => vm.runInContext('tickRestorePlanner()', ctx),
    persist: () => vm.runInContext('persistWorkingSet()', ctx),
    open: (id) => vm.runInContext(`openSession(sessionMap.get(${JSON.stringify(id)}))`, ctx),
    dormantIds: () => [...vm.runInContext('[...dormantWorkingSet.keys()]', ctx)],
    savedIds: () => settings.global.openWorkingSet.map((i) => i.sessionId),
  };
}

test('lazy: the saved sessions are marked dormant and none is resumed', async () => {
  const h = setup();
  h.index(['a', 'x', 'b']);
  await h.tick();
  assert.deepEqual(h.openTerminalCalls, []);
  assert.deepEqual(h.dormantIds().sort(), ['a', 'b', 'x']);
  assert.equal(h.sidebarRefreshes(), 1);
  h.dom.window.close();
});

test('lazy: dormant sessions stay in the persisted working set at their saved place', async () => {
  const h = setup();
  h.index(['a', 'x', 'b']);
  await h.tick();
  await h.persist();
  assert.deepEqual(h.savedIds(), ['a', 'x', 'b']);
  assert.ok(h.settings.global.openWorkingSet.every((i) => i.active === false));
  h.dom.window.close();
});

test('lazy: opening a dormant session resumes only that one and keeps the others', async () => {
  const h = setup();
  h.index(['a', 'x', 'b']);
  await h.tick();
  await h.open('x');
  assert.deepEqual(h.openTerminalCalls, ['x']);
  assert.deepEqual(h.dormantIds().sort(), ['a', 'b']);
  await h.persist();
  assert.deepEqual(h.savedIds(), ['a', 'x', 'b']);
  assert.equal(h.settings.global.openWorkingSet.find((i) => i.sessionId === 'x').active, true);
  h.dom.window.close();
});

test('lazy: a session opened during a cold index does not stop the rest from being marked', async () => {
  const h = setup();
  h.index(['a']);
  await h.tick();
  assert.deepEqual(h.dormantIds(), ['a']);
  await h.open('a');
  h.index(['x', 'b']);
  await h.tick();
  assert.deepEqual(h.dormantIds().sort(), ['b', 'x']);
  assert.deepEqual(h.openTerminalCalls, ['a']);
  h.dom.window.close();
});
