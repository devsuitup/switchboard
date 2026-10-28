'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createProjectsWorkerClient } = require('../projects-worker-client');
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(options = {}) {
  const worker = new EventEmitter();
  const messages = [], applied = [], accepted = [];
  let version = 0, liveVersion = 0;
  worker.postMessage = message => messages.push(message);
  worker.terminate = async () => {};
  const client = createProjectsWorkerClient({ workerFactory: () => worker,
    snapshot: () => ({ version, liveVersion }), apply: result => { applied.push(result); },
    accepted: result => accepted.push(result), ...options });
  return { client, worker, messages, applied, accepted,
    change: () => liveVersion++, db: () => ++version,
    reply: (index, result) => worker.emit('message', { id: messages[index].id, result }) };
}
const readonly = { effects: [], keptLiveRows: [], reconciled: false, defaultProjects: [], allProjects: [] };
test('T5.1 third live snapshot conflict rejects without publishing and independently pending work recovers', async t => {
  const f = fixture(); t.after(() => f.client.shutdown());
  const request = f.client.request();
  const rejected = assert.rejects(request, { code: 'PROJECTS_SNAPSHOT_CONFLICT', message: 'Projects changed while loading; reload to retry.' });
  for (let i = 0; i < 2; i++) { f.change(); f.reply(i, readonly); }
  const pending = f.client.request();
  pending.catch(() => {});
  f.change(); f.reply(2, readonly);
  await rejected;
  assert.equal(f.applied.length, 0);
  assert.equal(f.messages.length, 4);
  f.reply(3, readonly);
  assert.deepEqual(await pending, readonly);
});
test('T5.2 a live input changing during final ACK rejects after exactly three attempts', async t => {
  const f = fixture({ apply: async () => { f.db(); f.change(); return { version: f.db() }; } });
  t.after(() => f.client.shutdown());
  const request = f.client.request({ reconcile: true });
  const rejected = assert.rejects(request, { code: 'PROJECTS_SNAPSHOT_CONFLICT' });
  for (let i = 0; i < 3; i++) { f.reply(i, { effects: [{}], keptLiveRows: [], reconciled: true }); await flush(); }
  await rejected;
  assert.equal(f.messages.length, 3);
  assert.equal(f.accepted.length, 0);
});
test('T5.4 effect-free cold replies tolerate DB-only changes', async t => {
  const f = fixture(); t.after(() => f.client.shutdown());
  const request = f.client.request(); f.db(); f.reply(0, readonly);
  assert.deepEqual(await request, readonly);
  assert.equal(f.messages.length, 1);
});

test('T5.3 the reconciliation hard ceiling is not reset by a conflict retry', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const f = fixture({ timeoutMs: 1000, reconcileTimeoutMs: 50 }); t.after(() => f.client.shutdown());
  const request = f.client.request({ reconcile: true }); const rejected = assert.rejects(request, /reconcile timed out/);
  t.mock.timers.tick(20); f.change(); f.reply(0, readonly);
  assert.equal(f.messages.length, 2); t.mock.timers.tick(30); await rejected;
});

test('T5.2 actual main ACK adapter retains the committed baseline across an external DB write', async t => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = source.indexOf('  apply: async result => {'), end = source.indexOf('\n  accepted:', start);
  let release, version = 0;
  const ack = new Promise(resolve => { release = resolve; });
  const snapshot = () => ({ version, liveVersion: 0, writerRevision: version });
  const apply = vm.runInNewContext('({' + source.slice(start, end) + '}).apply', {
    writer: { applyProjectsWorkerEffects: () => { version = 1; return ack; } }, projectsSnapshot: snapshot });
  const worker = new EventEmitter(), messages = []; worker.postMessage = m => messages.push(m); worker.terminate = async () => {};
  const client = createProjectsWorkerClient({ workerFactory: () => worker, snapshot, apply }); t.after(() => client.shutdown());
  const pending = client.request(); pending.catch(() => {});
  worker.emit('message', { id: messages[0].id, result: { effects: [{}], reconciled: true } });
  version = 2; release({ committedRevision: 1 }); await flush();
  assert.equal(messages.length, 2, 'the external DB revision after own commit must force a fresh snapshot');
});

for (const afterChunk of [1, 2]) {
  test(`T5.2 shipped writer preserves its committed ACK and refuses interleaved remaining effects, afterChunk=${afterChunk}`, async () => {
    const settings = new Map(), names = new Map(), replies = [];
    let changes = 0, handle, yielded = 0;
    const db = { transact: fn => fn(), changeCount: () => changes,
      getSetting: key => settings.get(key), setSetting: (key, value) => { settings.set(key, value); changes++; },
      listSettingKeys: () => [...settings.keys()], setName: (id, name) => { names.set(id, name); changes++; },
      chunkUnit: fn => ({ result: fn() }), nextChunkSize: () => 1, searchFtsRecreated: false };
    let complete;
    const done = new Promise(resolve => { complete = resolve; });
    const port = { on: (_name, callback) => { handle = callback; }, postMessage: message => {
      replies.push(message); if (message.id === 1 && !message.started) complete();
    } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../workers/session-index-writer.js'), 'utf8'), {
      setInterval: () => ({ unref() {} }),
      require: name => name === 'node:worker_threads' ? { parentPort: port }
        : name === 'node:timers/promises' ? { setTimeout: async () => {}, setImmediate: async () => {
          if (++yielded === afterChunk) handle({ id: 2, command: 'setName', args: ['external', 'new'] });
        } }
          : name === '../session-index-store' ? { openSessionIndexStore: () => db }
            : name === '../session-index-commands' ? require('../session-index-commands') : require(name) });
    handle({ id: 1, command: 'effects', args: [[{ name: 'setName', args: ['a', 'first'] }, { name: 'setName', args: ['b', 'second'] }], 0] });
    await done;
    const reply = replies.find(r => r.id === 1 && !r.started);
    assert.equal(names.get('a'), 'first');
    if (afterChunk === 1) { assert.equal(reply.error.code, 'WRITER_STALE'); assert.equal(names.has('b'), false); }
    else { assert.equal(reply.result.committedRevision, 2); assert.equal(settings.get('_writer_revision'), 3); }
  });
}

test('T5.2 persisted writer revision bypasses the settings ACK mirror', () => {
  let current = 1;
  const store = { listSettingKeys: () => ['_writer_revision'], getSetting: () => current };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../db.js'), 'utf8'), {
    require: () => ({ openSessionIndexStore: () => store }), module, structuredClone });
  current = 2;
  assert.equal(module.exports.getSetting('_writer_revision'), 1);
  assert.equal(module.exports.getSetting('_writer_revision', { fresh: true }), 2);
});

for (const away of [false, true]) test(`T5.5/T5.6 main conflict envelope survives IPC and the existing event route recovers accepted lists, away=${away}`, async t => {
  const { setupSidebarDom } = require('./dom-setup');
  const { loadAppFunctions } = require('./app-source');
  const h = setupSidebarDom(); t.after(() => h.destroy());
  const f = fixture(); t.after(() => f.client.shutdown());
  let invoke, event, notifications = 0, assemblies = 0, bridge;
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = main.indexOf("ipcMain.handle('get-projects'");
  vm.runInNewContext(main.slice(start, main.indexOf('\n});', start) + 4), {
    ipcMain: { handle: (_name, handler) => { invoke = handler; } }, TRACE: { on: false }, console,
    getSetting: () => null, isInitialScanComplete: () => true, isCachePopulated: () => true, isSearchIndexPopulated: () => true,
    backfillEntrypoints() {}, backfillCustomTitles() {}, projectsReconciledAt: 0, projectsClient: f.client,
    mergePlaceholderSessions: rows => { assemblies++; return rows; },
    writer: { applyAndPersistArchived: async rows => rows }, annotateRemoteAttachable: rows => rows,
    notifyRendererProjectsChanged: cause => { assert.equal(cause, 'conflict'); notifications++; event(); } });
  const transport = { invoke: async (_channel, mode) => {
    try { return JSON.parse(JSON.stringify(await invoke(null, mode))); }
    catch (error) { throw new Error(error.message); }
  }, send() {}, on() {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8'), { process,
    require: () => ({ contextBridge: { exposeInMainWorld: (_key, value) => { bridge = value; } }, ipcRenderer: transport }) });
  const w = h.window, timers = [];
  w.cachedProjects = [{ projectPath: 'accepted', sessions: [] }]; w.cachedAllProjects = w.cachedProjects;
  w.loadingStatus = w.document.createElement('div');
  for (const name of ['reportActivityFocus', 'reportActivityTitles', 'refreshSidebar', 'renderDefaultStatus', 'maybeRetryRestoreWorkingSet']) w[name] = () => {};
  w.pollActiveSessions = async () => {};
  w.api.getProjects = bridge.getProjects; w.api.getSetting = async () => ({}); w.api.getActiveTerminals = async () => [];
  w.api.onProjectsChanged = callback => { event = callback; };
  w.setTimeout = callback => { timers.push(callback); return timers.length; }; w.clearTimeout = () => {};
  w.activeTab = away ? 'stats' : 'sessions';
  loadAppFunctions(h.context, { declarations: ['searchGeneration'], functions: ['dedup', 'loadProjects', 'reloadProjects'] });
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const eventStart = app.indexOf('let projectsChangedTimer = null;');
  vm.runInContext(app.slice(eventStart, app.indexOf('\n});', eventStart) + 4), h.context);
  const initial = w.reloadProjects();
  for (let i = 0; i < 3; i++) { await flush(); f.change(); f.reply(i, readonly); }
  assert.equal(await initial, false); assert.equal(w.cachedProjects[0].projectPath, 'accepted');
  assert.equal(assemblies, 0); assert.equal(notifications, 1); assert.equal(timers.length, away ? 0 : 1);
  if (away) {
    const tab = w.document.createElement('button'); tab.className = 'sidebar-tab'; tab.dataset.tab = 'sessions'; w.document.body.append(tab);
    for (const name of ['searchBar', 'workFilesContent', 'sessionFilters', 'placeholder']) w[name] = w.document.createElement('div');
    w.searchInput = w.document.createElement('input'); w.hideAllViewers = () => {}; w.gridViewActive = false;
    const tabsStart = app.indexOf("document.querySelectorAll('.sidebar-tab').forEach(tab => {");
    vm.runInContext(app.slice(tabsStart, app.indexOf('\n// Grid view →', tabsStart)), h.context);
    tab.click(); await flush(); assert.equal(w.activeTab, 'sessions');
  } else { timers.shift()(); await flush(); }
  assert.equal(f.messages.length, 4, 'recovery dispatch requires no unrelated source event');
  f.reply(3, { ...readonly, defaultProjects: [{ projectPath: 'fresh', sessions: [] }], allProjects: [{ projectPath: 'fresh', sessions: [] }] });
  await flush(); assert.equal(w.cachedProjects[0].projectPath, 'fresh'); assert.equal(assemblies, 2);
  const coded = bridge.getProjects('both'); const rejected = assert.rejects(coded, { code: 'PROJECTS_SNAPSHOT_CONFLICT' });
  for (let i = 4; i < 7; i++) { await flush(); f.change(); f.reply(i, readonly); }
  await rejected;
});

test('T5.5 repeated conflict notifications coalesce under the shipped throttle and stop after draining', () => {
  const source = fs.readFileSync(path.join(__dirname, '../session-cache.js'), 'utf8');
  const start = source.indexOf('const NOTIFY_THROTTLE_MS ='), end = source.indexOf('\nfunction sendStatus', start);
  let now = 0, next = 0; const timers = new Map(), deliveries = [];
  const notify = vm.runInNewContext(source.slice(start, end) + '\nnotifyRendererProjectsChanged;', {
    stopping: false, TRACE: { on: false },
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (_channel, payload) => deliveries.push({ at: now, cause: payload.cause }) } }),
    setTimeout: (fn, delay) => { const id = ++next; timers.set(id, { fn, at: now + delay }); return id; }, clearTimeout: id => timers.delete(id) });
  const advance = time => { now = time; for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.fn(); } };
  notify('conflict');
  for (now = 100; now < 1500; now += 100) notify('conflict');
  assert.equal(deliveries.length, 1); assert.equal(timers.size, 1);
  advance(1500); assert.equal(deliveries.length, 2); assert.deepEqual([...deliveries[1].cause], ['conflict']);
  advance(3000); assert.equal(deliveries.length, 2); assert.equal(timers.size, 0);
});

test('T5.7 shipped async worker and writer retain admitted progress while three held snapshots reject, then recover', { timeout: 12000 }, async t => {
  const cache = require('../session-cache');
  const { fixture: setup, OLD, HEAD } = require('./fixtures/continuation-718.cjs');
  const { projectsWorker } = require('./fixtures/projects-worker-718.cjs');
  const { memoryWriter } = require('./fixtures/writer-memory.cjs');
  const h = setup(t); h.write(OLD, h.link()); cache.refreshFolder(h.folder); h.append(OLD, h.padding);
  const writer = memoryWriter(h.db, cache); await writer.ready;
  writer.initializeCache({ PROJECTS_DIR: h.root, activeSessions: h.activeSessions, getMainWindow: () => null, log: h.log });
  const emitter = new EventEmitter(); let liveVersion = 0, churn = true, builds = 0;
  const worker = projectsWorker(h, { onMessage: message => {
    if (message.result && churn) liveVersion++;
    emitter.emit('message', message);
  } });
  emitter.postMessage = message => { builds++; worker.handle(message); }; emitter.terminate = async () => {};
  const client = createProjectsWorkerClient({ workerFactory: () => emitter,
    snapshot: () => ({ version: 0, liveVersion, localDescriptors: h.descriptors }),
    apply: result => writer.applyProjectsWorkerEffects(result) });
  t.after(() => client.shutdown());
  await assert.rejects(client.request({ reconcile: true }), { code: 'PROJECTS_SNAPSHOT_CONFLICT' });
  assert.equal(builds, 3); assert.ok(h.rows.has(OLD));
  churn = false;
  const result = await client.request({ reconcile: true });
  assert.equal(builds, 4); assert.ok(result.allProjects.flatMap(p => p.sessions).some(row => row.sessionId === HEAD));
  assert.ok(result.projection.buildId); assert.doesNotThrow(() => structuredClone(result.projection));
});
