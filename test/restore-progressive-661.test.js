// A working-set restore opens the saved active session first and keeps the
// user on it while the other sessions open behind it, two background
// attaches at a time. See .ai/contexts/bg-agents.md ("Restore of background
// sessions") and docs/session-restore.md.

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

function topLevelDeclarations(src, names) {
  return names
    .map((name) => (src.match(new RegExp(`^(?:const|let) ${name} = .*;$`, 'm')) || [])[0])
    .filter(Boolean)
    .join('\n');
}

function setup({ savedSet }) {
  const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' });
  const ctx = dom.getInternalVMContext();
  const notices = dom.window.document.createElement('div');
  notices.id = 'app-notices';
  dom.window.document.body.append(notices);
  vm.runInContext(read('app-notices.js'), ctx);
  const settings = { global: { restoreOnStartup: 'auto', openWorkingSet: savedSet } };
  const events = [];
  const pendingOpens = [];
  const pendingRestores = [];
  dom.window.api = {
    restoreBackgroundJob: (id) => new Promise((resolve) => {
      events.push(['restore', id]);
      pendingRestores.push({ id, resolve: () => resolve({ action: 'attach', sessionId: id, jobId: '1234abcd' }) });
    }),
    getSessionContinuations: async () => ({ candidates: [], unresolved: false, continued: false }),
    getSetting: async (key) => JSON.parse(JSON.stringify(settings[key] || null)),
    setSetting: async (key, value) => { settings[key] = JSON.parse(JSON.stringify(value)); },
    getSessionLiveElsewhere: async (id) => (savedSet.find((item) => item.sessionId === id)?.bg ? { kind: 'bg', jobId: '1234abcd', cwd: '/px' } : null),
    getSessionsLiveElsewhere: async () => ({}),
    openTerminal: (sessionId) => new Promise((resolve) => {
      events.push(['open', sessionId, vm.runInContext('activeSessionId', ctx)]);
      pendingOpens.push({ sessionId, resolve: () => resolve({ ok: true }) });
    }),
  };
  dom.window.appConfirm = async () => { throw new Error('an automatic restore must never prompt'); };

  vm.runInContext(read('utils.js'), ctx);
  vm.runInContext(read('resume-guard.js'), ctx, { filename: path.join(__dirname, '..', 'public', 'resume-guard.js') });
  vm.runInContext(`
    var openSessions = new Map();
    var pendingSessions = new Map();
    var sessionMap = new Map();
    var localMergedMemberRows = new Map();
    var activeSessionId = null;
    var shown = [];
    var restoringWorkingSet = false;
    var restoreRunDepth = 0;
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
    function showSession(id) { activeSessionId = id; shown.push(id); }
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
    function sessionItemEl() { return null; }
    function clearDormantRow() { return false; }
    function showSessionActionFailure() {}
  `, ctx);
  loadAppFunctions(ctx, {
    functions: ['rowSessionIds', 'rowHeadId', 'rowOpenId'], sourcePath: path.join(__dirname, '../public/session-activity-dom.js'),
  });
  vm.runInContext(topLevelDeclarations(APP_SRC, ['restoreMode', 'skippedWorkingSetEntries', 'restoreSavedIndex', 'restoreAwaitingConsent', 'restoreInFlight', 'restoreIndexingDone', 'continuationRetryCancelled', 'dormantWorkingSet', 'openingSessions', 'activeOpenSessions'])
    .replace(/^const /gm, 'var ').replace(/^let /gm, 'var '), ctx);
  loadAppFunctions(ctx, { functions: ['persistWorkingSet', 'pendingRestoreEntries', 'runRestore', 'openSession', 'openSessionNow', 'indexedRowOf', 'prepareBackgroundRestore'].filter((name) => APP_SRC.includes(`function ${name}(`)) });
  ctx.restoreSavedIndexFrom = savedSet;
  vm.runInContext('restoreSavedIndex = new Map(restoreSavedIndexFrom.map((item, index) => [item.sessionId, index]));', ctx);
  for (const item of savedSet) {
    vm.runInContext(`sessionMap.set(${JSON.stringify(item.sessionId)}, ${JSON.stringify({ sessionId: item.sessionId, projectPath: item.projectPath, name: `name-${item.sessionId}` })});`, ctx);
  }
  const restore = () => {
    vm.runInContext('restoringWorkingSet = true;', ctx);
    return vm.runInContext(`runRestore(${JSON.stringify(savedSet)})`, ctx).finally(() => vm.runInContext('restoringWorkingSet = false;', ctx));
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
  return { dom, ctx, events, pendingOpens, pendingRestores, restore, settle,
    active: () => vm.runInContext('activeSessionId', ctx), shown: () => JSON.parse(JSON.stringify(vm.runInContext('shown', ctx))),
    tabs: () => JSON.parse(JSON.stringify(vm.runInContext('[...openSessions.keys()]', ctx))) };
}

test('the saved active session opens first and is shown before the others open', async (t) => {
  const savedSet = [
    { sessionId: 'a', projectPath: '/pa' },
    { sessionId: 'b', projectPath: '/pb', active: true },
    { sessionId: 'c', projectPath: '/pc' },
  ];
  const h = setup({ savedSet });
  t.after(() => h.dom.window.close());
  const done = h.restore();
  await h.settle();
  assert.deepEqual(h.events, [['open', 'b', null]], 'the active session is the first to open');
  h.pendingOpens.shift().resolve();
  await h.settle();
  assert.equal(h.active(), 'b', 'the active session is shown as soon as it is open');
  assert.equal(h.events.length, 2, 'the next session opens once the first is shown');
  while (h.pendingOpens.length) { h.pendingOpens.shift().resolve(); await h.settle(); }
  await done;
  assert.deepEqual(h.events.map((event) => event[1]), ['b', 'a', 'c']);
  assert.deepEqual(h.shown(), ['b', 'b'], 'the later opens never take the active tab');
  assert.deepEqual(h.tabs(), ['a', 'b', 'c'], 'the tab order follows the saved order');
});

test('background sessions are attached two at a time, behind the active tab', async (t) => {
  const savedSet = [
    { sessionId: 'x', projectPath: '/px', active: true },
    { sessionId: 'b1', projectPath: '/pb', bg: true, attachJobId: '1234abcd' },
    { sessionId: 'b2', projectPath: '/pb', bg: true, attachJobId: '1234abcd' },
    { sessionId: 'b3', projectPath: '/pb', bg: true, attachJobId: '1234abcd' },
  ];
  const h = setup({ savedSet });
  t.after(() => h.dom.window.close());
  const done = h.restore();
  await h.settle();
  h.pendingOpens.shift().resolve();
  await h.settle();
  assert.equal(h.active(), 'x');
  assert.equal(h.pendingRestores.length, 2, 'at most two background restores are in flight');
  h.pendingRestores.shift().resolve();
  await h.settle();
  h.pendingOpens.shift().resolve();
  await h.settle();
  assert.equal(h.pendingRestores.length, 2, 'a finished attach lets the next background restore start');
  while (h.pendingRestores.length || h.pendingOpens.length) {
    if (h.pendingRestores.length) h.pendingRestores.shift().resolve();
    await h.settle();
    if (h.pendingOpens.length) h.pendingOpens.shift().resolve();
    await h.settle();
  }
  await done;
  assert.equal(h.active(), 'x', 'attaching a background session never takes the active tab');
  assert.deepEqual(h.shown(), ['x', 'x']);
});
