// A restored session whose CLI never connects to its IDE bridge (#776).
//
// The shipped runRestore, openSession, applyProcessExit and
// restartSessionWithoutCli are cut out of public/app.js and run in a jsdom
// window next to the real public/cli-liveness.js; only their collaborators
// outside the restore and restart paths are stubbed.

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

function declarations(names) {
  return names
    .map((name) => (APP_SRC.match(new RegExp(`^(?:const|let) ${name} = .*;$`, 'm')) || [])[0])
    .filter(Boolean)
    .join('\n')
    .replace(/^const /gm, 'var ').replace(/^let /gm, 'var ');
}

function setup({ savedSet = [], mcpState = 'listening' } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' });
  const ctx = dom.getInternalVMContext();
  const notices = dom.window.document.createElement('div');
  notices.id = 'app-notices';
  dom.window.document.body.append(notices);
  vm.runInContext(read('modal-stack.js'), ctx, { filename: path.join(__dirname, '../public/modal-stack.js') });
  vm.runInContext(read('app-notices.js'), ctx, { filename: path.join(__dirname, '../public/app-notices.js') });
  vm.runInContext(read('cli-liveness.js'), ctx, { filename: path.join(__dirname, '../public/cli-liveness.js') });
  const settings = { global: { restoreOnStartup: 'auto', openWorkingSet: savedSet } };
  const calls = [];
  const input = { value: { ok: true, pending: false } };
  const live = { value: null };
  dom.window.api = {
    getSessionContinuations: async () => ({ candidates: [], unresolved: false, continued: false }),
    getSetting: async (key) => JSON.parse(JSON.stringify(settings[key] || null)),
    setSetting: async (key, value) => { settings[key] = JSON.parse(JSON.stringify(value)); },
    getSessionLiveElsewhere: async (id) => { calls.push(['live', id]); if (live.value instanceof Error) throw live.value; return live.value; },
    getSessionsLiveElsewhere: async () => ({}),
    getSessionInputPending: async (id) => { calls.push(['input', id]); if (input.value instanceof Error) throw input.value; return input.value; },
    stopSession: async (id) => {
      calls.push(['stop', id]);
      if (stopExits.value) setTimeout(() => vm.runInContext(`applyProcessExit(${JSON.stringify(id)}, null, null, true)`, ctx), 0);
      return { ok: true };
    },
    openTerminal: async (sessionId) => {
      calls.push(['open', sessionId, vm.runInContext(`cliLiveness.status(${JSON.stringify(sessionId)}).noCli`, ctx)]);
      vm.runInContext(`activePtyIds.add(${JSON.stringify(sessionId)})`, ctx);
      return { ok: true, mcpState };
    },
  };
  const stopExits = { value: true };
  dom.window.appConfirm = async () => { throw new Error('an automatic resume must never prompt'); };
  dom.window.appAlert = async () => { throw new Error('an automatic resume must never alert'); };
  vm.runInContext(read('utils.js'), ctx);
  vm.runInContext(read('resume-guard.js'), ctx, { filename: path.join(__dirname, '..', 'public', 'resume-guard.js') });
  vm.runInContext(`
    var openSessions = new Map();
    var pendingSessions = new Map();
    var sessionMap = new Map();
    var localMergedMemberRows = new Map();
    var localPtyStates = new Map();
    var filePanelState = new Map();
    var activePtyIds = new Set();
    var activeSessionId = null;
    var gridViewActive = false;
    var restoringWorkingSet = false;
    var restoreRunDepth = 0;
    var restorePlanner = null;
    var sessionOpenedOutsideRestore = false;
    var _persistChain = Promise.resolve();
    var exitingApp = false;
    var RESTORE_STAGGER_MS = 0;
    var LIVE_ELSEWHERE_NOTICE_MS = 60000;
    var timers = [];
    var clock = 0;
    var cliLiveness = createCliLiveness({
      setTimer: (fn, ms) => { const t = { fn, at: clock + ms }; timers.push(t); return t; },
      clearTimer: t => { timers = timers.filter(x => x !== t); },
      isOnline: () => true,
      restart: id => restartSessionWithoutCli(id),
    });
    function createTerminalEntry(session) {
      const entry = { session, closed: false, terminal: { write() {} }, initialSize: {} };
      openSessions.set(session.sessionId, entry);
      return entry;
    }
    function showSession(id) { activeSessionId = id; }
    function destroySession(id) { openSessions.delete(id); }
    async function resolveDefaultSessionOptions() { return {}; }
    function syncPtySizeAfterOpen() {}
    function setSessionMcpState(id, state) { cliLiveness.mcpState(id, state); }
    function setSessionSandboxed() {}
    function forgetSessionExit() {}
    function noteSessionExit() {}
    function lastSessionExit() { return null; }
    function writeSessionExitBanner() {}
    function dropLocalPtySession() {}
    function updateRunningIndicators() {}
    function beginPtyOpen() {}
    function settlePtyOpen() {}
    function schedulePersistWorkingSet() {}
    function pollActiveSessions() {}
    function sessionItemEl() { return null; }
  `, ctx);
  loadAppFunctions(ctx, {
    functions: ['rowSessionIds', 'rowHeadId', 'rowOpenId'], sourcePath: path.join(__dirname, '../public/session-activity-dom.js'),
  });
  vm.runInContext(declarations(['restoreMode', 'skippedWorkingSetEntries', 'restoreSavedIndex', 'restoreAwaitingConsent', 'restoreInFlight',
    'restoreIndexingDone', 'continuationRetryCancelled', 'openingSessions', 'dormantWorkingSet', 'CLI_RESTART_EXIT_WAIT_MS']), ctx);
  loadAppFunctions(ctx, { functions: ['persistWorkingSet', 'pendingRestoreEntries', 'runRestore', 'openSession', 'openSessionNow', 'clearDormantRow',
    'dormantRowIds', 'syncDormantRow', 'indexedRowOf', 'applyProcessExit',
    ...['restartSessionWithoutCli'].filter(name => APP_SRC.includes(`function ${name}(`))] });
  ctx.restoreSavedIndexFrom = savedSet;
  vm.runInContext('restoreSavedIndex = new Map(restoreSavedIndexFrom.map((item, index) => [item.sessionId, index]));', ctx);
  for (const item of savedSet) {
    vm.runInContext(`sessionMap.set(${JSON.stringify(item.sessionId)}, ${JSON.stringify({ sessionId: item.sessionId, projectPath: item.projectPath, name: `name-${item.sessionId}` })});`, ctx);
  }
  const restore = async () => {
    vm.runInContext('restoringWorkingSet = true;', ctx);
    await vm.runInContext(`runRestore(${JSON.stringify(savedSet)})`, ctx);
    vm.runInContext('restoringWorkingSet = false;', ctx);
  };
  const advance = async (ms) => {
    const until = ctx.clock + ms;
    for (;;) {
      const due = ctx.timers.filter(t => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      ctx.timers = ctx.timers.filter(x => x !== due);
      ctx.clock = due.at;
      due.fn();
      for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
    }
    ctx.clock = until;
  };
  const settleAll = async () => { for (let i = 0; i < 50; i++) await new Promise(resolve => setTimeout(resolve, 1)); };
  const noCli = (id) => vm.runInContext(`cliLiveness.isNoCli(${JSON.stringify(id)})`, ctx);
  const { CLI_LIVENESS_NO_CLI_MS: NO_CLI, CLI_LIVENESS_RESTART_TIMEOUT_MS: RESTART } = require('../public/cli-liveness');
  return { dom, ctx, calls, input, live, stopExits, restore, advance, settleAll, noCli, NO_CLI, RESTART };
}

const SAVED = [{ sessionId: 'a', projectPath: '/pa' }];

test('GIVEN a restored session whose bridge listens WHEN no CLI connects THEN restore reports it as having no CLI', async t => {
  const h = setup({ savedSet: SAVED });
  t.after(() => h.dom.window.close());
  await h.restore();
  await h.advance(h.NO_CLI - 1);
  assert.equal(h.noCli('a'), false);
  await h.advance(1);
  assert.equal(h.noCli('a'), true);
});

test('GIVEN a session opened by hand WHEN no CLI connects THEN it is never reported', async t => {
  const h = setup();
  t.after(() => h.dom.window.close());
  await vm.runInContext('openSession({ sessionId: "m", projectPath: "/pm" })', h.ctx);
  await h.advance(h.NO_CLI + h.RESTART);
  assert.equal(h.noCli('m'), false);
  assert.deepEqual(h.calls.filter(c => c[0] === 'stop'), []);
});

test('GIVEN a restored Codex session (no IDE bridge) WHEN nothing connects THEN it is never reported', async t => {
  const h = setup({ savedSet: SAVED, mcpState: 'off' });
  t.after(() => h.dom.window.close());
  await h.restore();
  await h.advance(h.NO_CLI + h.RESTART);
  assert.equal(h.noCli('a'), false);
});

test('GIVEN a restored session whose PTY exits before the delay THEN it is not reported', async t => {
  const h = setup({ savedSet: SAVED });
  t.after(() => h.dom.window.close());
  await h.restore();
  await h.advance(1000);
  vm.runInContext('applyProcessExit("a", 1, null, false)', h.ctx);
  await h.advance(h.NO_CLI + h.RESTART);
  assert.equal(h.noCli('a'), false);
  assert.deepEqual(h.calls.filter(c => c[0] === 'stop'), []);
});

test('GIVEN a restored session without CLI WHEN the restart fires THEN it is stopped, then reopened through openSession once', async t => {
  const h = setup({ savedSet: SAVED });
  t.after(() => h.dom.window.close());
  await h.restore();
  await h.advance(h.NO_CLI + h.RESTART);
  await h.settleAll();
  const steps = h.calls.filter(c => ['stop', 'open'].includes(c[0]));
  assert.deepEqual(steps, [['open', 'a', false], ['stop', 'a'], ['open', 'a', false]]);
  assert.equal(vm.runInContext('openSessions.get("a").closed', h.ctx), false);
  await h.advance(h.NO_CLI);
  assert.equal(h.noCli('a'), true, 'the restarted session is watched again');
  await h.advance(h.RESTART * 3);
  await h.settleAll();
  assert.equal(h.calls.filter(c => c[0] === 'stop').length, 1, 'never a second restart');
});

for (const [name, arrange] of [
  ['the prompt holds unsent input', h => { h.input.value = { ok: true, pending: true }; }],
  ['the unsent-input check cannot answer', h => { h.input.value = { ok: false }; }],
  ['the unsent-input check fails', h => { h.input.value = new Error('ipc down'); }],
  ['the session is live elsewhere', h => { h.live.value = { pid: 4242, cwd: '/elsewhere' }; }],
  ['the live-elsewhere check fails', h => { h.live.value = new Error('ipc down'); }],
  ['the session is busy', h => { vm.runInContext('localPtyStates.set("a", { snapshot: () => ({ busy: true }) })', h.ctx); }],
]) {
  test(`GIVEN a restored session without CLI WHEN ${name} THEN it is not restarted and keeps its no-CLI state`, async t => {
    const h = setup({ savedSet: SAVED });
    t.after(() => h.dom.window.close());
    await h.restore();
    arrange(h);
    await h.advance(h.NO_CLI + h.RESTART);
    await h.settleAll();
    assert.deepEqual(h.calls.filter(c => c[0] === 'stop'), []);
    assert.equal(h.noCli('a'), true);
    assert.equal(vm.runInContext('cliLiveness.status("a").restartPending', h.ctx), false);
  });
}

test('GIVEN a stop whose PTY never reports its exit WHEN the wait runs out THEN the session is not reopened', async t => {
  const h = setup({ savedSet: SAVED });
  t.after(() => h.dom.window.close());
  await h.restore();
  h.stopExits.value = false;
  vm.runInContext('CLI_RESTART_EXIT_WAIT_MS = 5', h.ctx);
  await h.advance(h.NO_CLI + h.RESTART);
  await h.settleAll();
  assert.deepEqual(h.calls.filter(c => ['stop', 'open'].includes(c[0])), [['open', 'a', false], ['stop', 'a']]);
  assert.equal(h.noCli('a'), true, 'the session keeps its no-CLI state');
});
