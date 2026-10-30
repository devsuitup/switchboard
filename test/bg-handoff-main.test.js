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
    sessionCache: { releaseLiveSession: () => false },
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
  const session = { kind: 'local-pty', realSessionId: 'OLD', projectFolder: folder, exitDrain: new Promise(resolve => { exited = resolve; }), composerState: require('../composer-state').createComposerState(), pty: { onData: fn => { const tap = { fn, disposed: false, dispose() { tap.disposed = true; } }; taps.push(tap); return tap; } } };
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
    bgAgents: { findRestoreJob: () => ({ known: false, missing: true, reason: 'no background job record' }) },
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
    ...require('../bg-handoff'),
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


test('S2-T9 shipped respawn handler releases the real PTY exit without persisting a continuation', { timeout: 20000 }, async t => {
  const h = ipcSetup(t);
  const calls = [];
  let exit;
  Object.assign(h.ctx, {
    sendToBackground: (id, deps) => require('../bg-handoff').sendToBackground(id, { ...deps, timeoutMs: 1000, exitTimeoutMs: 300 }),
    ptyGenerationCounter: 0, TRACE: { on: false }, ptyExitSignalName: () => null,
    shutdownMcpServer() {}, appQuitting: false, exitedRemoteSessionIds: new Set(),
    activityReporter: { sessionEnded() {} }, taskRecords: { ownerDied() {} },
    resolveExitDrain() {},
    bgAgents: {
      findRestoreJob: () => ({ known: true, job: { id: 'aaaaaaaa', resumeTarget: 'old', sessionId: 'OLD' } }),
      conversationCheck: async () => ({ known: true, state: 'stopped', workerLiveness: 'dead', sessionIds: ['OLD'] }),
      liveJobCheck: () => ({ known: true, job: null }),
    },
    unsubscribeBgAgents: { respawnForHandoff: async job => { calls.push(job.id); assert.equal(h.session.exited, true); return { ok: true, attached: true }; } },
    detectSessionTransitions: () => assert.fail('respawn must not detect a new continuation'),
    persistBackgroundHandoff: () => assert.fail('respawn must not persist a continuation'),
    writePty: (_, text) => { h.writes.push(text); if (text === '\r') setTimeout(() => exit({ exitCode: 0 }), 10); return true; },
  });
  h.ctx.writer.releaseLiveSession = async () => false;
  const { wireSessionPty } = loadAppFunctions(h.ctx, { functions: ['wireSessionPty'], sourcePath: path.join(__dirname, '../main.js') });
  wireSessionPty(h.session, 'tab', { onData() {}, onExit: fn => { exit = fn; } });
  const result = await h.handleSendToBackground({}, 'tab');
  assert.equal(result.ok, true);
  assert.equal(result.respawned, true);
  assert.equal(h.ctx.activeSessions.has('tab'), false);
  assert.deepEqual(calls, ['aaaaaaaa']);
  assert.deepEqual(h.writes, ['/exit', '\r']);
});
