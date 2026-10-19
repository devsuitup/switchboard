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
const { loadAppFunctions } = require('./app-source');

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
  const notices = dom.window.document.createElement('div');
  notices.id = 'app-notices';
  dom.window.document.body.append(notices);
  vm.runInContext(read('app-notices.js'), ctx);
  const settings = { global: { restoreOnStartup: 'auto', openWorkingSet: savedSet } };
  const openTerminalCalls = [];
  const liveQueries = { single: [], batch: [] };

  dom.window.api = {
    getSessionContinuations: async () => ({ candidates: [], unresolved: false, continued: false }),
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
  dom.window.appConfirm = async () => { throw new Error('an automatic resume must never prompt'); };
  dom.window.appAlert = async () => { throw new Error('an automatic resume must never alert'); };

  vm.runInContext(read('utils.js'), ctx);
  vm.runInContext(read('resume-guard.js'), ctx, { filename: path.join(__dirname, '..', 'public', 'resume-guard.js') });
  vm.runInContext(`
    var openSessions = new Map();
    var pendingSessions = new Map();
    var sessionMap = new Map();
    var localMergedMemberRows = new Map();
    var activeSessionId = null;
    var restoringWorkingSet = false;
    var restorePlanner = null;
    var sessionOpenedOutsideRestore = false;
    var _persistChain = Promise.resolve();
    var exitingApp = false;
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
  loadAppFunctions(ctx, {
    functions: ['rowSessionIds', 'rowHeadId', 'rowOpenId'], sourcePath: path.join(__dirname, '../public/session-activity-dom.js'),
  });
  vm.runInContext(topLevelDeclarations(APP_SRC, ['restoreMode', 'LIVE_ELSEWHERE_NOTICE_MS', 'skippedWorkingSetEntries', 'restoreSavedIndex', 'restoreAwaitingConsent', 'restoreInFlight', 'restoreIndexingDone', 'continuationRetryCancelled', 'openingSessions', 'dormantWorkingSet'])
    .replace(/^const /gm, 'var ').replace(/^let /gm, 'var '), ctx);
  for (const name of ['persistWorkingSet', 'pendingRestoreEntries', 'runRestore', 'openSession', 'openSessionNow', 'clearDormantRow', 'indexedRowOf']) {
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
  const toast = h.dom.window.document.querySelector('[data-notice-id="Restore:batch"]');
  assert.ok(toast, 'a notice is shown');
  assert.match(toast.querySelector('.app-notice-message').textContent, /name-x.*\/elsewhere.*live outside this window in pid 4242.*own terminal/);
  toast.querySelector('.app-notice-dismiss').click();
  assert.equal(h.dom.window.document.querySelector('[data-notice-id="Restore:batch"]'), null);
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
  assert.equal(h.dom.window.document.querySelector('[data-notice-id="Restore:batch"]'), null);
  h.dom.window.close();
});

test('once the user opens the skipped session and closes it, it leaves the working set like any other', async () => {
  const h = setup({ savedSet: SAVED, liveIds: ['x'] });
  await h.restore();
  h.dom.window.appConfirm = async () => true;
  await vm.runInContext('openSession(sessionMap.get("x"))', h.ctx);
  assert.deepEqual(h.openTerminalCalls, ['a', 'b', 'x']);
  assert.equal(h.dom.window.document.querySelector('[data-notice-id="Restore:batch"]'), null, 'successful manual retry clears its Restore notice');
  vm.runInContext('openSessions.get("x").closed = true;', h.ctx);
  await h.persist();
  assert.deepEqual(h.settings.global.openWorkingSet.map((i) => i.sessionId), ['a', 'b']);
  h.dom.window.close();
});

for (const failure of ['refusal', 'rejection', 'missing result']) {
  test(`background restore ${failure} keeps an actionable alert`, async () => {
    const h = setup({ savedSet: [{ sessionId: 'x', projectPath: '/px', bg: true }], liveIds: [] });
    h.dom.window.api.openTerminal = async () => {
      if (failure === 'rejection') throw new Error('background attach unavailable');
      if (failure === 'missing result') return undefined;
      return { ok: false, error: 'background attach unavailable' };
    };
    h.dom.window.api.getSessionsLiveElsewhere = async () => ({ x: { ...LIVE, kind: 'bg', jobId: '1234abcd' } });
    await h.restore();
    const notice = h.dom.window.document.querySelector('[data-notice-id="Restore:local:x"]');
    assert.ok(notice, 'background restore failure persists');
    assert.equal(notice.getAttribute('role'), 'alert');
    assert.match(notice.textContent, /name-x.*\/px.*(?:background attach unavailable|no result).*sidebar/);
    assert.ok(notice.querySelector('.app-notice-dismiss'));
    assert.match(notice.textContent, /Agents view.*retry attaching/);
    assert.equal(vm.runInContext('openSessions.has("x")', h.ctx), false);
    await h.persist();
    assert.deepEqual(h.settings.global.openWorkingSet.map(i => i.sessionId), ['x']);
    h.dom.window.close();
  });
}

for (const failure of ['refusal', 'rejection', 'missing result']) {
  test(`plain resume restore ${failure} removes its closed entry, persists its place and continues the batch`, async t => {
    const h = setup({ savedSet: SAVED, liveIds: [] });
    t.after(() => h.dom.window.close());
    const openTerminal = h.dom.window.api.openTerminal;
    h.dom.window.api.openTerminal = async id => {
      if (id !== 'x') return openTerminal(id);
      if (failure === 'rejection') throw new Error('resume unavailable');
      return failure === 'missing result' ? undefined : { ok: false, error: 'resume unavailable' };
    };
    await h.restore();
    assert.deepEqual(h.openTerminalCalls, ['a', 'b']);
    assert.equal(vm.runInContext('openSessions.has("x")', h.ctx), false);
    const notice = h.dom.window.document.querySelector('[data-notice-id="Restore:local:x"]');
    assert.ok(notice);
    assert.match(notice.textContent, /open (?:it|the session) from the sidebar.*retry/i);
    assert.doesNotMatch(notice.textContent, /Agents|attaching/);
    await h.persist();
    assert.deepEqual(h.settings.global.openWorkingSet.map(i => i.sessionId), ['a', 'x', 'b']);
    await h.persist();
    assert.deepEqual(h.settings.global.openWorkingSet.map(i => i.sessionId), ['a', 'x', 'b']);
    h.dom.window.api.openTerminal = openTerminal;
    await vm.runInContext('openSession(sessionMap.get("x"))', h.ctx);
    assert.equal(h.dom.window.document.querySelector('[data-notice-id="Restore:local:x"]'), null);
    vm.runInContext('openSessions.get("x").closed = true;', h.ctx);
    await h.persist();
    assert.deepEqual(h.settings.global.openWorkingSet.map(i => i.sessionId), ['a', 'b']);
  });
}
