'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const espree = require('espree');
const { loadAppFunctions } = require('./app-source');

function wireExitBackground(context, source, sourcePath) {
  const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'commonjs', range: true });
  const statements = ast.body.find(node => node.id?.name === 'startApplication').body.body;
  const index = statements.findIndex(node => node.id?.name === 'runExitBackgroundBatch');
  assert.ok(index >= 0);
  vm.runInContext(source.slice(...statements[index + 1].range), context, { filename: sourcePath });
}

function setup() {
  const messages = [], ended = [], dead = [], sessions = new Map();
  let exit;
  const session = { realSessionId: 'old', backgrounding: true, kind: 'local-pty' };
  sessions.set('old', session);
  const ctx = vm.createContext({
    ptyGenerationCounter: 0,
    TRACE: { on: false },
    ptyExitSignalName: () => null,
    shutdownMcpServer() {},
    mainWindow: { isDestroyed: () => false, webContents: { send: (...args) => messages.push(args) } },
    appQuitting: false,
    activeSessions: sessions,
    exitedRemoteSessionIds: new Set(),
    activityReporter: { sessionEnded: id => ended.push(id) },
    taskRecords: { ownerDied: id => dead.push(id) },
    writer: { releaseLiveSession: async () => false },
    notifyRendererProjectsChanged() {},
    log: { warn() {} },
    holdBackgroundExit: (s, finish) => { s.backgroundExit = finish; return true; },
  });
  const { wireSessionPty } = loadAppFunctions(ctx, { functions: ['wireSessionPty'], sourcePath: path.join(__dirname, '../main.js') });
  wireSessionPty(session, 'old', { onData() {}, onExit: fn => { exit = fn; } });
  return { session, messages, sessions, exit, ended, dead };
}

test('M1: shipped PTY exit wiring holds process-exited until handoff settles', () => {
  const h = setup();
  h.exit({ exitCode: 0 });
  assert.equal(h.session.exited, true);
  assert.deepEqual(h.messages, []);
  assert.equal(typeof h.session.backgroundExit, 'function');
  h.session.backgroundExit(true);
  assert.deepEqual(h.messages, []);
  assert.equal(h.sessions.has('old'), false);
});

test('M2: a failed handoff releases ordinary exit once and does not remove a replacement session', () => {
  const h = setup();
  h.exit({ exitCode: 1 });
  assert.deepEqual(h.messages, []);
  const replacement = {};
  h.sessions.set('old', replacement);
  h.session.backgroundExit(false);
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0][0], 'process-exited');
  assert.equal(h.sessions.get('old'), replacement);
  assert.deepEqual(h.ended, []);
});

test('the interactive exit does not terminate the tasks of a confirmed background continuation', () => {
  const h = setup();
  h.exit({ exitCode: 0 });
  assert.deepEqual(h.dead, []);
  h.session.realSessionId = 'bg';
  h.sessions.delete('old');
  h.sessions.set('bg', h.session);
  h.session.backgroundExit(true);
  assert.deepEqual(h.dead, []);
  assert.equal(h.sessions.has('bg'), false);
});

function ipcSetup(t, { status = 'idle', sessionCache, writer, onTransitions = () => {}, folderOf = () => 'folder' } = {}) {
  const fs = require('node:fs');
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bg-ipc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = folderOf(root);
  fs.mkdirSync(path.join(root, folder));
  const transcript = path.join(root, folder, 'OLD.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: 'hello' } }) + '\n');
  const writes = [], kills = [], listeners = new Set(), statusAsked = [], taps = [];
  const events = [], warned = [], waiters = [];
  let notifications = 0, exited;
  const untilNotified = count => new Promise(resolve => {
    waiters.push({ count, resolve });
    for (const waiter of waiters) if (notifications >= waiter.count) waiter.resolve();
  });
  let descriptors = [];
  const session = { kind: 'local-pty', realSessionId: 'OLD', projectFolder: folder, exitDrain: new Promise(resolve => { exited = resolve; }), composerState: require('../src/main/terminals/composer-state').createComposerState(), pty: { onData: fn => { const tap = { fn, disposed: false, dispose() { tap.disposed = true; } }; taps.push(tap); return tap; } } };
  const ctx = vm.createContext({
    setTimeout, clearTimeout, Date, Promise, path, fs, require: require('node:module').createRequire(path.join(__dirname, '../main.js')), PROJECTS_DIR: root,
    detectSessionTransitions: name => onTransitions(name),
    sessionCache: sessionCache || { resolveSessionContinuations: async id => { events.push('resolve:' + id); return { candidates: [], unresolved: false }; } },
    writer: writer || { refreshFolder: async (name, options) => { events.push('refresh:' + name + ':' + [...options.files].join(',')); return false; } },
    notifyRendererProjectsChanged: cause => {
      events.push('notify:' + cause);
      notifications++;
      for (const waiter of waiters) if (notifications >= waiter.count) waiter.resolve();
    },
    log: { warn: (...args) => warned.push(args.join(' ')) },
    sessionHasPty: () => false, ptyPids: () => [],
    bgAgents: { findRestoreJob: () => ({ known: false, missing: true, reason: 'no background job record' }),
      continuationJobCheck: async () => ({ known: true, job: null }) },
    activeSessions: new Map([['tab', session]]),
    mainWindow: { isDestroyed: () => false, webContents: { send() {} } },
    writePty: (entry, text) => {
      writes.push(text);
      if (text === '\r') {
        fs.appendFileSync(transcript, JSON.stringify({ type: 'continued-in', sessionId: 'OLD', continuedInSessionId: 'new' }) + '\n');
        setTimeout(() => { descriptors = [{ kind: 'bg', sessionId: 'new', jobId: '1234abcd', cwd: root }]; for (const fn of [...listeners]) fn(); }, 10);
      }
      return true;
    },
    killPty: entry => { kills.push(entry); },
    cliSessionState: {
      getStatus: id => { statusAsked.push(id); return descriptors.length ? null : { status, waitingFor: null }; },
      readAllDescriptors: () => descriptors,
      onDescriptorsChanged: fn => { listeners.add(fn); return () => listeners.delete(fn); },
      liveElsewhereChecked: async id => ({ known: true, live: descriptors.find(d => d.sessionId === id) || null }),
    },
    ...require('../src/main/bg-agents/bg-handoff'),
  });
  const { handleSendToBackground } = loadAppFunctions(ctx, { declarations: ['backgroundHandoffs'],
    functions: ['handleSendToBackground', 'persistBackgroundHandoff', 'readBackgroundHandoffStamp'], sourcePath: path.join(__dirname, '../main.js') });
  return { ctx, handleSendToBackground, session, writes, kills, listeners, statusAsked, taps, events, warned, untilNotified,
    exit: () => exited(), root, folder, transcript, descriptors: () => descriptors };
}

test('M3: the shipped IPC handler maps CLI status, reads the tab transcript and wakes on descriptor changes', async t => {
  const h = ipcSetup(t);
  const started = Date.now();
  const result = await h.handleSendToBackground({}, 'tab');
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, oldSessionId: 'tab', jobId: '1234abcd', sessionId: 'new', cwd: h.root });
  assert.deepEqual(h.writes, ['/bg', '\r']);
  assert.ok(Date.now() - started < 5000);
  assert.equal(h.statusAsked.every(id => id === 'OLD'), true);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.taps.length, 1);
  assert.equal(h.taps[0].disposed, true);
});

test('M4: the shipped IPC handler refuses a waiting CLI status object before any write', async t => {
  const h = ipcSetup(t, { status: 'waiting' });
  const result = await h.handleSendToBackground({}, 'tab');
  assert.equal(result.code, 'refused');
  assert.deepEqual(h.writes, []);
  h.exit();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.events, [], 'a refused handoff indexes nothing');
});

test('#715 a confirmed handoff saves the source continuation index, refreshes its row, then notifies projects', { timeout: 9000 }, async t => {
  let release;
  const events = [];
  let lookup;
  const sessionCache = { resolveSessionContinuations: (id, options) => { events.push('resolve:' + id); lookup = options; return new Promise(resolve => { release = resolve; }); } };
  const writer = { refreshFolder: async (name, options) => { events.push('refresh:' + name + ':' + [...options.files].join(',')); return false; } };
  const h = ipcSetup(t, { sessionCache, writer });
  const result = await h.handleSendToBackground({}, 'tab');
  assert.equal(result.ok, true);
  assert.deepEqual(events, ['resolve:OLD']);
  assert.deepEqual(await lookup.getSessionLiveElsewhere('new'), { known: true, live: h.descriptors()[0] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.events, [], 'nothing is refreshed or notified before the index is saved');
  release({ candidates: [], unresolved: false });
  await h.untilNotified(1);
  assert.deepEqual(events, ['resolve:OLD', 'refresh:folder:OLD.jsonl']);
  assert.deepEqual(h.events, ['notify:background-handoff']);
});

test('#715 the source is saved again once its interactive process has exited', { timeout: 9000 }, async t => {
  const h = ipcSetup(t);
  assert.equal((await h.handleSendToBackground({}, 'tab')).ok, true);
  await h.untilNotified(1);
  assert.deepEqual(h.events, ['resolve:OLD', 'refresh:folder:OLD.jsonl', 'notify:background-handoff']);
  h.exit();
  await h.untilNotified(2);
  assert.deepEqual(h.events.slice(3), ['resolve:OLD', 'refresh:folder:OLD.jsonl', 'notify:background-handoff']);
});

test('#715 a failed save of the source continuation index is logged, not notified', { timeout: 9000 }, async t => {
  const sessionCache = { resolveSessionContinuations: () => Promise.reject(new Error('disk gone')) };
  const h = ipcSetup(t, { sessionCache });
  assert.equal((await h.handleSendToBackground({}, 'tab')).ok, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.warned.length, 1);
  assert.match(h.warned[0], /OLD.*disk gone/);
  assert.deepEqual(h.events, []);
});

function realCache(t, { flushFirst = false, name = null } = {}) {
  const fs = require('node:fs');
  const cache = require('../session-cache');
  const { encodeProjectPath } = require('../encode-project-path');
  const rows = new Map();
  const metadata = new Map(name ? [['OLD', { name }]] : []);
  const db = {
    getSetting: () => ({}), getAllFolderMeta: () => new Map(), getFolderMeta: () => undefined, getAllMeta: () => metadata,
    getAllCached: () => [...rows.values()], getCachedByFolder: () => [...rows.values()], getCachedSession: id => rows.get(id),
    upsertCachedSessions: entries => entries.forEach(row => rows.set(row.sessionId, row)),
    setCachedContinuationIndex(id, index) { if (rows.has(id)) rows.set(id, { ...rows.get(id), continuationIndex: index }); },
    setFolderMeta() {}, getMeta() {}, setName() {}, upsertSearchEntries() {}, replaceSessionMetrics() {}, touchCachedModified() {},
    deleteCachedFolder() {}, deleteCachedSession() {}, deleteSearchFolder() {}, deleteSearchSession() {},
  };
  const contended = () => {
    fs.appendFileSync(other, JSON.stringify({ type: 'assistant', message: { content: 'other work' } }) + '\n');
    cache.refreshFolder(h.folder, { files: new Set(['OTHER.jsonl', 'OLD.jsonl']) });
    return rows.get('OLD').continuationIndex;
  };
  let flushed;
  const h = ipcSetup(t, {
    sessionCache: cache, folderOf: encodeProjectPath,
    writer: { refreshFolder: async (name, options) => { init(); return cache.refreshFolder(name, options); } },
    onTransitions: () => { if (flushFirst && flushed === undefined) flushed = contended(); },
  });
  const user = id => JSON.stringify({ type: 'user', sessionId: id, cwd: h.root, timestamp: '2026-10-19T08:00:00.000Z', message: { content: 'hello' } }) + '\n';
  fs.writeFileSync(h.transcript, user('OLD') + (JSON.stringify({ type: 'assistant', padding: 'x'.repeat(400 * 1024) }) + '\n').repeat(4));
  const other = path.join(h.root, h.folder, 'OTHER.jsonl');
  fs.writeFileSync(other, user('OTHER'));
  const init = () => cache.init({ PROJECTS_DIR: h.root, db, activeSessions: new Map(), getMainWindow: () => null, log: console,
    getLocalDescriptors: () => h.descriptors(), getLocalJobs: () => new Map() });
  init();
  cache.refreshFolder(h.folder);
  assert.equal(JSON.parse(rows.get('OLD').continuationIndex).complete, true);
  init();
  const sidebar = () => cache.buildProjectsFromCache(false).flatMap(project => project.sessions)
    .map(session => session.sessionId + (session.descriptorOnly ? ':descriptor-only' : '') + (session.mergedMemberIds?.length ? ':' + session.mergedMemberIds.join(',') : ''))
    .filter(id => !id.startsWith('OTHER'));
  return { ...h, rows, contended, sidebar, projects: () => cache.buildProjectsFromCache(false), flushed: () => flushed };
}

test('#715 after a restart and a flush whose continuation budget another transcript used, the handoff still merges the rows', { timeout: 9000 }, async t => {
  const h = realCache(t, { flushFirst: true });
  assert.equal((await h.handleSendToBackground({}, 'tab')).ok, true);
  assert.equal(h.flushed(), null, 'the flush after the append left the source without an index');
  await h.untilNotified(1);
  assert.deepEqual(JSON.parse(h.rows.get('OLD').continuationIndex).ids, ['new']);
  assert.deepEqual(h.sidebar(), ['new:OLD']);
});

test('#715 when the save finishes before any watcher flush, the notification already shows one row', { timeout: 9000 }, async t => {
  const h = realCache(t);
  assert.equal((await h.handleSendToBackground({}, 'tab')).ok, true);
  await h.untilNotified(1);
  assert.deepEqual(h.sidebar(), ['new:OLD']);
});

test('#715 a write to the source before its process exits cannot leave the rows split', { timeout: 9000 }, async t => {
  const fs = require('node:fs');
  const h = realCache(t);
  assert.equal((await h.handleSendToBackground({}, 'tab')).ok, true);
  await h.untilNotified(1);
  assert.deepEqual(h.sidebar(), ['new:OLD']);
  const before = structuredClone(h.rows.get('OLD'));
  fs.appendFileSync(h.transcript, JSON.stringify({ type: 'system', subtype: 'shutdown' }) + '\n');
  h.contended();
  assert.deepEqual(h.rows.get('OLD'), before, 'a contended flush defers the entire linked row');
  assert.deepEqual(h.sidebar(), ['new:OLD']);
  h.exit();
  await h.untilNotified(2);
  assert.deepEqual(h.sidebar(), ['new:OLD']);
  assert.deepEqual(JSON.parse(h.rows.get('OLD').continuationIndex).stamp,
    require('../session-continuations').continuationStamp(fs.statSync(h.transcript, { bigint: true })));
});

test('#715 a restarted handoff renders one named conversation over the inherited renderer title', { timeout: 9000 }, async t => {
  const { setupSidebarDom } = require('./dom-setup');
  const h = realCache(t, { flushFirst: true, name: 'devex-board' });
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  ctx.window.sessionMap.set('new', { sessionId: 'new', aiTitle: 'Onboarding setup', projectPath: h.root });
  assert.equal((await h.handleSendToBackground({}, 'tab')).ok, true);
  await h.untilNotified(1);
  const projects = h.projects();
  const { dedup } = loadAppFunctions(ctx.context, { functions: ['dedup'] });
  dedup(projects);
  ctx.sidebar.renderProjects(projects, false);
  assert.deepEqual(h.sidebar(), ['new:OLD']);
  assert.equal(ctx.document.querySelectorAll('[data-session-id="new"]').length, 1);
  const title = ctx.document.querySelector('[data-session-id="new"] .session-summary').textContent;
  assert.match(title, /devex-board/);
  assert.doesNotMatch(title, /Onboarding setup/);
});

test('#715 a failed targeted refresh is logged without notifying projects', { timeout: 9000 }, async t => {
  const h = ipcSetup(t, { writer: { refreshFolder: () => Promise.reject(new Error('refresh failed')) } });
  assert.equal((await h.handleSendToBackground({}, 'tab')).ok, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.warned.length, 1);
  assert.match(h.warned[0], /\[bg-handoff\].*OLD.*refresh failed/);
  assert.deepEqual(h.events, ['resolve:OLD']);
});

test('C5 the exit batch waits on the real CLI id after a clear rekey', async () => {
  const sourcePath = path.join(__dirname, '../main.js');
  const source = require('node:fs').readFileSync(sourcePath, 'utf8');
  assert.match(source, /async function runExitBackgroundBatch\(/);
  const asked = [], sends = [], listeners = new Set();
  let status = 'busy';
  const context = vm.createContext({
    runExitHandoffs: require('../src/main/app/session-exit').runExitHandoffs,
    activeSessions: new Map([['tab', { realSessionId: 'real' }]]), Date, setTimeout, clearTimeout,
    cliSessionState: {
      getStatus: id => { asked.push(id); return { status: id === 'real' ? status : 'idle' }; },
      onDescriptorsChanged: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    },
    handleSendToBackground: async (event, id) => { sends.push([event, id]); return { ok: true }; },
    createUnsavedGuard: options => options, ipcMain: { handle() {} },
  });
  loadAppFunctions(context, { functions: ['runExitBackgroundBatch'], sourcePath });
  vm.runInContext(source.slice(source.indexOf('const unsavedGuard ='), source.indexOf('const { cleanEnv')), context, { filename: sourcePath });
  assert.deepEqual(JSON.parse(JSON.stringify(await vm.runInContext("unsavedGuard.background(['tab'], {})", context))), []);
  wireExitBackground(context, source, sourcePath);
  const pending = vm.runInContext("unsavedGuard.background(['tab'], {})", context);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sends, [], 'the tab key reports idle but its real CLI is busy');
  assert.equal(listeners.size, 1);
  status = 'idle'; for (const listener of [...listeners]) listener();
  assert.equal((await pending)[0].ok, true);
  assert.deepEqual(sends, [[null, 'tab']]);
  assert.ok(asked.length >= 2 && asked.every(id => id === 'real'));
  assert.equal(listeners.size, 0);
});

for (const external of [false, true]) {
  test(`C5 abort external=${external} clears the shipped busy waiter timer and listener`, async () => {
    const sourcePath = path.join(__dirname, '../main.js');
    const timers = new Set(), listeners = new Set(), sends = [];
    const controller = new AbortController();
    const context = vm.createContext({
      runExitHandoffs: require('../src/main/app/session-exit').runExitHandoffs,
      activeSessions: new Map([['tab', { realSessionId: 'real' }]]), Date,
      setTimeout: fn => { timers.add(fn); return fn; }, clearTimeout: timer => timers.delete(timer),
      cliSessionState: {
        getStatus: () => ({ status: 'busy' }),
        onDescriptorsChanged: fn => { listeners.add(fn); return () => listeners.delete(fn); },
      },
      handleSendToBackground: async () => { sends.push('send'); return { ok: true }; },
    });
    const { runExitBackgroundBatch } = loadAppFunctions(context, { functions: ['runExitBackgroundBatch'], sourcePath });
    const pending = runExitBackgroundBatch(['tab'], { signal: controller.signal });
    assert.equal(timers.size, 1);
    assert.equal(listeners.size, 1);
    controller.abort({ external });
    assert.equal((await pending)[0].code, 'cancelled');
    assert.equal(timers.size, 0, 'abort must clear the pending busy-wait timer');
    assert.equal(listeners.size, 0, 'abort must unsubscribe the descriptor listener');
    assert.deepEqual(sends, []);
  });
}


test('the shipped handler refuses /bg before any write while a live job hosts a continuation of the conversation', async t => {
  const h = ipcSetup(t);
  h.ctx.bgAgents.continuationJobCheck = async () => ({ known: true, job: { id: 'bbbbbbbb', state: 'working' } });
  const result = await h.handleSendToBackground({}, 'tab');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'refused');
  assert.match(result.error, /bbbbbbbb/);
  assert.deepEqual(h.writes, []);
});

test('the shipped handler lets /bg go when continuation liveness is unknown, and logs it', async t => {
  const h = ipcSetup(t);
  const infos = [];
  h.ctx.log.info = (...args) => infos.push(args.join(' '));
  h.ctx.bgAgents.continuationJobCheck = async () => ({ known: false, reason: 'cannot read background jobs' });
  const result = await h.handleSendToBackground({}, 'tab');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.writes, ['/bg', '\r']);
  assert.ok(infos.some(line => /continuation liveness unknown/.test(line)));
});

test('the shipped handler refuses /bg when the check found several live continuation owners', async t => {
  const h = ipcSetup(t);
  h.ctx.log.info = () => assert.fail('a found conflict is not unknown liveness');
  h.ctx.bgAgents.continuationJobCheck = async () => ({ known: false, reason: 'multiple live continuation jobs; check the Agents view',
    jobs: [{ id: 'bbbbbbbb', state: 'working' }, { id: 'cccccccc', state: 'working' }] });
  const result = await h.handleSendToBackground({}, 'tab');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'refused');
  assert.match(result.error, /bbbbbbbb, cccccccc/);
  assert.deepEqual(h.writes, [], 'known live conflicts never become permission to submit /bg');
});

test('the shipped handler refuses /bg when an uncertain check still names the live owner it had established', async t => {
  const h = ipcSetup(t);
  h.ctx.log.info = () => assert.fail('an established owner is not unknown liveness');
  h.ctx.bgAgents.continuationJobCheck = async () => ({ known: false, reason: 'cannot read conversation continuations for 22222222-2222-4222-8222-222222222222',
    jobs: [{ id: 'bbbbbbbb', state: 'working' }] });
  const result = await h.handleSendToBackground({}, 'tab');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'refused');
  assert.match(result.error, /background job bbbbbbbb\./);
  assert.deepEqual(h.writes, [], 'a later uncertain tail must not discard the proven live owner and submit /bg');
});

function continuationChoiceFixture(t, { choice = 'cancel', stop = { ok: true }, renderer = true } = {}) {
  const { EventEmitter } = require('node:events');
  const h = ipcSetup(t);
  const ipcMain = new EventEmitter(), handlers = new Map(), sent = [], questions = [], stops = [];
  ipcMain.handle = (name, handler) => handlers.set(name, handler);
  const wc = new EventEmitter();
  const win = new EventEmitter();
  Object.assign(win, { isDestroyed: () => false, webContents: wc });
  Object.assign(wc, { isDestroyed: () => false, isCrashed: () => false, mainFrame: {}, send(channel, ...args) {
    sent.push([channel, ...args]);
    if (channel === 'bg-continuation-choice') void receive?.(...args);
    if (channel === 'bg-continuation-choice-cancel') cancelQuestion?.(...args);
  } });
  let receive, cancelQuestion;
  const control = { choose: null };
  const stopOptions = [];
  const rendererContext = vm.createContext({ window: { api: {
    onBgContinuationChoice: fn => { receive = fn; },
    onBgContinuationChoiceCancel: fn => { cancelQuestion = fn; },
    showBgContinuationChoice: token => ipcMain.emit('bg-continuation-choice-shown', { sender: wc, senderFrame: wc.mainFrame }, token),
    answerBgContinuationChoice: (token, answer) => ipcMain.emit('bg-continuation-choice-answer', { sender: wc, senderFrame: wc.mainFrame }, token, answer),
  } }, openSessions: new Map([['tab', { session: { sessionId: 'OLD', name: 'harness-dev' } }]]), sessionMap: new Map(),
  appChoose: async question => { questions.push(question); question.onShown?.(); return control.choose ? control.choose(question) : choice === 'cancel' ? null : { choice }; } });
  loadAppFunctions(rendererContext, { functions: ['initExitBackgroundControl'] }).initExitBackgroundControl();
  const logs = [];
  Object.assign(h.ctx, { ipcMain, mainWindow: renderer ? win : null,
    unsubscribeBgAgents: { runStop: async (id, options) => { stops.push(id); stopOptions.push(options); if (stop instanceof Error) throw stop; return stop; } },
    runExitHandoffs: require('../src/main/app/session-exit').runExitHandoffs,
  });
  h.ctx.log.info = text => logs.push(text);
  h.ctx.bgAgents.conversationCheck = async () => ({ known: true, sessionIds: ['prior'], workerLiveness: 'unknown' });
  h.ctx.bgAgents.continuationJobCheck = async id => id === 'OLD' && !stops.length
    ? { known: false, reason: 'worker liveness unknown for continuation job adb1224f',
      unknownJobs: [{ id: 'adb1224f', name: 'harness-dev', sessionId: 'prior', state: 'done' }] }
    : { known: true, job: null };
  const { runExitBackgroundBatch } = loadAppFunctions(h.ctx, { functions: ['runExitBackgroundBatch'], sourcePath: path.join(__dirname, '../main.js') });
  const guard = require('../src/main/app/unsaved-guard').createUnsavedGuard({ ipcMain,
    inventory: () => ({ rows: [...h.ctx.activeSessions.keys()].map(id => ({ id, type: 'session', background: 'ready' })), counts: {}, remote: {} }),
    background: runExitBackgroundBatch,
    setTimeoutFn: () => ({}), clearTimeoutFn() {},
  });
  t.after(() => guard.invalidate());
  const batch = async (ids = ['tab']) => {
    void guard.approveQuit(win);
    const [, checkId, , detail] = sent.find(row => row[0] === 'unsaved-check');
    ipcMain.emit('unsaved-check-ack', { sender: wc }, checkId);
    return handlers.get('exit-background')({ sender: wc }, checkId, detail, ids);
  };
  return { ...h, batch, ipcMain, wc, sent, questions, stops, stopOptions, logs, control, rendererContext, runExitBackgroundBatch };
}

for (const choice of ['stop', 'keep', 'cancel']) {
  test('#1295 exit-background IPC asks before /bg and applies ' + choice, async t => {
    const h = continuationChoiceFixture(t, { choice });
    const results = await h.batch();
    assert.equal(h.questions.length, 1, 'unknown continuation must ask exactly once before /bg');
    const question = h.questions[0];
    assert.deepEqual(Array.from(question.options, option => option.label), ['Stop the old job', 'Keep it and continue']);
    assert.match(JSON.stringify(question.messageParts), /harness-dev.*adb1224f/);
    assert.equal(results[0].ok, choice !== 'cancel');
    assert.deepEqual(h.stops, choice === 'stop' ? ['adb1224f'] : []);
    assert.deepEqual(h.writes, choice === 'cancel' ? [] : ['/bg', '\r']);
    if (choice === 'cancel') assert.equal(results[0].code, 'cancelled');
    assert.equal(h.session.backgrounding, false);
    assert.equal(h.ipcMain.listenerCount('bg-continuation-choice-answer'), 0);
  });
}

for (const stop of [{ ok: false, error: 'worker cannot be verified' }, new Error('stop unavailable')]) {
  test('#1295 a failed stop cancels this session and explains why: ' + (stop.error || stop.message), async t => {
    const h = continuationChoiceFixture(t, { choice: 'stop', stop });
    const [result] = await h.batch();
    assert.deepEqual(h.stops, ['adb1224f'], 'Stop must use the existing checked background job stop');
    assert.equal(result.code, 'cancelled');
    assert.match(result.error, /Could not stop.*adb1224f/);
    assert.match(result.error, /worker cannot be verified|stop unavailable/);
    assert.deepEqual(h.writes, []);
  });
}

test('#1295 cancelling one session leaves it foreground and still sends the next batch session', async t => {
  const h = continuationChoiceFixture(t);
  h.ctx.activeSessions.set('second', { ...h.session, realSessionId: 'SECOND' });
  require('node:fs').writeFileSync(path.join(h.root, h.folder, 'SECOND.jsonl'), '{}\n');
  const perSessionWrites = [];
  h.ctx.writePty = (entry, text) => {
    perSessionWrites.push([entry.realSessionId, text]);
    if (text === '\r') {
      require('node:fs').appendFileSync(path.join(h.root, h.folder, entry.realSessionId + '.jsonl'), JSON.stringify({ type: 'continued-in', sessionId: entry.realSessionId, continuedInSessionId: 'new' }) + '\n');
      h.descriptors().push({ kind: 'bg', sessionId: 'new', jobId: '1234abcd' });
    }
    return true;
  };
  let secondReady = false;
  h.ctx.cliSessionState.getStatus = id => ({ status: id === 'SECOND' && !secondReady ? 'busy' : 'idle' });
  h.control.choose = () => { setTimeout(() => { secondReady = true; for (const fn of [...h.listeners]) fn(); }, 20); return null; };
  const results = await h.batch(['tab', 'second']);
  assert.equal(results[0].code, 'cancelled');
  assert.equal(results[1].ok, true);
  assert.deepEqual(perSessionWrites, [['SECOND', '/bg'], ['SECOND', '\r']]);
  assert.equal(h.ctx.activeSessions.has('tab'), true);
});

test('#1295 without a renderer an unknown continuation is cancelled and logged', async t => {
  const h = continuationChoiceFixture(t, { renderer: false });
  const [result] = await h.batch();
  assert.equal(result.code, 'cancelled');
  assert.deepEqual(h.writes, []);
  assert.ok(h.logs.some(line => /cancel/i.test(line)));
});

for (const remaining of ['live', 'unknown']) {
  test('#1295 r2 successful Stop rechecks and cancels when an owner remains: ' + remaining, async t => {
    const h = continuationChoiceFixture(t, { choice: 'stop' });
    const initial = h.ctx.bgAgents.continuationJobCheck;
    let checks = 0;
    h.ctx.bgAgents.continuationJobCheck = async id => {
      checks++;
      if (checks === 1) return initial(id);
      return remaining === 'live' ? { known: true, job: { id: 'cccccccc' } }
        : { known: false, reason: 'still unknown', unknownJobs: [{ id: 'adb1224f', sessionId: 'prior' }] };
    };
    const result = await h.handleSendToBackground({}, 'tab');
    assert.deepEqual(h.writes, [], 'a stop ACK must not authorize /bg while an owner remains');
    assert.ok(checks >= 2, 'Stop must re-read the continuation graph');
    assert.equal(result.ok, false);
  });
}

test('#1295 r2 Keep approves only the ids shown and asks for a newly discovered job', async t => {
  const h = continuationChoiceFixture(t, { choice: 'keep' });
  let checks = 0;
  h.ctx.bgAgents.continuationJobCheck = async () => ({ known: false, unknownJobs: [
    { id: 'adb1224f', sessionId: 'prior' }, ...(++checks > 1 ? [{ id: 'cccccccc', sessionId: 'deeper' }] : []),
  ] });
  h.control.choose = () => h.questions.length === 1 ? { choice: 'keep' } : null;
  const result = await h.handleSendToBackground({}, 'tab');
  assert.equal(h.questions.length, 2, 'a new unknown job requires its own consent');
  assert.equal(result.code, 'cancelled');
  assert.deepEqual(h.writes, []);
});

for (const signal of [{}, { aborted: true }]) {
  test('#1295 r2 single Send ignores renderer supplied signal ' + JSON.stringify(signal), async t => {
    const h = continuationChoiceFixture(t, { choice: 'keep' });
    const result = await h.handleSendToBackground({}, 'tab', { signal });
    assert.equal(result.ok, true, 'IPC options cannot inject a cancellation signal');
    assert.equal(h.questions.length, 1);
    assert.deepEqual(h.writes, ['/bg', '\r']);
  });
}

for (const change of ['busy', 'rebound', 'exited', 'composer']) {
  test('#1295 r2 revalidates the session before Stop: ' + change, async t => {
    const h = continuationChoiceFixture(t, { choice: 'stop' });
    h.control.choose = () => {
      if (change === 'busy') h.ctx.cliSessionState.getStatus = () => ({ status: 'busy' });
      if (change === 'rebound') h.session.realSessionId = 'different';
      if (change === 'exited') h.session.exited = true;
      if (change === 'composer') require('../src/main/terminals/composer-state').noteUserInput(h.session.composerState, 'unsent', Date.now());
      return { choice: 'stop' };
    };
    await h.handleSendToBackground({}, 'tab');
    assert.deepEqual(h.stops, [], 'an ineligible or rebound tab must not stop the old job');
    assert.deepEqual(h.writes, []);
  });
}

test('#1295 r2 partial Stop reports jobs already stopped', async t => {
  const h = continuationChoiceFixture(t, { choice: 'stop' });
  h.ctx.bgAgents.continuationJobCheck = async () => ({ known: false, unknownJobs: [
    { id: 'adb1224f', sessionId: 'prior' }, { id: 'cccccccc', sessionId: 'deeper' },
  ] });
  h.ctx.unsubscribeBgAgents.runStop = async id => { h.stops.push(id); return id === 'adb1224f' ? { ok: true } : { ok: false, error: 'denied' }; };
  const result = await h.handleSendToBackground({}, 'tab');
  assert.match(result.error, /Stop acknowledged: adb1224f/, 'partial progress must not disappear from the error');
  assert.match(result.error, /cccccccc.*denied/);
  assert.equal(result.stopError, true);
  assert.deepEqual(h.writes, []);
});

test('#1295 r2 Stop prefers strict verification when fresh liveness is known', async t => {
  const h = continuationChoiceFixture(t, { choice: 'stop', stop: { ok: true, ended: true } });
  h.ctx.bgAgents.conversationCheck = async () => ({ known: true, sessionIds: ['prior'], workerLiveness: 'live' });
  assert.equal((await h.handleSendToBackground({}, 'tab')).ok, true);
  assert.equal(h.stopOptions[0]?.strict, true, 'known ownership must use the strict stop port');
  assert.deepEqual(Array.from(h.stopOptions[0].sessionIds), ['prior']);
});

for (const choice of ['stop', 'keep']) {
  test('#1295 r2 ' + choice + ' gets a fresh handoff deadline after a late answer', async t => {
    const h = continuationChoiceFixture(t, { choice });
    let time = 0;
    h.ctx.Date = { now: () => time };
    h.control.choose = () => { time = 130000; return { choice }; };
    const result = await h.handleSendToBackground({}, 'tab');
    assert.equal(result.ok, true, 'question and stop time must not consume the handoff deadline');
    assert.deepEqual(h.writes, ['/bg', '\r']);
  });
}

for (const external of [false, true]) {
  test('#1295 r2 batch abort notifies the open question: external=' + external, async t => {
    const h = continuationChoiceFixture(t);
    let displayed;
    const showing = new Promise(resolve => { displayed = resolve; });
    h.control.choose = question => { displayed(); return question.closeWith || new Promise(() => {}); };
    const controller = new AbortController();
    const pending = h.runExitBackgroundBatch(['tab'], { signal: controller.signal });
    await showing;
    controller.abort({ external });
    await pending;
    await new Promise(resolve => setImmediate(resolve));
    const token = h.sent.find(row => row[0] === 'bg-continuation-choice')[1];
    assert.ok(h.sent.some(row => row[0] === 'bg-continuation-choice-cancel' && row[1] === token), 'main must cancel the renderer question by token');
    assert.deepEqual(h.writes, []);
    assert.equal(h.ipcMain.listenerCount('bg-continuation-choice-answer'), 0);
  });
}

test('#1295 r2 question timeout starts on display, cancels by token and removes listeners', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { EventEmitter } = require('node:events');
  const ipcMain = new EventEmitter(), wc = new EventEmitter(), sent = [];
  Object.assign(wc, { isDestroyed: () => false, isCrashed: () => false, mainFrame: {}, send: (...args) => sent.push(args) });
  const win = { isDestroyed: () => false, webContents: wc };
  let answer;
  const pending = require('../src/main/bg-agents/bg-handoff').askContinuationChoice({ ipcMain, window: win, sessionId: 'tab', jobs: [], timeoutMs: 120 });
  pending.then(value => { answer = value; });
  const token = sent[0][1];
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.equal(answer, undefined, 'a queued question must not spend its visible timeout');
  ipcMain.emit('bg-continuation-choice-shown', { sender: wc, senderFrame: {} }, token);
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.equal(answer, undefined, 'a foreign frame cannot start the timer');
  ipcMain.emit('bg-continuation-choice-shown', { sender: wc, senderFrame: wc.mainFrame }, token);
  t.mock.timers.tick(120);
  assert.equal(await pending, 'cancel');
  assert.ok(sent.some(row => row[0] === 'bg-continuation-choice-cancel' && row[1] === token));
  assert.equal(ipcMain.listenerCount('bg-continuation-choice-shown'), 0);
  assert.equal(ipcMain.listenerCount('bg-continuation-choice-answer'), 0);
});

 test('#1295 r2 single renderer Send reaches main, asks, and Cancel returns quietly', async t => {
  const h = continuationChoiceFixture(t);
  const failures = [];
  Object.assign(h.rendererContext, {
    backgroundActionReason: () => null,
    activeSubagentsByParent: new Map(),
    updateTerminalHeader() {},
    showSessionActionFailure: (...args) => failures.push(args),
  });
  h.rendererContext.window.api.sendSessionToBackground = (id, options) => h.handleSendToBackground({}, id, options);
  const app = loadAppFunctions(h.rendererContext, { functions: ['sendSessionToBackground'] });
  await app.sendSessionToBackground('tab');
  assert.equal(h.questions.length, 1, 'single action must reach the same continuation question');
  assert.deepEqual(h.writes, []);
  assert.deepEqual(failures, [], 'single action Cancel must not become a failure notice');
  assert.equal(h.rendererContext.openSessions.get('tab').backgrounding, false);
});
