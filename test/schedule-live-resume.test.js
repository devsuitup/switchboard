'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { JSDOM } = require('jsdom');
const { extractFunction, loadAppFunctions } = require('./app-source');
const cliSessionState = require('../cli-session-state');
const { buildScheduleCommand } = require('../schedule-runner');
const { guardResume } = require('../public/resume-guard');

const ROOT = path.join(__dirname, '..');
const SID = '39757294-494b-4918-b426-e0ff559e9324';
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

function setup(t, { sandbox = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i484-live-'));
  const children = [];
  const log = { info() {}, error() {}, warn() {}, debug() {} };
  cliSessionState.init({ dir, activeSessions: new Map(), log, readParentPid: () => process.pid });
  const handlers = new Map();
  const spawns = [];
  const done = [];
  const main = vm.createContext({
    cliSessionState,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    sessionHasPty: () => false,
    ptyPids: () => [],
    cpSpawn: (...args) => {
      spawns.push(args);
      const child = new EventEmitter();
      child.pid = 4242 + children.length;
      child.stderr = new EventEmitter();
      children.push(child);
      return child;
    },
    getSetting: () => ({}),
    SETTING_DEFAULTS: { shellProfile: 'test', sandbox: false },
    resolveShell: () => ({ path: 'fake-shell' }),
    quoteArgvForShell: (_shell, args) => args.join(' '),
    shellArgs: (_shell, cmd) => [cmd],
    cleanPtyEnv: {},
    resolveScheduleSandbox: () => sandbox,
    process: { platform: 'win32' },
    activityReporter: { sessionStarted() {}, sessionEnded() {} },
    log,
  });
  const source = read('main.js');
  vm.runInContext(extractFunction(source.replace(/^    function runScheduleCommand/m, 'function runScheduleCommand'), 'runScheduleCommand'), main);
  for (const channel of ['session-live-elsewhere', 'sessions-live-elsewhere']) {
    const line = source.split('\n').find((line) => line.includes(`ipcMain.handle('${channel}'`));
    assert.ok(line, `missing ${channel} handler`);
    vm.runInContext(line, main);
  }

  const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' });
  const ctx = dom.getInternalVMContext();
  const openTerminalCalls = [];
  const messages = [];
  const settings = { global: {} };
  const session = { sessionId: SID, projectPath: dir, name: 'Scheduled task' };
  dom.window.api = {
    getSessionContinuations: async () => ({ candidates: [], unresolved: false, continued: false }),
    getSessionLiveElsewhere: (id) => handlers.get('session-live-elsewhere')(null, id),
    getSessionsLiveElsewhere: (ids) => handlers.get('sessions-live-elsewhere')(null, ids),
    openTerminal: async (...args) => { openTerminalCalls.push(args); return { ok: true }; },
    getSetting: async (key) => settings[key],
    setSetting: async (key, value) => { settings[key] = value; },
  };
  dom.window.confirm = (message) => { messages.push(message); return true; };
  vm.runInContext(read('public/utils.js'), ctx);
  vm.runInContext(read('public/resume-guard.js'), ctx);
  vm.runInContext(`
    var openSessions = new Map();
    var sessionMap = new Map();
    var activeSessionId = null;
    var restoringWorkingSet = false;
    var restorePlanner = null;
    var sessionOpenedOutsideRestore = false;
    var _persistChain = Promise.resolve();
    var RESTORE_STAGGER_MS = 0;
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
  const app = loadAppFunctions(ctx, {
    functions: ['openSession', 'openSessionNow', 'runRestore', 'pendingRestoreEntries', 'persistWorkingSet', 'showRestoreNotice', 'showLiveElsewhereNotice'],
    declarations: ['LIVE_ELSEWHERE_NOTICE_MS', 'openingSessions', 'skippedWorkingSetEntries', 'restoreSavedIndex', 'restoreAwaitingConsent', 'restoreInFlight', 'restoreIndexingDone', 'continuationRetryCancelled', 'dormantWorkingSet', 'exitingApp', 'persistSkippedWhileExiting'],
  });
  ctx.sessionMap.set(SID, session);
  t.after(() => {
    for (const child of children) child.emit('exit', 0);
    cliSessionState.stop();
    dom.window.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    get child() { return children[0]; },
    spawns, done, messages, openTerminalCalls, session, ctx, settings,
    start: () => {
      const { claudeArgs } = buildScheduleCommand(SID, { name: 'Scheduled task', cli: {} });
      main.runScheduleCommand(claudeArgs, dir, 'Scheduled task', () => done.push(true));
      return children.at(-1);
    },
    open: (options) => app.openSession(session, undefined, options),
    query: (id = SID) => dom.window.api.getSessionLiveElsewhere(id),
    batch: (ids) => dom.window.api.getSessionsLiveElsewhere(ids),
    restore: async () => {
      ctx.restoringWorkingSet = true;
      await app.runRestore([{ sessionId: SID, projectPath: dir, active: true }]);
      await app.persistWorkingSet();
      ctx.restoringWorkingSet = false;
    },
  };
}

test('a click during a scheduled run refuses a second process even when the dialog is accepted', async (t) => {
  const h = setup(t);
  h.start();
  assert.equal(h.spawns.length, 1);
  await h.open();
  assert.equal(h.openTerminalCalls.length, 0, 'a live scheduled run must not spawn a second claude --resume');
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0], /scheduled.*running/i);
  h.child.emit('exit', 0);
  await h.open();
  assert.equal(h.openTerminalCalls.length, 1, 'the completed scheduled transcript becomes resumable');
  assert.equal(h.done.length, 1);
});

test('automatic reload during a scheduled run skips the resume without prompting', async (t) => {
  const h = setup(t);
  h.start();
  await h.open({ automatic: true });
  assert.equal(h.openTerminalCalls.length, 0, 'automatic reload must not fork the running transcript');
  assert.equal(h.messages.length, 0);
});

test('working-set restore skips the scheduled run and retains its saved entry', async (t) => {
  const h = setup(t);
  h.start();
  await h.restore();
  assert.equal(h.openTerminalCalls.length, 0, 'batch restore must not resume a live scheduled run');
  assert.equal(h.settings.global.openWorkingSet[0].sessionId, SID);
  assert.equal(h.settings.global.openWorkingSet[0].active, false);
  assert.equal(h.messages.length, 0);
});

test('a scheduled child without a CLI descriptor is visible under either session id case', async (t) => {
  const h = setup(t);
  h.start();
  assert.deepEqual(fs.readdirSync(h.session.projectPath), []);
  const live = await h.query(SID.toUpperCase());
  assert.equal(live?.kind, 'schedule');
  assert.equal(live.pid, h.child.pid);
  assert.equal(live.cwd, h.session.projectPath);
  assert.equal((await h.batch([SID.toUpperCase()]))[SID.toUpperCase()]?.kind, 'schedule');
  assert.equal(await h.query('unrelated'), null);
});

test('a spawn error clears the scheduled run so its session can be opened', async (t) => {
  const h = setup(t);
  h.start();
  assert.equal((await h.query())?.kind, 'schedule');
  h.child.emit('error', new Error('spawn failed'));
  assert.equal(await h.query(), null);
  await h.open();
  assert.equal(h.openTerminalCalls.length, 1);
  assert.equal(h.done.length, 1);
});

test('a replaced scheduled child exiting preserves the replacement until it exits', async (t) => {
  const h = setup(t);
  const first = h.start();
  assert.equal((await h.query())?.pid, first.pid);
  const replacement = h.start();
  assert.notEqual(first, replacement);
  assert.equal(h.spawns.length, 2);
  first.emit('exit', 0);
  const live = await h.query();
  assert.equal(live?.kind, 'schedule', 'the previous child exiting must not release the replacement');
  assert.equal(live.pid, replacement.pid);
  const batchLive = (await h.batch([SID.toUpperCase()]))[SID.toUpperCase()];
  assert.equal(batchLive?.kind, 'schedule');
  assert.equal(batchLive.pid, replacement.pid);
  replacement.emit('exit', 0);
  assert.equal(await h.query(), null);
  assert.equal((await h.batch([SID]))[SID], undefined);
  assert.equal(h.done.length, 2);
});

test('a refused scheduled spawn leaves no live run', async (t) => {
  const h = setup(t, { sandbox: true });
  h.start();
  assert.equal(h.spawns.length, 0);
  assert.equal(await h.query(), null);
  await h.open();
  assert.equal(h.openTerminalCalls.length, 1);
});

test('the schedule verdict never offers a resume override or a daemon attach', async () => {
  const messages = [];
  const result = await guardResume({ sessionId: SID }, {
    live: { kind: 'schedule', pid: 4242, cwd: '/scheduled' },
    confirm: (message) => { messages.push(message); return true; },
  });
  assert.equal(result, false);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /wait/i);
  assert.doesNotMatch(messages[0], /anyway/i);
});
