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
    scheduleIpc: require('../schedule-ipc'), mainWindow: null,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    sessionHasPty: () => false,
    ptyPids: () => [],
    cpSpawn: (...args) => {
      spawns.push(args);
      const child = new EventEmitter();
      child.pid = 4242 + children.length;
      child.stderr = new EventEmitter();
      children.push(child);
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    getSetting: () => ({}),
    isProjectSettingsArchived: () => false,
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
  vm.runInContext(extractFunction(source.replace(/^    (async )?function runScheduleCommand/m, '$1function runScheduleCommand'), 'runScheduleCommand'), main, { filename: path.join(ROOT, 'main.js') });
  for (const channel of ['session-live-elsewhere', 'sessions-live-elsewhere']) {
    const line = source.split('\n').find((line) => line.includes(`ipcMain.handle('${channel}'`));
    assert.ok(line, `missing ${channel} handler`);
    vm.runInContext(line, main, { filename: path.join(ROOT, 'main.js') });
  }

  const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' });
  const ctx = dom.getInternalVMContext();
  const notices = dom.window.document.createElement('div');
  notices.id = 'app-notices';
  dom.window.document.body.append(notices);
  vm.runInContext(read('public/app-notices.js'), ctx, { filename: path.join(ROOT, 'public/app-notices.js') });
  const openTerminalCalls = [];
  const messages = [];
  const confirmations = [];
  const settings = { global: {} };
  const session = { sessionId: SID, projectPath: dir, name: 'Scheduled task' };
  dom.window.api = {
    getSessionContinuations: async () => ({ candidates: [], unresolved: false, continued: false }),
    getSessionLiveElsewhere: (id) => handlers.get('session-live-elsewhere')(null, id),
    getSessionsLiveElsewhere: (ids) => handlers.get('sessions-live-elsewhere')(null, ids),
    restoreBackgroundJob: async () => ({ action: 'refuse', reason: 'background job id unavailable' }),
    openTerminal: async (...args) => { openTerminalCalls.push(args); return { ok: true }; },
    getSetting: async (key) => settings[key],
    setSetting: async (key, value) => { settings[key] = value; },
  };
  dom.window.appConfirm = async question => { confirmations.push(question); return true; };
  dom.window.appAlert = async ({ message }) => { messages.push(message); };
  vm.runInContext(read('public/utils.js'), ctx, { filename: path.join(ROOT, 'public/utils.js') });
  vm.runInContext(read('public/resume-guard.js'), ctx, { filename: path.join(ROOT, 'public/resume-guard.js') });
  vm.runInContext(`
    var openSessions = new Map(), pendingSessions = new Map();
    var sessionMap = new Map();
    var localMergedMemberRows = new Map();
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
  `, ctx, { filename: __filename });
  loadAppFunctions(ctx, {
    functions: ['rowSessionIds', 'rowHeadId', 'rowOpenId'], sourcePath: path.join(ROOT, 'public/session-activity-dom.js'),
  });
  const app = loadAppFunctions(ctx, {
    functions: ['openSession', 'openSessionNow', 'runRestore', 'pendingRestoreEntries', 'persistWorkingSet', 'showRestoreNotice', 'showLiveElsewhereNotice', 'indexedRowOf', 'indexedSessionById', 'dormantRowIds', 'syncDormantRow', 'clearDormantRow', 'prepareBackgroundRestore'],
    declarations: ['restoreRunDepth', 'restoreMode', 'LIVE_ELSEWHERE_NOTICE_MS', 'openingSessions', 'skippedWorkingSetEntries', 'restoreSavedIndex', 'restoreAwaitingConsent', 'restoreInFlight', 'restoreIndexingDone', 'continuationRetryCancelled', 'exitingApp', 'persistSkippedWhileExiting', 'dormantWorkingSet'],
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
    spawns, done, messages, confirmations, openTerminalCalls, session, ctx, settings, dom,
    start: async ({ manual = false } = {}) => {
      const { claudeArgs } = buildScheduleCommand(SID, { name: 'Scheduled task', cli: {} });
      (await main.runScheduleCommand(claudeArgs, dir, 'Scheduled task', () => done.push(true), { manual }));
      return children.at(-1);
    },
    open: (options) => app.openSession(session, undefined, options),
    query: (id = SID) => dom.window.api.getSessionLiveElsewhere(id),
    batch: (ids) => dom.window.api.getSessionsLiveElsewhere(ids),
    restore: async (entry = {}) => {
      ctx.restoringWorkingSet = true;
      await app.runRestore([{ sessionId: SID, projectPath: dir, active: true, ...entry }]);
      await app.persistWorkingSet();
      ctx.restoringWorkingSet = false;
    },
  };
}

test('a click during a scheduled run asks Resume anyway and opens when accepted', async (t) => {
  const h = setup(t);
  (await h.start());
  assert.equal(h.spawns.length, 1);
  await h.open();
  assert.equal(h.openTerminalCalls.length, 1);
  assert.notEqual(h.openTerminalCalls[0][3].type, 'attach', 'scheduled runs never attach to the daemon');
  assert.equal(h.ctx.openSessions.get(SID).attach, false);
  assert.equal(h.messages.length, 0);
  assert.equal(h.confirmations.length, 1);
  assert.equal(h.confirmations[0].confirmLabel, 'Resume anyway');
  assert.match(h.confirmations[0].message[0], /in a scheduled run of "Scheduled task"/);
  h.child.emit('exit', 0);
  h.ctx.openSessions.get(SID).closed = true;
  await h.open();
  assert.equal(h.openTerminalCalls.length, 2, 'the completed scheduled transcript becomes resumable');
  assert.equal(h.done.length, 1);
});

test('a click during Run now retains the manual marker in the resume question', async t => {
  const h = setup(t);
  await h.start({ manual: true });
  assert.equal((await h.query()).scheduleName, 'Manual run Scheduled task');
  await h.open();
  assert.equal(h.openTerminalCalls.length, 1);
  assert.match(h.confirmations[0].message[0], /in a scheduled run of "Manual run Scheduled task"/);
});

test('automatic reload during a scheduled run skips the resume without prompting', async (t) => {
  const h = setup(t);
  (await h.start());
  await h.open({ automatic: true });
  assert.equal(h.openTerminalCalls.length, 0, 'automatic reload must not fork the running transcript');
  assert.equal(h.messages.length, 0);
});

test('working-set restore skips the scheduled run and retains its saved entry', async (t) => {
  const h = setup(t);
  (await h.start());
  await h.restore();
  assert.equal(h.openTerminalCalls.length, 0, 'batch restore must not resume a live scheduled run');
  assert.equal(h.settings.global.openWorkingSet[0].sessionId, SID);
  assert.equal(h.settings.global.openWorkingSet[0].active, false);
  assert.equal(h.messages.length, 0);
});

test('background restore without a job id shows only the restore notice', async t => {
  const h = setup(t);
  h.dom.window.api.getSessionsLiveElsewhere = async () => ({ [SID]: { kind: 'bg', pid: 4242 } });
  await h.restore({ bg: true });
  assert.equal(h.openTerminalCalls.length, 0);
  assert.equal(h.confirmations.length, 0);
  assert.equal(h.messages.length, 0);
  const notices = h.dom.window.document.querySelectorAll('[data-notice-id]');
  assert.equal(notices.length, 1, 'one skipped entry gets only its restore notice');
  assert.equal(notices[0].dataset.noticeId, `Restore:local:${SID}`);
  assert.match(notices[0].textContent, /Scheduled task/);
  assert.equal(h.dom.window.document.querySelector('[data-notice-id^="resume-background:"]'), null);
  assert.equal(h.settings.global.openWorkingSet[0].sessionId, SID);
});

test('an interactive background click without a job id keeps its error notice', async t => {
  const h = setup(t);
  await h.open({ live: { kind: 'bg', pid: 4242 } });
  assert.equal(h.openTerminalCalls.length, 0);
  assert.equal(h.confirmations.length, 0);
  const notices = h.dom.window.document.querySelectorAll('[data-notice-id]');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].dataset.noticeId, `resume-background:${SID}`);
  assert.equal(notices[0].getAttribute('role'), 'alert');
  assert.match(notices[0].textContent, /Cannot open "Scheduled task".*Agents view/);
});

test('cancelling a scheduled-session click opens no terminal and does not attach', async t => {
  const h = setup(t);
  await h.start();
  h.dom.window.appConfirm = async question => { h.confirmations.push(question); return false; };
  const opened = await h.open();
  assert.equal(h.confirmations.length, 1);
  assert.equal(h.confirmations[0].confirmLabel, 'Resume anyway');
  assert.equal(h.openTerminalCalls.length, 0);
  assert.equal(h.ctx.openSessions.size, 0);
  assert.equal(h.openTerminalCalls.some(([, , , options]) => options?.type === 'attach'), false);
  assert.equal(opened, false);
});

test('a scheduled child without a CLI descriptor is visible under either session id case', async (t) => {
  const h = setup(t);
  (await h.start());
  assert.deepEqual(fs.readdirSync(h.session.projectPath), []);
  const live = await h.query(SID.toUpperCase());
  assert.equal(live?.kind, 'schedule');
  assert.equal(live.pid, h.child.pid);
  assert.equal(live.cwd, h.session.projectPath);
  assert.equal(live.scheduleName, 'Scheduled task');
  assert.equal((await h.batch([SID]))[SID].scheduleName, 'Scheduled task');
  assert.equal((await h.batch([SID.toUpperCase()]))[SID.toUpperCase()]?.kind, 'schedule');
  assert.equal(await h.query('unrelated'), null);
});

test('a spawn error clears the scheduled run so its session can be opened', async (t) => {
  const h = setup(t);
  (await h.start());
  assert.equal((await h.query())?.kind, 'schedule');
  h.child.emit('error', new Error('spawn failed'));
  assert.equal(await h.query(), null);
  await h.open();
  assert.equal(h.openTerminalCalls.length, 1);
  assert.equal(h.done.length, 1);
});

test('a replaced scheduled child exiting preserves the replacement until it exits', async (t) => {
  const h = setup(t);
  const first = (await h.start());
  assert.equal((await h.query())?.pid, first.pid);
  const replacement = (await h.start());
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
  (await h.start());
  assert.equal(h.spawns.length, 0);
  assert.equal(await h.query(), null);
  await h.open();
  assert.equal(h.openTerminalCalls.length, 1);
});

test('the schedule verdict offers a resume override and Cancel refuses it', async () => {
  const messages = [];
  const result = await guardResume({ sessionId: SID }, {
    live: { kind: 'schedule', pid: 4242, cwd: '/scheduled' },
    confirm: async question => { messages.push(question); return false; },
    notify: () => assert.fail('no refusal notice'),
  });
  assert.equal(result, false);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].confirmLabel, 'Resume anyway');
  assert.equal(await guardResume({ sessionId: SID }, {
    live: { kind: 'schedule', pid: 4242, cwd: '/scheduled' },
    confirm: async () => true,
    notify: () => assert.fail('no refusal notice'),
  }), true, 'accepting a scheduled run resumes it rather than returning a daemon attach verdict');
});
