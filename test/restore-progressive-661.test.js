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

function setup({ savedSet, activeWaitMs = 20000, fresh = false }) {
  const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' });
  const ctx = dom.getInternalVMContext();
  const notices = dom.window.document.createElement('div');
  notices.id = 'app-notices';
  dom.window.document.body.append(notices);
  vm.runInContext(read('app-notices.js'), ctx, { filename: path.join(__dirname, '..', 'public', 'app-notices.js') });
  const settings = { global: { restoreOnStartup: 'auto', openWorkingSet: savedSet } };
  const events = [];
  const pendingOpens = [];
  const pendingRestores = [];
  dom.window.api = {
    restoreBackgroundJob: (id) => new Promise((resolve) => {
      events.push(['restore', id]);
      pendingRestores.push({ id, resolve: () => resolve({ action: 'attach', sessionId: id, jobId: '1234abcd' }),
        refuse: () => resolve({ action: 'refuse', reason: 'stopped job was not respawned automatically', jobId: '1234abcd' }) });
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

  vm.runInContext(read('utils.js'), ctx, { filename: path.join(__dirname, '..', 'public', 'utils.js') });
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
    var RESTORE_ACTIVE_WAIT_MS = ${activeWaitMs};
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
  if (fresh) {
    vm.runInContext('var cachedProjects = []; var cachedAllProjects = []; function refreshSidebar() {}', ctx, { filename: __filename });
    ctx.encodeProjectPath = require('../encode-project-path').encodeProjectPath;
    Object.defineProperty(dom.window, 'crypto', { value: { randomUUID: () => 'new-fresh' } });
    loadAppFunctions(ctx, { functions: ['launchNewSession'] });
  }
  for (const item of savedSet.filter((item) => !item.fresh)) {
    vm.runInContext(`sessionMap.set(${JSON.stringify(item.sessionId)}, ${JSON.stringify({ sessionId: item.sessionId, projectPath: item.projectPath, name: `name-${item.sessionId}` })});`, ctx);
  }
  const restore = () => {
    vm.runInContext('restoringWorkingSet = true;', ctx);
    return vm.runInContext(`runRestore(${JSON.stringify(savedSet)})`, ctx).finally(() => vm.runInContext('restoringWorkingSet = false;', ctx));
  };
  const snapshot = () => JSON.stringify([events.length, pendingOpens.length, pendingRestores.length, vm.runInContext('activeSessionId', ctx)]);
  const settle = async () => {
    let before = snapshot();
    for (let i = 0; i < 40; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const after = snapshot();
      if (after === before && i >= 1) return;
      before = after;
    }
  };
  return { dom, ctx, events, pendingOpens, pendingRestores, restore, settle,
    active: () => vm.runInContext('activeSessionId', ctx), shown: () => JSON.parse(JSON.stringify(vm.runInContext('shown', ctx))),
    tabs: () => JSON.parse(JSON.stringify(vm.runInContext('[...openSessions.keys()]', ctx))) };
}

for (const bg of [false, true]) test(`legacy W restore uses indexed R project (background=${bg})`, async t => {
  const h = setup({ savedSet: [{ sessionId: 'legacy', projectPath: '/repo/.work-files/worktrees/old', active: true, bg }] });
  t.after(() => h.dom.window.close());
  vm.runInContext("sessionMap.get('legacy').projectPath = '/repo'", h.ctx);
  const done = h.restore();
  await h.settle();
  if (bg) { h.pendingRestores.shift().resolve(); await h.settle(); }
  assert.equal(vm.runInContext("openSessions.get('legacy').session.projectPath", h.ctx), '/repo', 'indexed grouping wins over saved W');
  h.pendingOpens.shift().resolve(); await h.settle(); await done;
});

test('persisting an old open W tab prefers its indexed repository', async t => {
  const h = setup({ savedSet: [{ sessionId: 'legacy', projectPath: '/repo/.work-files/worktrees/old' }] });
  t.after(() => h.dom.window.close());
  vm.runInContext("openSessions.set('legacy', { session: { ...sessionMap.get('legacy') } }); sessionMap.get('legacy').projectPath = '/repo'", h.ctx);
  await vm.runInContext('persistWorkingSet()', h.ctx);
  assert.equal((await h.dom.window.api.getSetting('global')).openWorkingSet[0].projectPath, '/repo', 'persist indexed grouping');
});

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
  assert.deepEqual(h.shown(), ['b'], 'the later opens never take the active tab, and nothing is shown twice');
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
  assert.deepEqual(h.shown(), ['x']);
});

async function drain(h, done) {
  for (let n = 0; n < 40 && (h.pendingRestores.length || h.pendingOpens.length || n < 3); n++) {
    while (h.pendingRestores.length) h.pendingRestores.shift().resolve();
    while (h.pendingOpens.length) h.pendingOpens.shift().resolve();
    await h.settle();
  }
  await done;
}

test('a saved active background entry opens before an interactive sibling', async (t) => {
  const h = setup({ savedSet: [
    { sessionId: 'a', projectPath: '/pa' },
    { sessionId: 'bg', projectPath: '/pb', bg: true, active: true, attachJobId: '1234abcd' },
  ] });
  const done = h.restore();
  t.after(async () => { await drain(h, done); h.dom.window.close(); });
  await h.settle();
  assert.deepEqual(h.pendingOpens.map((p) => p.sessionId), [], 'no other terminal opens before the saved active background entry is ready');
  assert.equal(h.pendingRestores.length, 1);
  h.pendingRestores.shift().resolve();
  await h.settle();
  assert.deepEqual(h.pendingOpens.map((p) => p.sessionId), ['bg'], 'the active background entry reaches its terminal first');
  h.pendingOpens.shift().resolve();
  await h.settle();
  assert.equal(h.active(), 'bg');
  assert.deepEqual(h.pendingOpens.map((p) => p.sessionId), ['a'], 'the interactive sibling opens once the active entry is up');
});

test('a delayed active background attach does not take a tab the user selected meanwhile', async (t) => {
  const h = setup({ savedSet: [
    { sessionId: 'a', projectPath: '/pa' },
    { sessionId: 'bg', projectPath: '/pb', bg: true, active: true, attachJobId: '1234abcd' },
  ] });
  const done = h.restore();
  t.after(async () => { await drain(h, done); h.dom.window.close(); });
  await h.settle();
  h.pendingRestores.shift().resolve();
  await h.settle();
  assert.deepEqual(h.pendingOpens.map((p) => p.sessionId), ['bg']);
  vm.runInContext("showSession('a')", h.ctx);
  h.pendingOpens.shift().resolve();
  await h.settle();
  assert.equal(h.active(), 'a', 'background completion does not steal focus back to bg');
  while (h.pendingOpens.length) { h.pendingOpens.shift().resolve(); await h.settle(); }
  await done;
  assert.equal(h.active(), 'a');
});

test('when the active background entry is slow, the rest opens after the bound and the late attach keeps the user tab', async (t) => {
  const h = setup({ activeWaitMs: 500, savedSet: [
    { sessionId: 'a', projectPath: '/pa' },
    { sessionId: 'bg', projectPath: '/pb', bg: true, active: true, attachJobId: '1234abcd' },
  ] });
  const done = h.restore();
  t.after(async () => { await drain(h, done); h.dom.window.close(); });
  await h.settle();
  assert.deepEqual(h.pendingOpens.map((p) => p.sessionId), []);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepEqual(h.pendingOpens.map((p) => p.sessionId), ['a'], 'the bound expired: the interactive entry opens');
  h.pendingOpens.shift().resolve();
  await h.settle();
  assert.equal(h.active(), 'a', 'an empty screen is filled by the first tab that opens');
  h.pendingRestores.shift().resolve();
  await h.settle();
  h.pendingOpens.shift().resolve();
  await done;
  assert.equal(h.active(), 'a', 'the late active attach does not take the tab the user is on');
  assert.deepEqual(h.tabs(), ['a', 'bg']);
});

test('a fresh restored terminal does not take the selected tab', async (t) => {
  const h = setup({ fresh: true, savedSet: [
    { sessionId: 'a', projectPath: '/pa', active: true },
    { sessionId: 'fresh', projectPath: '/pf', fresh: true },
  ] });
  const done = h.restore();
  t.after(async () => { await drain(h, done); h.dom.window.close(); });
  await h.settle();
  assert.equal(h.pendingOpens[0]?.sessionId, 'a');
  h.pendingOpens.shift().resolve();
  await h.settle();
  assert.equal(h.active(), 'a');
  assert.equal(h.pendingOpens[0]?.sessionId, 'new-fresh', 'the fresh entry opens behind the active tab');
  h.pendingOpens.shift().resolve();
  await done;
  assert.equal(h.active(), 'a', 'a fresh restore preserves the selected tab');
  assert.deepEqual(h.shown(), ['a']);
});

test('a fresh restored terminal does not take a tab selected while its open is pending', async (t) => {
  const h = setup({ fresh: true, savedSet: [
    { sessionId: 'a', projectPath: '/pa', active: true },
    { sessionId: 'b', projectPath: '/pb' },
    { sessionId: 'fresh', projectPath: '/pf', fresh: true },
  ] });
  const done = h.restore();
  t.after(async () => { await drain(h, done); h.dom.window.close(); });
  await h.settle();
  h.pendingOpens.shift().resolve();
  await h.settle();
  h.pendingOpens.shift().resolve();
  await h.settle();
  assert.equal(h.active(), 'a');
  assert.equal(h.pendingOpens[0]?.sessionId, 'new-fresh');
  vm.runInContext("showSession('b')", h.ctx);
  h.pendingOpens.shift().resolve();
  await done;
  assert.equal(h.active(), 'b', 'the fresh terminal opens behind the tab selected while it was pending');
  assert.deepEqual(h.shown(), ['a', 'b']);
});

test('a background sibling does not fill the screen before the saved active background entry', async (t) => {
  const h = setup({ savedSet: [
    { sessionId: 'active-bg', projectPath: '/pa', bg: true, active: true, attachJobId: '1234abcd' },
    { sessionId: 'peer-bg', projectPath: '/pb', bg: true, attachJobId: '1234abcd' },
  ] });
  const done = h.restore();
  t.after(async () => { await drain(h, done); h.dom.window.close(); });
  await h.settle();
  assert.equal(h.pendingRestores.length, 2, 'both preparations run concurrently');
  h.pendingRestores.splice(1, 1)[0].resolve();
  await h.settle();
  assert.equal(h.pendingOpens[0]?.sessionId, 'peer-bg');
  h.pendingOpens.shift().resolve();
  await h.settle();
  assert.equal(h.active(), null, 'a peer does not fill the screen before the active gate settles');
  h.pendingRestores.shift().resolve();
  await h.settle();
  h.pendingOpens.shift().resolve();
  await done;
  assert.equal(h.active(), 'active-bg', 'the saved active entry fills the screen when it opens');
  assert.deepEqual(h.tabs(), ['active-bg', 'peer-bg']);
});

test('when the saved active background entry is refused, the first open tab fills the empty screen at the end', async (t) => {
  const h = setup({ savedSet: [
    { sessionId: 'active-bg', projectPath: '/pa', bg: true, active: true, attachJobId: '1234abcd' },
    { sessionId: 'peer-bg', projectPath: '/pb', bg: true, attachJobId: '1234abcd' },
  ] });
  const done = h.restore();
  t.after(async () => { await drain(h, done); h.dom.window.close(); });
  await h.settle();
  h.pendingRestores.splice(1, 1)[0].resolve();
  await h.settle();
  h.pendingOpens.shift().resolve();
  await h.settle();
  assert.equal(h.active(), null);
  h.pendingRestores.shift().refuse();
  await done;
  assert.equal(h.active(), 'peer-bg', 'nothing else is shown, so the open peer fills the screen');
});

test('completing an interactive restore preserves a user selection made during the run', async (t) => {
  const h = setup({ savedSet: [
    { sessionId: 'a', projectPath: '/pa' },
    { sessionId: 'b', projectPath: '/pb', active: true },
    { sessionId: 'c', projectPath: '/pc' },
  ] });
  const done = h.restore();
  t.after(async () => { await drain(h, done); h.dom.window.close(); });
  await h.settle();
  h.pendingOpens.shift().resolve();
  await h.settle();
  h.pendingOpens.shift().resolve();
  await h.settle();
  vm.runInContext("showSession('a')", h.ctx);
  h.pendingOpens.shift().resolve();
  await done;
  assert.equal(h.active(), 'a', 'the final restoration respects the user selection');
  assert.deepEqual(h.shown(), ['b', 'a']);
});

test('a stale active id that is not an open tab is replaced by the restored tab', async (t) => {
  const h = setup({ savedSet: [{ sessionId: 'a', projectPath: '/pa', active: true }] });
  vm.runInContext("activeSessionId = 'gone'", h.ctx);
  const done = h.restore();
  t.after(async () => { await drain(h, done); h.dom.window.close(); });
  await h.settle();
  h.pendingOpens.shift().resolve();
  await done;
  assert.equal(h.active(), 'a', 'an id absent from the open tabs is an empty screen');
});

test('a restored tab never replaces a selected exited terminal', async (t) => {
  const h = setup({ savedSet: [{ sessionId: 'a', projectPath: '/pa', active: true }] });
  vm.runInContext("openSessions.set('reading-output', { closed: true }); showSession('reading-output');", h.ctx);
  const done = h.restore();
  t.after(async () => { await drain(h, done); h.dom.window.close(); });
  await h.settle();
  h.pendingOpens.shift().resolve();
  await done;
  assert.equal(h.active(), 'reading-output', 'a mounted exited terminal the user selected is not an empty screen');
  assert.deepEqual(h.shown(), ['reading-output']);
});

test('the final show preserves a terminal selected and exited while the last open was pending', async (t) => {
  const h = setup({ savedSet: [{ sessionId: 'a', projectPath: '/pa', active: true }] });
  const done = h.restore();
  t.after(async () => { await drain(h, done); h.dom.window.close(); });
  await h.settle();
  vm.runInContext("openSessions.set('reading-output', { closed: true }); showSession('reading-output');", h.ctx);
  h.pendingOpens.shift().resolve();
  await done;
  assert.equal(h.active(), 'reading-output', 'the final show does not replace the selected exited terminal');
  assert.deepEqual(h.shown(), ['reading-output']);
});

test('an already open background peer fills the empty screen when the active wait expires', async (t) => {
  const h = setup({ activeWaitMs: 1000, savedSet: [
    { sessionId: 'active-bg', projectPath: '/pa', bg: true, active: true, attachJobId: '1234abcd' },
    { sessionId: 'peer-bg', projectPath: '/pb', bg: true, attachJobId: '1234abcd' },
  ] });
  const done = h.restore();
  t.after(async () => { await drain(h, done); h.dom.window.close(); });
  await h.settle();
  h.pendingRestores.splice(1, 1)[0].resolve();
  await h.settle();
  h.pendingOpens.shift().resolve();
  await h.settle();
  assert.equal(h.active(), null, 'the peer stays behind the active gate');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await h.settle();
  assert.equal(h.pendingRestores.length, 1, 'the active preparation is still pending');
  assert.deepEqual(h.tabs(), ['peer-bg'], 'only the peer is open');
  assert.equal(h.active(), 'peer-bg', 'the expired wait shows the open peer without awaiting the active task');
  h.pendingRestores.shift().resolve();
  await h.settle();
  h.pendingOpens.shift().resolve();
  await done;
  assert.equal(h.active(), 'peer-bg', 'the late active attach opens behind the shown peer');
  assert.deepEqual(h.tabs(), ['active-bg', 'peer-bg']);
});

test('the expired active wait shows a ready peer, not the active entry whose terminal open is still pending', async (t) => {
  const h = setup({ activeWaitMs: 1000, savedSet: [
    { sessionId: 'active-bg', projectPath: '/pa', bg: true, active: true, attachJobId: '1234abcd' },
    { sessionId: 'peer-bg', projectPath: '/pb', bg: true, attachJobId: '1234abcd' },
  ] });
  const done = h.restore();
  t.after(async () => { await drain(h, done); h.dom.window.close(); });
  await h.settle();
  h.pendingRestores.splice(h.pendingRestores.findIndex((p) => p.id === 'active-bg'), 1)[0].resolve();
  await h.settle();
  h.pendingRestores.shift().resolve();
  await h.settle();
  h.pendingOpens.splice(h.pendingOpens.findIndex((p) => p.sessionId === 'peer-bg'), 1)[0].resolve();
  await h.settle();
  assert.deepEqual(h.pendingOpens.map((p) => p.sessionId), ['active-bg'], 'the active terminal IPC has not returned');
  assert.deepEqual(h.tabs().sort(), ['active-bg', 'peer-bg'], 'both entries are allocated, only the peer is open');
  assert.equal(h.active(), null, 'the peer stays behind the active gate');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await h.settle();
  assert.equal(h.active(), 'peer-bg', 'the expired wait shows the ready peer, not the terminal still opening');
  h.pendingOpens.shift().resolve();
  await done;
  assert.equal(h.active(), 'peer-bg', 'the late active terminal opens behind the shown peer');
  assert.deepEqual(h.shown(), ['peer-bg']);
});

test('a refused active background entry shows an already open peer without waiting for another pending background task', async (t) => {
  const h = setup({ activeWaitMs: 1000, savedSet: [
    { sessionId: 'active-bg', projectPath: '/pa', bg: true, active: true, attachJobId: '1234abcd' },
    { sessionId: 'peer-bg', projectPath: '/pb', bg: true, attachJobId: '1234abcd' },
    { sessionId: 'slow-bg', projectPath: '/pc', bg: true, attachJobId: '1234abcd' },
  ] });
  const done = h.restore();
  t.after(async () => { await drain(h, done); h.dom.window.close(); });
  await h.settle();
  assert.deepEqual(h.pendingRestores.map((p) => p.id), ['active-bg', 'peer-bg']);
  h.pendingRestores.splice(1, 1)[0].resolve();
  await h.settle();
  h.pendingOpens.shift().resolve();
  await h.settle();
  assert.deepEqual(h.tabs(), ['peer-bg'], 'the peer is open');
  assert.equal(h.active(), null, 'the peer stays behind the active gate');
  assert.deepEqual(h.pendingRestores.map((p) => p.id), ['active-bg', 'slow-bg'], 'the released slot went to the slow peer');
  h.pendingRestores.splice(h.pendingRestores.findIndex((p) => p.id === 'active-bg'), 1)[0].refuse();
  await h.settle();
  assert.deepEqual(h.pendingRestores.map((p) => p.id), ['slow-bg'], 'the slow peer is still pending');
  assert.equal(h.active(), 'peer-bg', 'the refused active entry does not leave the open peer hidden behind an unrelated pending task');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await h.settle();
  assert.deepEqual(h.shown(), ['peer-bg'], 'the cleared active timer shows nothing twice');
});

test('the expired active wait does not replace a tab the user selected meanwhile', async (t) => {
  const h = setup({ activeWaitMs: 1000, savedSet: [
    { sessionId: 'active-bg', projectPath: '/pa', bg: true, active: true, attachJobId: '1234abcd' },
    { sessionId: 'peer-bg', projectPath: '/pb', bg: true, attachJobId: '1234abcd' },
  ] });
  const done = h.restore();
  t.after(async () => { await drain(h, done); h.dom.window.close(); });
  await h.settle();
  h.pendingRestores.splice(1, 1)[0].resolve();
  await h.settle();
  h.pendingOpens.shift().resolve();
  await h.settle();
  vm.runInContext("openSessions.set('chosen', { closed: false }); showSession('chosen');", h.ctx);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await h.settle();
  assert.equal(h.active(), 'chosen', 'the expired wait respects the user selection');
  assert.deepEqual(h.shown(), ['chosen']);
});
