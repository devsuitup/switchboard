// A working-set restore that meets a session live in another process.
//
// app.js cannot be evaluated whole in jsdom, so the shipped persistWorkingSet,
// runRestore, openSession and showLiveElsewhereNotice are cut out of its source
// by brace matching and run in a jsdom window next to the real resume-guard.js
// and utils.js; only their collaborators outside the restore path are stubbed.
// See .ai/contexts/cli-session-state.md ("Live elsewhere").

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

const LIVE = { pid: 4242, cwd: '/elsewhere', startedAt: 1 };

function setup({ savedSet, liveIds, batchFails = false }) {
  const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' });
  const ctx = dom.getInternalVMContext();
  const settings = { global: { restoreOnStartup: 'auto', openWorkingSet: savedSet } };
  const openTerminalCalls = [];
  const liveQueries = { single: [], batch: [] };

  dom.window.api = {
    getSetting: async (key) => JSON.parse(JSON.stringify(settings[key] || null)),
    setSetting: async (key, value) => { settings[key] = JSON.parse(JSON.stringify(value)); },
    getSessionLiveElsewhere: async (id) => { liveQueries.single.push(id); return liveIds.includes(id) ? LIVE : null; },
    getSessionsLiveElsewhere: async (ids) => {
      liveQueries.batch.push([...ids]);
      if (batchFails) throw new Error('ipc down');
      return Object.fromEntries(ids.filter((id) => liveIds.includes(id)).map((id) => [id, LIVE]));
    },
    openTerminal: async (sessionId) => { openTerminalCalls.push(sessionId); return { ok: true }; },
  };
  dom.window.confirm = () => { throw new Error('an automatic resume must never prompt'); };

  vm.runInContext(read('utils.js'), ctx);
  vm.runInContext(read('resume-guard.js'), ctx);
  vm.runInContext(`
    var openSessions = new Map();
    var sessionMap = new Map();
    var activeSessionId = null;
    var restoringWorkingSet = false;
    var restorePlanner = null;
    var sessionOpenedOutsideRestore = false;
    var _persistChain = Promise.resolve();
    var RESTORE_STAGGER_MS = 0;
    var LIVE_ELSEWHERE_NOTICE_MS = 60000;
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
  `, ctx);
  vm.runInContext(topLevelDeclarations(APP_SRC, ['LIVE_ELSEWHERE_NOTICE_MS', 'skippedWorkingSetEntries', 'restoreSavedIndex', 'restoreAwaitingConsent', 'restoreInFlight'])
    .replace(/^const /gm, 'var ').replace(/^let /gm, 'var '), ctx);
  for (const name of ['persistWorkingSet', 'pendingRestoreEntries', 'runRestore', 'openSession']) {
    vm.runInContext(functionSource(APP_SRC, name), ctx);
  }
  if (APP_SRC.includes('function showLiveElsewhereNotice(')) {
    vm.runInContext(functionSource(APP_SRC, 'showRestoreNotice'), ctx);
    vm.runInContext(functionSource(APP_SRC, 'showLiveElsewhereNotice'), ctx);
  }
  if (/^let restoreSavedIndex /m.test(APP_SRC)) {
    ctx.restoreSavedIndexFrom = savedSet;
    vm.runInContext('restoreSavedIndex = new Map(restoreSavedIndexFrom.map((item, index) => [item.sessionId, index]));', ctx);
  }
  for (const item of savedSet) {
    vm.runInContext(`sessionMap.set(${JSON.stringify(item.sessionId)}, ${JSON.stringify({ sessionId: item.sessionId, projectPath: item.projectPath, name: `name-${item.sessionId}` })});`, ctx);
  }

  const restore = async () => {
    vm.runInContext('restoringWorkingSet = true;', ctx);
    await vm.runInContext(`runRestore(${JSON.stringify(savedSet)})`, ctx);
    vm.runInContext('restoringWorkingSet = false;', ctx);
  };
  const persist = () => vm.runInContext('persistWorkingSet()', ctx);
  return { dom, ctx, settings, openTerminalCalls, liveQueries, restore, persist };
}

const SAVED = [
  { sessionId: 'a', projectPath: '/pa', active: false },
  { sessionId: 'x', projectPath: '/px', active: false },
  { sessionId: 'b', projectPath: '/pb', active: true },
];

test('a session live elsewhere is not resumed, and survives in the persisted working set at its place', async () => {
  const h = setup({ savedSet: SAVED, liveIds: ['x'] });
  await h.restore();
  assert.deepEqual(h.openTerminalCalls, ['a', 'b'], 'no open-terminal for the live session');

  await h.persist();
  assert.deepEqual(h.settings.global.openWorkingSet.map((i) => i.sessionId), ['a', 'x', 'b']);
  const x = h.settings.global.openWorkingSet.find((i) => i.sessionId === 'x');
  assert.equal(x.projectPath, '/px');
  assert.equal(x.active, false);

  await h.persist();
  assert.deepEqual(h.settings.global.openWorkingSet.map((i) => i.sessionId), ['a', 'x', 'b'],
    'a later incremental persist keeps it too');
  h.dom.window.close();
});

test('the skipped session is named in a one-line notice with its pid', async () => {
  const h = setup({ savedSet: SAVED, liveIds: ['x'] });
  await h.restore();
  const toast = h.dom.window.document.getElementById('restore-live-elsewhere-toast');
  assert.ok(toast, 'a notice is shown');
  assert.equal(toast.querySelector('.restore-toast-msg').textContent, 'Not reopened: name-x is live in pid 4242');
  toast.querySelector('.restore-toast-dismiss').click();
  assert.equal(h.dom.window.document.getElementById('restore-live-elsewhere-toast'), null);
  h.dom.window.close();
});

test('the whole batch is checked with one directory scan, not one per session', async () => {
  const h = setup({ savedSet: SAVED, liveIds: ['x'] });
  await h.restore();
  assert.deepEqual(h.liveQueries.batch, [['a', 'x', 'b']]);
  assert.deepEqual(h.liveQueries.single, []);
  h.dom.window.close();
});

test('a failed batch check fails open: every session is resumed, nothing is skipped', async () => {
  const h = setup({ savedSet: SAVED, liveIds: ['x'], batchFails: true });
  await h.restore();
  assert.deepEqual(h.openTerminalCalls, ['a', 'x', 'b']);
  assert.equal(h.dom.window.document.getElementById('restore-live-elsewhere-toast'), null);
  h.dom.window.close();
});

test('once the user opens the skipped session and closes it, it leaves the working set like any other', async () => {
  const h = setup({ savedSet: SAVED, liveIds: ['x'] });
  await h.restore();
  h.dom.window.confirm = () => true;
  await vm.runInContext('openSession(sessionMap.get("x"))', h.ctx);
  assert.deepEqual(h.openTerminalCalls, ['a', 'b', 'x']);
  vm.runInContext('openSessions.get("x").closed = true;', h.ctx);
  await h.persist();
  assert.deepEqual(h.settings.global.openWorkingSet.map((i) => i.sessionId), ['a', 'b']);
  h.dom.window.close();
});
