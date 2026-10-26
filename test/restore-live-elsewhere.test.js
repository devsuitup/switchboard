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
  loadAppFunctions(ctx, { functions: ['persistWorkingSet', 'pendingRestoreEntries', 'runRestore', 'openSession', 'openSessionNow', 'clearDormantRow', 'indexedRowOf',
    ...['prepareBackgroundRestore'].filter(name => APP_SRC.includes(`function ${name}(`))] });
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
      assert.equal(calls.length, 1, 'no openSession/openTerminal fallback');
      assert.equal(vm.runInContext('skippedWorkingSetEntries.has("x")', h.ctx), true);
      const notice = h.dom.window.document.querySelector('[data-notice-id="Restore:local:x"]');
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
    let first = true;
    h.dom.window.api.restoreBackgroundJob = async (id, options) => {
      calls.push(['restore', id, options]);
      if (first) { first = false; return recovery === 'attach' ? { action: 'respawned-not-attached', jobId: '1234abcd' }
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

test('M-A GUARD a user click during background preparation cancels automatic planning', async t => {
  const h = setup({ savedSet: [{ sessionId: 'x', projectPath: '/px', bg: true }], liveIds: [] });
  t.after(() => h.dom.window.close());
  let release;
  h.dom.window.api.restoreBackgroundJob = () => new Promise(resolve => { release = resolve; });
  const restoring = h.restore();
  try {
    await new Promise(resolve => setImmediate(resolve));
    vm.runInContext('restoringWorkingSet = true;', h.ctx);
    await vm.runInContext('openSession({ sessionId: "manual", projectPath: "/manual" })', h.ctx);
    assert.equal(vm.runInContext('sessionOpenedOutsideRestore', h.ctx), true, 'user intent counts while restore is running');
  } finally {
    release({ action: 'refuse', reason: 'unknown' });
    await restoring;
  }
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
    h.dom.window.api.getSessionLiveElsewhere = async () => ({ ...LIVE, kind: 'bg', jobId: '1234abcd' });
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
