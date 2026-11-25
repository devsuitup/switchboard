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
  vm.runInContext(read('modal-stack.js'), ctx, { filename: path.join(__dirname, '../public/modal-stack.js') });
  vm.runInContext(read('app-notices.js'), ctx, { filename: path.join(__dirname, '../public/app-notices.js') });
  const settings = { global: { restoreOnStartup: 'auto', openWorkingSet: savedSet } };
  const openTerminalCalls = [];
  const liveQueries = { single: [], batch: [] };

  dom.window.api = {
    restoreBackgroundJob: async () => ({ action: 'attach', sessionId: 'x', jobId: '1234abcd' }),
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
    function sessionItemEl() { return null; }
  `, ctx);
  loadAppFunctions(ctx, {
    functions: ['rowSessionIds', 'rowHeadId', 'rowOpenId'], sourcePath: path.join(__dirname, '../public/session-activity-dom.js'),
  });
  vm.runInContext(topLevelDeclarations(APP_SRC, ['restoreMode', 'LIVE_ELSEWHERE_NOTICE_MS', 'skippedWorkingSetEntries', 'restoreSavedIndex', 'restoreAwaitingConsent', 'restoreInFlight', 'restoreIndexingDone', 'continuationRetryCancelled', 'openingSessions', 'dormantWorkingSet'])
    .replace(/^const /gm, 'var ').replace(/^let /gm, 'var '), ctx);
  loadAppFunctions(ctx, { functions: ['persistWorkingSet', 'pendingRestoreEntries', 'runRestore', 'openSession', 'openSessionNow', 'clearDormantRow', 'dormantRowIds', 'syncDormantRow', 'indexedRowOf',
    ...['prepareBackgroundRestore'].filter(name => APP_SRC.includes(`function ${name}(`))] });
  if (APP_SRC.includes('function showLiveElsewhereNotice(')) {
    vm.runInContext(functionSource(APP_SRC, 'showRestoreNotice'), ctx, { filename: 'public/app.js:showRestoreNotice' });
    vm.runInContext(functionSource(APP_SRC, 'showLiveElsewhereNotice'), ctx, { filename: 'public/app.js:showLiveElsewhereNotice' });
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

for (const action of ['attach', 'refuse', 'respawned-not-attached']) {
  test(`B-T${action === 'attach' ? '1' : action === 'refuse' ? '2' : '3'} background restore ${action} never opens an interactive terminal`, async t => {
    const savedSet = [{ sessionId: 'x', projectPath: '/px', bg: true, attachJobId: '1234abcd' }];
    const h = setup({ savedSet, liveIds: [] });
    t.after(() => h.dom.window.close());
    const calls = [];
    h.dom.window.api.restoreBackgroundJob = async id => {
      calls.push(['restore', id]);
      return { action, sessionId: id, jobId: '1234abcd', reason: 'worker liveness unknown' };
    };
    h.dom.window.api.getSessionLiveElsewhere = async () => ({ kind: 'bg', jobId: '1234abcd', cwd: '/px' });
    h.dom.window.api.openTerminal = async (id, _cwd, _fresh, options) => { calls.push(['open', id, options]); return { ok: true }; };
    await h.restore();
    assert.deepEqual(calls[0], ['restore', 'x'], 'background IPC precedes every open');
    if (action === 'attach') {
      assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['restore', 'x'], ['open', 'x', { type: 'attach', jobId: '1234abcd', cwd: '/px' }]]);
      assert.equal(vm.runInContext('openSessions.get("x").attach', h.ctx), true);
    } else {
      assert.equal(calls.length, 3, 'three attempts with no openSession/openTerminal fallback');
      assert.equal(vm.runInContext('skippedWorkingSetEntries.has("x")', h.ctx), true);
      const notice = h.dom.window.document.querySelector('[data-notice-id="Restore:background"]');
      assert.ok(notice);
      assert.match(notice.textContent, /1234abcd/);
      if (action === 'refuse') assert.match(notice.textContent, /worker liveness unknown/);
      else assert.equal(notice.querySelector('.app-notice-action')?.textContent, 'Attach');
      await h.persist();
      assert.equal(h.settings.global.openWorkingSet[0].attachJobId, '1234abcd');
    }
  });
}

test('B-T4 GUARD a live background descriptor uses the existing attach options', async t => {
  const h = setup({ savedSet: [{ sessionId: 'x', projectPath: '/px', bg: true }], liveIds: [] });
  t.after(() => h.dom.window.close());
  h.dom.window.api.getSessionsLiveElsewhere = async () => ({ x: { kind: 'bg', jobId: '1234abcd', cwd: '/px' } });
  h.dom.window.api.getSessionLiveElsewhere = async () => ({ kind: 'bg', jobId: '1234abcd', cwd: '/px' });
  const options = [];
  h.dom.window.api.openTerminal = async (_id, _cwd, _fresh, opts) => { options.push(opts); return { ok: true }; };
  await h.restore();
  assert.deepEqual(JSON.parse(JSON.stringify(options)), [{ type: 'attach', jobId: '1234abcd', cwd: '/px' }]);
});

test('B-T1 descriptor disappearing after restore permission refuses instead of resuming', async t => {
  const h = setup({ savedSet: [{ sessionId: 'x', projectPath: '/px', bg: true }], liveIds: [] });
  t.after(() => h.dom.window.close());
  h.dom.window.api.getSessionLiveElsewhere = async () => null;
  await h.restore();
  assert.deepEqual(h.openTerminalCalls, []);
  assert.equal(vm.runInContext('skippedWorkingSetEntries.has("x")', h.ctx), true);
});

for (const recovery of ['attach', 'respawn']) {
  test(`B notice ${recovery} action retries attachment without an interactive fallback`, async t => {
    const h = setup({ savedSet: [{ sessionId: 'x', projectPath: '/px', bg: true, attachJobId: '1234abcd' }], liveIds: [] });
    t.after(() => h.dom.window.close());
    const calls = [];
    let attempts = 0;
    h.dom.window.api.restoreBackgroundJob = async (id, options) => {
      calls.push(['restore', id, options]);
      if (++attempts <= (recovery === 'attach' ? 3 : 1)) { return recovery === 'attach' ? { action: 'respawned-not-attached', jobId: '1234abcd' }
        : { action: 'refuse', jobId: '1234abcd', reason: 'stopped', recovery: 'respawn' }; }
      return { action: 'attach', jobId: '1234abcd', sessionId: id };
    };
    h.dom.window.api.bgAgentVerb = async (...args) => { calls.push(['verb', ...args]); return { ok: true }; };
    h.dom.window.api.getSessionLiveElsewhere = async () => ({ kind: 'bg', jobId: '1234abcd', cwd: '/px' });
    h.dom.window.api.openTerminal = async (_id, _cwd, _fresh, options) => { calls.push(['open', options]); return { ok: true }; };
    await h.restore();
    const action = h.dom.window.document.querySelector('.app-notice-action');
    assert.equal(action?.textContent, recovery === 'attach' ? 'Attach' : 'Respawn');
    action.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.filter(call => call[0] === 'verb').length, recovery === 'respawn' ? 1 : 0);
    assert.deepEqual(JSON.parse(JSON.stringify(calls.filter(call => call[0] === 'open'))), [['open', { type: 'attach', jobId: '1234abcd', cwd: '/px' }]]);
    assert.equal(h.dom.window.document.querySelector('[data-notice-id="Restore:local:x"]'), null);
  });
}

test('B a save while background restore waits on main keeps exactly one saved slot', async t => {
  const h = setup({ savedSet: [{ sessionId: 'x', projectPath: '/px', bg: true, attachJobId: '1234abcd' }], liveIds: [] });
  t.after(() => h.dom.window.close());
  let release, entered;
  const waiting = new Promise(resolve => { release = resolve; });
  const called = new Promise(resolve => { entered = resolve; });
  h.dom.window.api.restoreBackgroundJob = async () => { entered(); return waiting; };
  const restoring = h.restore();
  await called;
  try {
    await h.persist();
    assert.deepEqual(h.settings.global.openWorkingSet.map(item => item.sessionId), ['x']);
  } finally {
    release({ action: 'refuse', jobId: '1234abcd', reason: 'unknown' });
    await restoring;
  }
});

const SAVED = [
  { sessionId: 'a', projectPath: '/pa', active: false },
  { sessionId: 'x', projectPath: '/px', active: false },
  { sessionId: 'b', projectPath: '/pb', active: true },
];

test('1191 three refused background entries share one dismiss and successful opens remove members', async t => {
  const savedSet = ['a', 'b', 'c'].map(sessionId => ({ sessionId, projectPath: '/p' + sessionId, bg: true, attachJobId: '1234abcd' }));
  const h = setup({ savedSet, liveIds: [] });
  t.after(() => h.dom.window.close());
  h.dom.window.api.restoreBackgroundJob = async () => ({ action: 'refuse', jobId: '1234abcd', reason: 'stopped' });
  await h.restore();
  const container = h.dom.window.document.querySelector('#app-notices');
  assert.equal(container.children.length, 1, 'one background restore notice for the launch');
  assert.equal(container.querySelectorAll('.app-notice-dismiss').length, 1);
  for (const id of ['a', 'b', 'c']) assert.ok(container.textContent.includes(`"name-${id}" (${id}) at /p${id}, job 1234abcd: stopped`));
  h.dom.window.api.restoreBackgroundJob = async id => ({ action: 'attach', sessionId: id, jobId: '1234abcd' });
  h.dom.window.api.getSessionLiveElsewhere = async () => ({ kind: 'bg', jobId: '1234abcd', cwd: '/p' });
  for (const id of ['a', 'b', 'c']) {
    await vm.runInContext(`openSession(sessionMap.get('${id}'))`, h.ctx);
    assert.ok(!container.textContent.includes(`name-${id}`), 'successful open removes exactly its member');
  }
  assert.equal(container.children.length, 0, 'empty group is removed');
});

for (const transient of ['unknown', 'respawned', 'disappeared', 'live-descriptor']) {
  for (const succeeds of [true, false]) test(`1191 ${transient} retries twice attach-only; success=${succeeds}`, async t => {
    const h = setup({ savedSet: [{ sessionId: 'x', projectPath: '/px', bg: true, attachJobId: '1234abcd' }], liveIds: [] });
    t.after(() => h.dom.window.close());
    const calls = [], logs = [], delays = [];
    const schedule = h.dom.window.setTimeout.bind(h.dom.window);
    h.dom.window.setTimeout = (fn, ms) => { delays.push(ms); return schedule(fn, ms === 1000 ? 0 : ms); };
    h.dom.window.console.warn = message => logs.push(message);
    h.dom.window.api.bgAgentVerb = async () => assert.fail('automatic retries must never respawn');
    h.dom.window.api.restoreBackgroundJob = async (id, options) => {
      calls.push(options?.attachOnly === true);
      assert.equal(h.dom.window.document.querySelector('#app-notices').children.length, 0, 'only final outcome is shown');
      if (succeeds && calls.length === 3 || transient === 'disappeared') return { action: 'attach', sessionId: id, jobId: '1234abcd' };
      if (transient === 'respawned') return { action: 'respawned-not-attached', jobId: '1234abcd' };
      return { action: 'refuse', jobId: '1234abcd', reason: transient === 'unknown' ? `worker liveness unknown sample ${calls.length}` : 'live worker has no attachable background descriptor — not attached' };
    };
    h.dom.window.api.getSessionLiveElsewhere = async () => transient === 'disappeared' && !(succeeds && calls.length === 3)
      ? null : { kind: 'bg', jobId: '1234abcd', cwd: '/px' };
    await h.restore();
    assert.deepEqual(calls, [false, true, true], 'two retries must be attach-only');
    assert.equal(delays.filter(ms => ms === 1000).length, 2, 'short backoff before each retry');
    assert.equal(h.dom.window.document.querySelector('#app-notices').children.length, succeeds ? 0 : 1);
    assert.equal(logs.length, succeeds ? 0 : 1, 'one log for final failure only');
    if (!succeeds) {
      assert.match(logs[0], /\[restore-bg\].*session=x.*job=1234abcd.*outcome=.*attempts=3/);
      if (transient === 'unknown') assert.match(h.dom.window.document.querySelector('#app-notices').textContent, /sample 3/);
      if (transient === 'disappeared') assert.equal(h.dom.window.document.querySelector('.app-notice-action')?.textContent, 'Attach', 'M1 descriptor loss keeps Attach');
    }
  });
}

test('1191 failed terminal attaches join the background group and log once per session', async t => {
  const savedSet = ['a', 'b', 'c'].map(sessionId => ({ sessionId, projectPath: '/p', bg: true, attachJobId: '1234abcd' }));
  const h = setup({ savedSet, liveIds: [] });
  t.after(() => h.dom.window.close());
  const logs = [];
  h.dom.window.console.warn = message => logs.push(message);
  h.dom.window.api.restoreBackgroundJob = async sessionId => ({ action: 'attach', sessionId, jobId: '1234abcd' });
  h.dom.window.api.getSessionLiveElsewhere = async () => ({ kind: 'bg', jobId: '1234abcd', cwd: '/p' });
  h.dom.window.api.openTerminal = async () => ({ ok: false, error: 'attach failed' });
  await h.restore();
  assert.equal(h.dom.window.document.querySelector('#app-notices').children.length, 1, 'terminal attach failures belong to the same group');
  assert.equal(logs.length, 3, 'one final log per failed terminal attach');
  await h.persist();
  assert.deepEqual(h.settings.global.openWorkingSet.map(item => item.sessionId), ['a', 'b', 'c']);
});

test('1191 final background failure logs identifiers and outcome without session content', async t => {
  const h = setup({ savedSet: [{ sessionId: 'x', projectPath: '/secret-cwd', bg: true, attachJobId: '1234abcd' }], liveIds: [] });
  t.after(() => h.dom.window.close());
  const logs = [];
  h.dom.window.console.warn = message => logs.push(message);
  h.dom.window.api.restoreBackgroundJob = async () => ({ action: 'refuse', jobId: '1234abcd', reason: 'SECRET prompt text' });
  await h.restore();
  assert.equal(logs.length, 1, 'failed restore emits one main-log-bound warning');
  assert.match(logs[0], /\[restore-bg\].*session=x.*job=1234abcd.*outcome=refuse.*attempts=1/);
  assert.doesNotMatch(logs[0], /SECRET|secret-cwd|name-x/);
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = main.indexOf("  mainWindow.webContents.on('console-message',");
  assert.ok(start >= 0);
  const end = main.indexOf('\n  });', start) + '\n  });'.length;
  let forward;
  const forwarded = [];
  vm.runInNewContext(main.slice(start, end), {
    mainWindow: { webContents: { on: (event, handler) => { assert.equal(event, 'console-message'); forward = handler; } } },
    log: { error: message => forwarded.push(message) },
  }, { filename: path.join(__dirname, '../main.js') });
  forward({}, 2, logs[0], 42, 'app.js');
  assert.deepEqual(forwarded, [`[renderer:2] app.js:42 ${logs[0]}`]);
  forward({}, 1, 'info', 1, 'app.js');
  assert.equal(forwarded.length, 1);
});

test('M1 respawn followed by dead-worker retries keeps Attach and Respawned information', async t => {
  const h = setup({ savedSet: [{ sessionId: 'x', projectPath: '/px', bg: true }], liveIds: [] });
  t.after(() => h.dom.window.close());
  const schedule = h.dom.window.setTimeout.bind(h.dom.window);
  h.dom.window.setTimeout = (fn, ms) => schedule(fn, ms === 1000 ? 0 : ms);
  const calls = [];
  h.dom.window.api.restoreBackgroundJob = async (_id, options) => {
    calls.push(options?.attachOnly === true);
    return calls.length === 1 ? { action: 'respawned-not-attached', jobId: '1234abcd' }
      : { action: 'refuse', jobId: '1234abcd', reason: 'worker is not live — not attached' };
  };
  await h.restore();
  const notice = h.dom.window.document.querySelector('#app-notices');
  assert.equal(notice.querySelector('.app-notice-action')?.textContent, 'Attach', 'M1 dead-worker retry keeps Attach');
  assert.match(notice.textContent, /Respawned/);
  assert.deepEqual(calls, [false, true, true]);
});

for (const late of [false, true]) test(`M2 main may finish after 80 seconds; expired result never opens a tab: late=${late}`, async t => {
  const h = setup({ savedSet: [{ sessionId: 'x', projectPath: '/px', bg: true }], liveIds: [] });
  t.after(() => h.dom.window.close());
  const timers = new Map();
  let clock = 0, serial = 0, release;
  const schedule = h.dom.window.setTimeout.bind(h.dom.window);
  h.dom.window.setTimeout = (fn, ms) => {
    if (ms < 1000) return schedule(fn, 0);
    const id = ++serial; timers.set(id, { fn, at: clock + ms }); return id;
  };
  h.dom.window.clearTimeout = id => timers.delete(id);
  const tick = ms => {
    clock += ms;
    for (const [id, timer] of timers) if (timer.at <= clock) { timers.delete(id); timer.fn(); }
  };
  h.dom.window.api.restoreBackgroundJob = () => new Promise(resolve => { release = resolve; });
  h.dom.window.api.getSessionLiveElsewhere = async () => ({ kind: 'bg', jobId: '1234abcd', cwd: '/px' });
  const done = h.restore();
  await new Promise(resolve => setImmediate(resolve));
  tick(80000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.dom.window.document.querySelector('#app-notices').children.length, 0, 'M2 watchdog must cover main recovery bounds');
  if (late) { tick(120000); await done; }
  release({ action: 'attach', sessionId: 'x', jobId: '1234abcd' });
  await done;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.openTerminalCalls, late ? [] : ['x'], 'late completion cannot open another tab');
});

test('NIT removing group members recomputes severity and the one error action', async t => {
  const h = setup({ savedSet: ['a', 'b', 'c'].map(sessionId => ({ sessionId, projectPath: '/p', bg: true })), liveIds: [] });
  t.after(() => h.dom.window.close());
  h.dom.window.api.restoreBackgroundJob = async id => id === 'c'
    ? { action: 'retire', reason: 'ended queue' }
    : { action: 'refuse', jobId: '1234abcd', reason: 'stopped', recovery: 'respawn' };
  await h.restore();
  vm.runInContext("clearAppNotice('Restore:local:a')", h.ctx);
  let notice = h.dom.window.document.querySelector('.app-notice');
  assert.equal(notice.querySelector('.app-notice-action')?.textContent, 'Respawn', 'one error keeps its action alongside retired info');
  vm.runInContext("clearAppNotice('Restore:local:b')", h.ctx);
  notice = h.dom.window.document.querySelector('.app-notice');
  assert.equal(notice.getAttribute('role'), 'status', 'info-only group changes role');
  assert.equal(notice.querySelector('.app-notice-action'), null);
});

test('1191 ended background job releases its saved slots with an informational member', async t => {
  const h = setup({ savedSet: [{ sessionId: 'x', projectPath: '/px', bg: true, attachJobId: '1234abcd' }], liveIds: [] });
  t.after(() => h.dom.window.close());
  h.dom.window.api.restoreBackgroundJob = async () => ({ action: 'retire', jobId: '1234abcd', reason: 'The background session ended; its queued tasks can no longer run' });
  await h.restore();
  await h.persist();
  const notice = h.dom.window.document.querySelector('#app-notices .app-notice');
  assert.ok(notice, 'ended job is reported once');
  assert.equal(notice.getAttribute('role'), 'status');
  assert.match(notice.textContent, /name-x.*\/px.*1234abcd.*ended/);
  assert.deepEqual(h.settings.global.openWorkingSet, []);
  assert.deepEqual(h.openTerminalCalls, []);
});

test('M-A background attachment leaves the cold-cache planner able to restore a later batch', async t => {
  const savedSet = [{ sessionId: 'x', projectPath: '/px', bg: true }, { sessionId: 'a', projectPath: '/pa' }];
  const h = setup({ savedSet, liveIds: [] });
  t.after(() => h.dom.window.close());
  h.dom.window.api.getSessionLiveElsewhere = async () => ({ kind: 'bg', jobId: '1234abcd', cwd: '/px' });
  vm.runInContext(read('restore-plan.js'), h.ctx);
  loadAppFunctions(h.ctx, { functions: ['tickRestorePlanner'] });
  h.ctx.savedSet = savedSet;
  vm.runInContext('restoreMode = "auto"; sessionMap.delete("a"); restorePlanner = createRestorePlanner({ savedSet });', h.ctx);
  await vm.runInContext('tickRestorePlanner()', h.ctx);
  assert.deepEqual(h.openTerminalCalls, ['x']);
  assert.equal(vm.runInContext('sessionOpenedOutsideRestore', h.ctx), false, 'restore attach must not cancel the planner');
  vm.runInContext('sessionMap.set("a", { sessionId: "a", projectPath: "/pa" });', h.ctx);
  await vm.runInContext('tickRestorePlanner()', h.ctx);
  assert.deepEqual(h.openTerminalCalls, ['x', 'a']);
  await h.persist();
  assert.deepEqual(h.settings.global.openWorkingSet.map(item => item.sessionId), ['x', 'a']);
});

test('M-A GUARD a user click during background preparation keeps automatic planning', async t => {
  const h = setup({ savedSet: [{ sessionId: 'x', projectPath: '/px', bg: true }], liveIds: [] });
  t.after(() => h.dom.window.close());
  let release;
  h.dom.window.api.restoreBackgroundJob = () => new Promise(resolve => { release = resolve; });
  const restoring = h.restore();
  try {
    await new Promise(resolve => setImmediate(resolve));
    await vm.runInContext('openSession({ sessionId: "manual", projectPath: "/manual" })', h.ctx);
    assert.equal(vm.runInContext('sessionOpenedOutsideRestore', h.ctx), false, 'all opens during the background drain remain exempt');
  } finally {
    release({ action: 'refuse', reason: 'unknown' });
    await restoring;
  }
});

test('S1e MAJOR a user click during an interactive batch preserves later indexed saved tabs', async t => {
  const savedSet = ['a', 'b'].map(sessionId => ({ sessionId, projectPath: '/p' }));
  const h = setup({ savedSet, liveIds: [] });
  t.after(() => h.dom.window.close());
  vm.runInContext(read('restore-plan.js'), h.ctx);
  loadAppFunctions(h.ctx, { functions: ['tickRestorePlanner'] });
  h.ctx.savedSet = savedSet;
  vm.runInContext('restoreMode = "auto"; sessionMap.delete("b"); restorePlanner = createRestorePlanner({ savedSet });', h.ctx);
  let release;
  h.dom.window.api.openTerminal = id => {
    h.openTerminalCalls.push(id);
    return id === 'a' ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ ok: true });
  };
  const first = vm.runInContext('tickRestorePlanner()', h.ctx);
  await new Promise(resolve => setImmediate(resolve));
  try {
    assert.equal(typeof release, 'function');
    await vm.runInContext('openSession({ sessionId: "manual", projectPath: "/manual" })', h.ctx);
  } finally {
    release?.({ ok: true });
    await first;
  }
  vm.runInContext('sessionMap.set("b", { sessionId: "b", projectPath: "/p" });', h.ctx);
  await vm.runInContext('tickRestorePlanner()', h.ctx);
  assert.deepEqual(h.openTerminalCalls, ['a', 'manual', 'b']);
  await h.persist();
  assert.deepEqual(h.settings.global.openWorkingSet.map(item => item.sessionId), ['a', 'manual', 'b']);
  await vm.runInContext('openSession({ sessionId: "outside", projectPath: "/outside" })', h.ctx);
  assert.equal(vm.runInContext('sessionOpenedOutsideRestore', h.ctx), true, 'outside opens still cancel the planner');
});

test('S1e ticks defer overlapping batches without resuming saves inside the next interactive batch', async t => {
  const savedSet = [{ sessionId: 'x', projectPath: '/p', bg: true }, { sessionId: 'a', projectPath: '/p' }];
  const h = setup({ savedSet, liveIds: [] });
  t.after(() => h.dom.window.close());
  vm.runInContext(read('restore-plan.js'), h.ctx);
  loadAppFunctions(h.ctx, { functions: ['tickRestorePlanner'] });
  loadAppFunctions(h.ctx, { functions: ['schedulePersistWorkingSet'], declarations: ['savedWorkingSetRead', 'persistWorkingSetTimer'] });
  vm.runInContext('savedWorkingSetRead = true;', h.ctx);
  h.ctx.savedSet = savedSet;
  vm.runInContext('restoreMode = "auto"; sessionMap.delete("a"); restorePlanner = createRestorePlanner({ savedSet });', h.ctx);
  let releaseBg, releaseInteractive;
  h.dom.window.api.restoreBackgroundJob = () => new Promise(resolve => { releaseBg = resolve; });
  h.dom.window.api.getSessionLiveElsewhere = async id => id === 'x' ? { kind: 'bg', jobId: '1234abcd', cwd: '/p' } : null;
  h.dom.window.api.openTerminal = id => {
    h.openTerminalCalls.push(id);
    return id === 'a' ? new Promise(resolve => { releaseInteractive = resolve; }) : Promise.resolve({ ok: true });
  };
  const writes = [];
  const setSetting = h.dom.window.api.setSetting;
  h.dom.window.api.setSetting = async (key, value) => { writes.push(value.openWorkingSet.map(item => item.sessionId)); await setSetting(key, value); };
  const first = vm.runInContext('tickRestorePlanner()', h.ctx);
  await new Promise(resolve => setImmediate(resolve));
  vm.runInContext('sessionMap.set("a", { sessionId: "a", projectPath: "/p" });', h.ctx);
  const second = vm.runInContext('tickRestorePlanner()', h.ctx);
  await new Promise(resolve => setImmediate(resolve));
  releaseBg({ action: 'attach', sessionId: 'x', jobId: '1234abcd' });
  await new Promise(resolve => setTimeout(resolve, 20));
  const suspended = vm.runInContext('restoringWorkingSet', h.ctx);
  await vm.runInContext('_persistChain', h.ctx);
  const before = writes.length;
  vm.runInContext('clearTimeout(persistWorkingSetTimer); persistWorkingSetTimer = null; schedulePersistWorkingSet();', h.ctx);
  const timerArmed = vm.runInContext('persistWorkingSetTimer !== null', h.ctx);
  await new Promise(resolve => setImmediate(resolve));
  const after = writes.length;
  const startedSecond = typeof releaseInteractive === 'function';
  releaseInteractive?.({ ok: true });
  await Promise.all([first, second]);
  assert.equal(startedSecond, true, 'queued batch starts after the background drain');
  assert.equal(suspended, true, 'first tick cannot resume saves inside batch two');
  assert.equal(timerArmed, false, 'suspended saves cannot arm a persistence timer');
  assert.equal(after, before, 'persist remains suspended while batch two is opening');
  await h.persist();
  assert.equal(vm.runInContext('JSON.stringify([...openSessions.keys()])', h.ctx), '["x","a"]');
  assert.deepEqual(h.settings.global.openWorkingSet.map(item => item.sessionId), ['x', 'a']);
});

test('S1e continuation indexing retry starts before an unrelated background drain completes', async t => {
  const h = setup({ savedSet: [{ sessionId: 'x', projectPath: '/p', bg: true }, { sessionId: 'a', projectPath: '/p' }], liveIds: [] });
  t.after(() => h.dom.window.close());
  let release;
  h.dom.window.api.restoreBackgroundJob = () => new Promise(resolve => { release = resolve; });
  h.dom.window.api.getSessionContinuations = async () => {
    vm.runInContext('restoreIndexingDone = true;', h.ctx);
    return { candidates: [], unresolved: true };
  };
  vm.runInContext('var retries = 0; async function markRestoreIndexingDone() { retries++; }', h.ctx);
  const restoring = h.restore();
  await new Promise(resolve => setImmediate(resolve));
  vm.runInContext('restoreIndexingDone = true;', h.ctx);
  await new Promise(resolve => setTimeout(resolve, 20));
  const retriesBeforeDrain = vm.runInContext('retries', h.ctx);
  release({ action: 'refuse', reason: 'unknown' });
  await restoring;
  assert.equal(retriesBeforeDrain, 1, 'indexing retry is independent of background descriptor wait');
});

test('S1e GUARD a click outside any restore run cancels later automatic batches', async t => {
  const savedSet = ['a', 'b'].map(sessionId => ({ sessionId, projectPath: '/p' }));
  const h = setup({ savedSet, liveIds: [] });
  t.after(() => h.dom.window.close());
  vm.runInContext(read('restore-plan.js'), h.ctx);
  loadAppFunctions(h.ctx, { functions: ['tickRestorePlanner'] });
  h.ctx.savedSet = savedSet;
  vm.runInContext('restoreMode = "auto"; sessionMap.delete("b"); restorePlanner = createRestorePlanner({ savedSet });', h.ctx);
  await vm.runInContext('tickRestorePlanner()', h.ctx);
  await vm.runInContext('openSession({ sessionId: "manual", projectPath: "/manual" })', h.ctx);
  vm.runInContext('sessionMap.set("b", { sessionId: "b", projectPath: "/p" });', h.ctx);
  await vm.runInContext('tickRestorePlanner()', h.ctx);
  assert.deepEqual(h.openTerminalCalls, ['a', 'manual']);
  assert.equal(vm.runInContext('restorePlanner.isSettled()', h.ctx), true);
});

test('S1e GUARD overlapping restore runs retain the exemption until the final drain ends', async t => {
  const savedSet = ['x', 'y'].map(sessionId => ({ sessionId, projectPath: '/p', bg: true }));
  const h = setup({ savedSet, liveIds: [] });
  t.after(() => h.dom.window.close());
  const releases = new Map();
  h.dom.window.api.restoreBackgroundJob = id => new Promise(resolve => releases.set(id, resolve));
  const first = vm.runInContext('runRestore([{ sessionId: "x", projectPath: "/p", bg: true }])', h.ctx);
  const second = vm.runInContext('runRestore([{ sessionId: "y", projectPath: "/p", bg: true }])', h.ctx);
  await new Promise(resolve => setImmediate(resolve));
  releases.get('x')({ action: 'refuse', reason: 'unknown' });
  await first;
  try {
    await vm.runInContext('openSession({ sessionId: "manual", projectPath: "/manual" })', h.ctx);
    assert.equal(vm.runInContext('sessionOpenedOutsideRestore', h.ctx), false, 'a peer drain still exempts the click');
  } finally {
    releases.get('y')({ action: 'refuse', reason: 'unknown' });
    await second;
  }
  await vm.runInContext('openSession({ sessionId: "outside", projectPath: "/outside" })', h.ctx);
  assert.equal(vm.runInContext('sessionOpenedOutsideRestore', h.ctx), true);
});

for (const first of ['x', 'y']) {
  test(`m-1 a later background batch preserves saved order and unsaved tab positions after ${first}`, async t => {
    const savedSet = ['x', 'y'].map(sessionId => ({ sessionId, projectPath: '/p', bg: true }));
    const h = setup({ savedSet, liveIds: [] });
    t.after(() => h.dom.window.close());
    h.dom.window.api.restoreBackgroundJob = async sessionId => ({ action: 'attach', sessionId, jobId: '1234abcd' });
    h.dom.window.api.getSessionLiveElsewhere = async id => id === 'manual' ? null : { kind: 'bg', jobId: '1234abcd', cwd: '/p' };
    h.ctx.first = first;
    await vm.runInContext('runRestore([{ sessionId: first, projectPath: "/p", bg: true }])', h.ctx);
    await vm.runInContext('openSession({ sessionId: "manual", projectPath: "/manual" })', h.ctx);
    await vm.runInContext('runRestore([{ sessionId: first === "x" ? "y" : "x", projectPath: "/p", bg: true }])', h.ctx);
    assert.equal(vm.runInContext('JSON.stringify([...openSessions.keys()])', h.ctx), '["x","manual","y"]');
    await h.persist();
    assert.deepEqual(h.settings.global.openWorkingSet.map(item => item.sessionId), ['x', 'manual', 'y']);
  });
}

test('m-2 a rejected background task still waits for peers, reports failure and completes the batch', async t => {
  const savedSet = [{ sessionId: 'x', projectPath: '/p', bg: true },
    { sessionId: 'y', projectPath: '/p', bg: true, active: true }, { sessionId: 'a', projectPath: '/p' }];
  const h = setup({ savedSet, liveIds: [] });
  t.after(() => h.dom.window.close());
  let release;
  h.dom.window.api.restoreBackgroundJob = sessionId => sessionId === 'y'
    ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ action: 'attach', sessionId, jobId: '1234abcd' });
  h.dom.window.api.getSessionLiveElsewhere = async () => ({ kind: 'bg', jobId: '1234abcd', cwd: '/p' });
  h.dom.window.api.getSessionContinuations = async () => ({ candidates: [], unresolved: true });
  vm.runInContext(`
    var realCreateTerminalEntry = createTerminalEntry;
    createTerminalEntry = session => { if (session.sessionId === 'x') throw new Error('entry creation failed'); return realCreateTerminalEntry(session); };
    var indexingRetries = 0;
    async function markRestoreIndexingDone() { indexingRetries++; }
  `, h.ctx);
  let settled = false;
  const restoring = h.restore().then(() => ({ ok: true }), error => ({ error })).then(result => { settled = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  const settledBeforePeer = settled;
  const failureBeforePeer = h.dom.window.document.querySelector('[data-notice-id="Restore:local:x"]')?.textContent || '';
  vm.runInContext('restoreIndexingDone = true;', h.ctx);
  release({ action: 'attach', sessionId: 'y', jobId: '1234abcd' });
  const result = await restoring;
  assert.equal(settledBeforePeer, false, 'one failure cannot finish the batch ahead of its peers');
  assert.equal(result.ok, true, result.error?.message);
  assert.match(failureBeforePeer, /entry creation failed/, 'failure is reported while a peer is still pending');
  assert.deepEqual(h.openTerminalCalls, ['y']);
  assert.equal(vm.runInContext('activeSessionId', h.ctx), 'y');
  assert.equal(vm.runInContext('indexingRetries', h.ctx), 1);
  assert.match(h.dom.window.document.querySelector('[data-notice-id="Restore:local:x"]').textContent, /entry creation failed/);
  assert.ok(h.dom.window.document.querySelector('[data-notice-id="Restore:batch"]'), 'continuation notice still runs');
});

test('m-2 an interactive exception still drains an outstanding background attachment', async t => {
  const h = setup({ savedSet: [{ sessionId: 'x', projectPath: '/p', bg: true },
    { sessionId: 'a', projectPath: '/p' }], liveIds: [] });
  t.after(() => h.dom.window.close());
  let release;
  h.dom.window.api.restoreBackgroundJob = () => new Promise(resolve => { release = resolve; });
  h.dom.window.api.getSessionLiveElsewhere = async () => ({ kind: 'bg', jobId: '1234abcd', cwd: '/p' });
  vm.runInContext(`
    resolveResumeSession = async () => { throw new Error('interactive failure'); };
  `, h.ctx);
  let settled = false;
  const restoring = h.restore().then(() => ({ ok: true }), error => ({ error })).then(result => { settled = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  const settledBeforeBackground = settled;
  release({ action: 'attach', sessionId: 'x', jobId: '1234abcd' });
  const result = await restoring;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settledBeforeBackground, false, 'interactive failure still waits for background cleanup');
  assert.match(result.error?.message, /interactive failure/);
  assert.equal(vm.runInContext('restoreInFlight.size', h.ctx), 0);
  assert.equal(vm.runInContext('restoreRunDepth', h.ctx), 0, 'an exception releases the run exemption');
  assert.deepEqual(h.openTerminalCalls, ['x']);
});

test('s-1 GUARD a different attach job verdict cannot satisfy a background restore', async t => {
  const h = setup({ savedSet: [], liveIds: [] });
  t.after(() => h.dom.window.close());
  const opened = await vm.runInContext(`openSession({ sessionId: 'x', projectPath: '/px' }, undefined,
    { automatic: true, continuationResolved: true, allowBgAttach: true, backgroundRestoreJobId: '1234abcd',
      live: { kind: 'bg', jobId: 'abcd1234', cwd: '/px' } })`, h.ctx);
  assert.equal(opened, false);
  assert.deepEqual(h.openTerminalCalls, []);
  assert.match(h.dom.window.document.querySelector('.app-notice-message').textContent, /1234abcd.*no longer has an attachable/);
});

test('C3 a pending background restore does not block a later interactive tab or saves', async t => {
  const savedSet = [{ sessionId: 'x', projectPath: '/px', bg: true, attachJobId: '1234abcd' },
    { sessionId: 'a', projectPath: '/pa' }];
  const h = setup({ savedSet, liveIds: [] });
  t.after(() => h.dom.window.close());
  let release;
  h.dom.window.api.restoreBackgroundJob = () => new Promise(resolve => { release = resolve; });
  const restoring = h.restore();
  try {
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.deepEqual(h.openTerminalCalls, ['a'], 'interactive open is independent of background IPC');
    assert.equal(vm.runInContext('restoringWorkingSet', h.ctx), false, 'background IPC does not suspend saves');
    vm.runInContext('openSessions.set("manual", { session: { projectPath: "/manual" } });', h.ctx);
    await h.persist();
    assert.deepEqual(h.settings.global.openWorkingSet.map(item => item.sessionId), ['x', 'a', 'manual']);
    assert.equal(h.settings.global.openWorkingSet[0].attachJobId, '1234abcd');
  } finally {
    release({ action: 'refuse', reason: 'unknown' });
    await restoring;
  }
});

test('C3 background preparations overlap and completed tabs retain saved order', async t => {
  const savedSet = ['x', 'y'].map(sessionId => ({ sessionId, projectPath: '/p', bg: true, attachJobId: '1234abcd' }));
  const h = setup({ savedSet, liveIds: [] });
  t.after(() => h.dom.window.close());
  const calls = [], releases = new Map();
  h.dom.window.api.restoreBackgroundJob = id => {
    calls.push(id);
    return new Promise(resolve => releases.set(id, resolve));
  };
  h.dom.window.api.getSessionLiveElsewhere = async () => ({ kind: 'bg', jobId: '1234abcd', cwd: '/p' });
  const restoring = h.restore();
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['x', 'y'], 'both IPCs begin before either resolves');
    releases.get('y')({ action: 'attach', sessionId: 'y', jobId: '1234abcd' });
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    releases.get('x')?.({ action: 'attach', sessionId: 'x', jobId: '1234abcd' });
    await new Promise(resolve => setImmediate(resolve));
    releases.get('y')?.({ action: 'attach', sessionId: 'y', jobId: '1234abcd' });
    await restoring;
  }
  assert.deepEqual(vm.runInContext('JSON.stringify([...openSessions.keys()])', h.ctx), '["x","y"]');
});

for (const held of ['dormantWorkingSet', 'skippedWorkingSetEntries']) {
  test(`1065 M3 clicking a retired ${held} entry opens the conversation in the same click`, async t => {
    const item = { sessionId: 'x', projectPath: '/px', bg: true, attachJobId: '1234abcd' };
    const h = setup({ savedSet: [item], liveIds: [] });
    t.after(() => h.dom.window.close());
    h.ctx.item = item;
    vm.runInContext(`${held}.set('x', { item, index: 0 });`, h.ctx);
    let restores = 0;
    h.dom.window.api.restoreBackgroundJob = async () => { restores++; return { action: 'retire', jobId: '1234abcd' }; };
    await vm.runInContext('openSession(sessionMap.get("x"))', h.ctx);
    assert.deepEqual(h.openTerminalCalls, ['x'], 'retired background conversation must open on the first user click');
    assert.equal(restores, 1);
    assert.equal(vm.runInContext('skippedWorkingSetEntries.has("x") || dormantWorkingSet.has("x")', h.ctx), false);
    assert.equal(h.dom.window.document.querySelector('.app-notice'), null);
    await h.persist();
    assert.equal(h.settings.global.openWorkingSet[0].bg, undefined);
  });
}

test('1065 retired background entry disappears silently and stays absent on the next restart', async t => {
  const item = { sessionId: 'x', projectPath: '/px', bg: true, attachJobId: '1234abcd' };
  const h = setup({ savedSet: [item], liveIds: [] });
  t.after(() => h.dom.window.close());
  h.dom.window.api.restoreBackgroundJob = async () => ({ action: 'retire', jobId: '1234abcd' });
  await h.restore();
  assert.equal(h.dom.window.document.querySelector('.app-notice'), null, 'finished job must not show a failure notice');
  assert.deepEqual(h.openTerminalCalls, []);
  await h.persist();
  assert.deepEqual(h.settings.global.openWorkingSet, [], 'finished job must leave the saved working set');
  const next = setup({ savedSet: h.settings.global.openWorkingSet, liveIds: [] });
  t.after(() => next.dom.window.close());
  next.dom.window.api.restoreBackgroundJob = async () => assert.fail('retired job retried on next restart');
  await next.restore();
  assert.equal(next.dom.window.document.querySelector('.app-notice'), null);
});

for (const missing of [true, false]) {
  test(`C4 ${missing ? 'missing job releases the slot for a guarded later click' : 'GUARD ambiguous job stays held'}`, async t => {
    const h = setup({ savedSet: [{ sessionId: 'x', projectPath: '/px', bg: true }], liveIds: [] });
    t.after(() => h.dom.window.close());
    h.dom.window.api.restoreBackgroundJob = async () => ({ action: 'refuse',
      reason: missing ? 'no background job record for x' : 'multiple background job records for x: aaaaaaaa, bbbbbbbb',
      ...(missing ? { missing: true } : {}) });
    await h.restore();
    assert.equal(vm.runInContext('skippedWorkingSetEntries.has("x")', h.ctx), !missing);
    await h.persist();
    assert.equal(h.settings.global.openWorkingSet.some(item => item.bg), !missing);
    if (missing) {
      assert.match(h.dom.window.document.querySelector('.app-notice-message').textContent, /background job no longer exists/i);
      let checked = 0;
      h.dom.window.api.getSessionLiveElsewhere = async () => { checked++; return LIVE; };
      h.dom.window.appConfirm = async () => false;
      await vm.runInContext('openSession(sessionMap.get("x"))', h.ctx);
      assert.equal(checked, 1, 'later click goes through live-elsewhere guard');
      assert.deepEqual(h.openTerminalCalls, []);
      h.dom.window.api.getSessionLiveElsewhere = async () => null;
      await vm.runInContext('openSession(sessionMap.get("x"))', h.ctx);
      assert.deepEqual(h.openTerminalCalls, ['x']);
    }
  });
}

test('a session live elsewhere is not resumed, and survives in the persisted working set at its place', async () => {
  const h = setup({ savedSet: SAVED, liveIds: ['x'] });
  await h.restore();
  assert.deepEqual(h.openTerminalCalls, ['b', 'a'], 'no open-terminal for the live session; the active session opens first');

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
  assert.deepEqual(h.openTerminalCalls, ['b', 'a', 'x']);
  assert.equal(h.dom.window.document.querySelector('[data-notice-id="Restore:batch"]'), null);
  h.dom.window.close();
});

test('once the user opens the skipped session and closes it, it leaves the working set like any other', async () => {
  const h = setup({ savedSet: SAVED, liveIds: ['x'] });
  await h.restore();
  h.dom.window.appConfirm = async () => true;
  await vm.runInContext('openSession(sessionMap.get("x"))', h.ctx);
  assert.deepEqual(h.openTerminalCalls, ['b', 'a', 'x']);
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
    h.dom.window.api.getSessionLiveElsewhere = async () => ({ ...LIVE, kind: 'bg', jobId: '1234abcd' });
    await h.restore();
    const notice = h.dom.window.document.querySelector('[data-notice-id="Restore:background"]');
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
    assert.deepEqual(h.openTerminalCalls, ['b', 'a']);
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

const UNREADABLE_1277 = 'cannot identify background job for x: job 1234abcd has an unknown or unreadable state';
for (const settles of [true, false]) {
  test(`1277 a job state unreadable after a respawn is retried attach-only; readable on the third attempt=${settles}`, async t => {
    const h = setup({ savedSet: [{ sessionId: 'x', projectPath: '/px', bg: true, attachJobId: '1234abcd' }], liveIds: [] });
    t.after(() => h.dom.window.close());
    const calls = [], logs = [];
    const schedule = h.dom.window.setTimeout.bind(h.dom.window);
    h.dom.window.setTimeout = (fn, ms) => schedule(fn, ms === 1000 ? 0 : ms);
    h.dom.window.console.warn = message => logs.push(message);
    h.dom.window.api.bgAgentVerb = async () => assert.fail('automatic retries must never respawn');
    h.dom.window.api.restoreBackgroundJob = async (id, options) => {
      calls.push(options?.attachOnly === true);
      if (calls.length === 1) return { action: 'respawned-not-attached', jobId: '1234abcd' };
      if (settles && calls.length === 3) return { action: 'attach', sessionId: id, jobId: '1234abcd' };
      return { action: 'refuse', reason: UNREADABLE_1277, stateFile: 'transitional-state' };
    };
    h.dom.window.api.getSessionLiveElsewhere = async () => ({ kind: 'bg', jobId: '1234abcd', cwd: '/px' });
    await h.restore();
    assert.deepEqual(calls, [false, true, true], 'one respawning attempt, then attach-only retries');
    assert.equal(calls.filter(attachOnly => !attachOnly).length, 1, 'exactly one attempt may respawn');
    const notices = h.dom.window.document.querySelector('#app-notices');
    if (settles) {
      assert.equal(vm.runInContext('openSessions.get("x")?.attach', h.ctx), true, 'the background session is attached');
      assert.equal(notices.children.length, 0);
      assert.deepEqual(logs, []);
    } else {
      assert.equal(vm.runInContext('openSessions.has("x")', h.ctx), false, 'no foreground fallback');
      assert.equal(notices.children.length, 1, 'one refusal');
      assert.match(notices.textContent, /unknown or unreadable state/);
      assert.equal(logs.length, 1);
      assert.match(logs[0], /\[restore-bg\] session=x job=1234abcd outcome=refuse attempts=3 stateFile=transitional-state$/);
    }
  });
}

test('1277 an unreadable state on the first attempt is retried attach-only and logged by kind only', async t => {
  const h = setup({ savedSet: [{ sessionId: 'x', projectPath: '/px', bg: true, attachJobId: '1234abcd' }], liveIds: [] });
  t.after(() => h.dom.window.close());
  const calls = [], logs = [];
  const schedule = h.dom.window.setTimeout.bind(h.dom.window);
  h.dom.window.setTimeout = (fn, ms) => schedule(fn, ms === 1000 ? 0 : ms);
  h.dom.window.console.warn = message => logs.push(message);
  h.dom.window.api.restoreBackgroundJob = async (_id, options) => {
    calls.push(options?.attachOnly === true);
    return { action: 'refuse', reason: 'cannot identify background job for x: Unexpected token S in "SECRET" JSON', stateFile: 'unparsable' };
  };
  await h.restore();
  assert.deepEqual(calls, [false, true, true]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /outcome=refuse attempts=3 stateFile=unparsable$/);
  assert.doesNotMatch(logs[0], /SECRET/);

});

test('1277 GUARD a refusal that names no state file fault is not retried and logs no stateFile', async t => {
  const h = setup({ savedSet: [{ sessionId: 'x', projectPath: '/px', bg: true, attachJobId: '1234abcd' }], liveIds: [] });
  t.after(() => h.dom.window.close());
  const calls = [], logs = [];
  h.dom.window.console.warn = message => logs.push(message);
  h.dom.window.api.restoreBackgroundJob = async (_id, options) => {
    calls.push(options?.attachOnly === true);
    return { action: 'refuse', jobId: '1234abcd', reason: 'job 1234abcd does not match saved session x', stateFile: 'id-mismatch' };
  };
  await h.restore();
  assert.deepEqual(calls, [false]);
  assert.match(logs[0], /attempts=1 stateFile=id-mismatch$/);
});
