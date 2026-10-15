'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { createWriterWorkerClient } = require('../session-index-writer-client');
const { createCacheEffects } = require('../cache-effects');

function databaseScenario(name, body, setup = 'const writer = createSessionIndexWriter();') {
  test(name, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-review-'));
    try {
      const result = spawnSync(require('electron'), ['-e', `
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        const path = require('node:path');
        const { createSessionIndexWriter } = require('./session-index-writer');
        (async () => {
          ${setup}
          try { await writer.ready; const db = require('./db'); ${body} }
          finally { await writer.closeDb(); }
        })().catch(error => { console.error(error); process.exitCode = 1; });
      `], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 60000,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: dir } });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

databaseScenario('ten batches of 200 tiny FTS entries retain all 2000 entries', `
  for (let batch = 0; batch < 10; batch++) {
    await writer.upsertSearchEntries(Array.from({ length: 200 }, (_, i) => ({
      id: 'tiny-' + (batch * 200 + i), type: 'memory', title: 'tiny', body: 'needle tiny prose'
    })));
  }
  assert.equal(db.getSearchFileIds('memory').length, 2000);
  assert.equal(db.searchByType('memory', 'needle', 3000).length, 2000);
`);

for (const size of [8192, 16384, 32768]) databaseScenario(`30 prose FTS bodies of ${size} bytes are fully indexed`, `
  const body = ('needle prose words '.repeat(${size})).slice(0, ${size});
  await writer.upsertSearchEntries(Array.from({ length: 30 }, (_, i) => ({ id: 'prose-' + i, type: 'memory', title: 'prose', body })));
  assert.equal(db.searchByType('memory', 'needle', 40).length, 30);
`);

databaseScenario('archivedProjects with 2000 ids is accepted and retained', `
  const value = { project: { knownSessionIds: Array.from({ length: 2000 }, (_, i) => 'session-' + i + '-'.repeat(32)) } };
  await writer.setSetting('archivedProjects', value);
  assert.deepEqual(db.getSetting('archivedProjects'), value);
`);

databaseScenario('a 70 KiB continuationIndex survives its acknowledged write', `
  await writer.upsertCachedSessions([{ sessionId: 'large', folder: 'fixture' }]);
  const value = 'x'.repeat(70 * 1024);
  await writer.setCachedContinuationIndex('large', value);
  assert.equal(db.getCachedSession('large').continuationIndex, value);
`);

databaseScenario('base db.js opens and writes metrics in a database opened by the head', `
  const { execFileSync } = require('node:child_process');
  const base = execFileSync('git', ['show', 'e47875e:db.js'], { encoding: 'utf8' });
  await writer.replaceSessionMetrics('old', [{ date: '2026-10-15', messageCount: 3 }]);
  const Module = require('node:module');
  const old = new Module(path.join(process.cwd(), 'db-base.js'));
  old.filename = path.join(process.cwd(), 'db-base.js');
  old.paths = module.paths;
  old._compile(base, old.filename);
  assert.equal(old.exports.getTotalCounts().totalMessages, 3);
  old.exports.replaceSessionMetrics('old', [{ date: '2026-10-15', messageCount: 4 }]);
  old.exports.closeDb();
  assert.equal(db.getTotalCounts().totalMessages, 4);
`);

databaseScenario('steady read-only registry and measurements do not revise settings', `
  const registry = writer.scheduleRegistry(() => []);
  await registry.list();
  const before = db.getSetting('_writer_revision');
  await registry.list();
  await writer.measurements();
  assert.equal(db.getSetting('_writer_revision'), before);
`);

databaseScenario('a writer crash between chunks permits an idempotent indexing rerun', `
    const entries = Array.from({ length: 200 }, (_, i) => ({ id: 'resumed-' + i, type: 'memory', body: 'resume needle' }));
    await assert.rejects(writer.upsertSearchEntries(entries), /unknown.*exited/);
    assert.equal(db.isInitialScanComplete(), false);
    await writer.upsertSearchEntries(entries);
    assert.equal(db.getSearchFileIds('memory').length, 200);
    assert.equal(db.searchByType('memory', 'needle', 300).length, 200);
`, `const { Worker } = require('node:worker_threads');
    let starts = 0;
    const writer = createSessionIndexWriter({ workerFactory: () => new Worker(path.resolve(++starts === 1
      ? 'test/fixtures/writer-chunk-crash.cjs' : 'workers/session-index-writer.js')) });`);

databaseScenario('the injected execution clock adapts without rejecting a committed command', `
  const { openSessionIndexStore } = require('./session-index-store');
  let time = 0;
  const store = openSessionIndexStore({ readonly: false, clock: () => { time += 20; return time; } });
  try {
    assert.doesNotThrow(() => store.transact(() => store.setSetting('clock', true)));
    assert.equal(store.getSetting('clock'), true);
    assert.equal(store.measurements().at(-1).ms, 20);
    assert.ok(store.nextChunkSize() < 32);
  } finally { store.closeDb(); }
`);

test('20k-row fixture reads only the affected folder and session while computing effects', () => {
  const fixture = Array.from({ length: 20000 }, (_, i) => ({ sessionId: String(i), folder: i === 0 ? 'touched' : 'other' }));
  let readRows = 0;
  const effects = createCacheEffects({
    getAllCached: () => { readRows += fixture.length; return fixture; },
    getCachedByFolder: folder => { const rows = fixture.filter(row => row.folder === folder); readRows += rows.length; return rows; },
    getCachedSession: id => { readRows++; return fixture[Number(id)]; },
    getAllMeta: () => new Map(), getAllFolderMeta: () => new Map(),
    getFolderMeta: () => null, getMeta: () => null,
    listSettingKeys: () => [], getSetting: () => null,
  });
  effects.begin();
  assert.equal(effects.adapter.getCachedByFolder('touched').length, 1);
  effects.adapter.touchCachedModified('0', 'now');
  assert.equal(effects.adapter.getCachedSession('0').modified, 'now');
  effects.finish();
  assert.ok(readRows <= 2, `main read ${readRows} rows for one affected row`);
});

function virtualClock() {
  let time = 0, id = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout(fn, ms) { const key = ++id; timers.set(key, { fn, at: time + ms, ms }); return key; },
    clearTimeout: key => timers.delete(key),
    advance(ms) { time += ms; for (const [key, timer] of [...timers]) if (timer.at <= time) { timers.delete(key); timer.fn(); } },
    delays: () => [...timers.values()].map(timer => timer.ms),
  };
}

const turn = () => new Promise(resolve => setImmediate(resolve));

function clientFixture(extra = {}) {
  const clock = virtualClock(), workers = [];
  const client = createWriterWorkerClient({ ...clock, timeoutMs: 50, heartbeatMs: 500, ...extra, workerFactory() {
    const worker = new EventEmitter();
    worker.terminate = async () => {};
    worker.postMessage = message => {
      worker.last = message;
      if (message.command === 'close') queueMicrotask(() => worker.emit('message', { id: message.id }));
    };
    workers.push(worker);
    queueMicrotask(() => worker.emit('message', { ready: true, settings: [] }));
    return worker;
  } });
  return { client, clock, workers };
}

test('restart circuit uses 100/500/1000 ms and resets after a quiet sliding window', async () => {
  const f = clientFixture({ heartbeatMs: 120000 });
  await f.client.ready;
  try {
    for (const delay of [100, 500, 1000]) {
      const count = f.workers.length;
      f.workers.at(-1).emit('exit', 17);
      await turn();
      assert.equal(f.workers.length, count, 'restart waits for backoff');
      assert.ok(f.clock.delays().includes(delay));
      f.clock.advance(delay);
      await turn();
    }
    f.clock.advance(60001);
    f.workers.at(-1).emit('exit', 17);
    await turn();
    assert.ok(f.clock.delays().includes(100), 'quiet window restores restart budget');
    f.clock.advance(100);
    await turn();
    assert.equal(f.workers.length, 5);
  } finally { await f.client.close().catch(() => {}); }
});

test('command deadline starts at execution and a responsive timeout does not terminate the writer', async () => {
  const f = clientFixture();
  await f.client.ready;
  try {
    const job = f.client.request('renameSession', 'id', 'title');
    const rejected = assert.rejects(job, /timed out/);
    const worker = f.workers[0];
    f.clock.advance(100);
    await turn();
    assert.equal(f.workers.length, 1);
    worker.emit('message', { id: worker.last.id, started: true });
    f.clock.advance(50);
    await rejected;
    assert.equal(f.workers.length, 1);
    worker.emit('message', { id: worker.last.id, result: { name: 'title' } });
  } finally { await f.client.close().catch(() => {}); }
});

test('the restart window counts actual launches and an open circuit waits for capacity', async () => {
  const f = clientFixture({ heartbeatMs: 120000 });
  await f.client.ready;
  try {
    for (const delay of [100, 500, 1000]) {
      f.workers.at(-1).emit('exit', 17);
      await turn();
      f.clock.advance(delay);
      await turn();
    }
    f.workers.at(-1).emit('exit', 17);
    await turn();
    f.clock.advance(58400);
    const probe = f.client.request('probe');
    probe.catch(() => {});
    assert.equal(f.workers.length, 4, 'three launches are still inside the last 60 seconds');
    await assert.rejects(probe, /shut/);
    f.clock.advance(1601);
    const recovered = f.client.request('probe');
    recovered.catch(() => {});
    assert.ok(f.clock.delays().includes(100));
    f.clock.advance(100);
    await turn();
    const current = f.workers.at(-1);
    current.emit('message', { id: current.last.id, result: 'recovered' });
    assert.equal(await recovered, 'recovered');
    assert.equal(f.workers.length, 5);
  } finally { await f.client.close().catch(() => {}); }
});

function lifecycleFixture(extra = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8').replaceAll('\r\n', '\n');
  const clock = virtualClock(), calls = [];
  const noop = () => {};
  const context = vm.createContext({
    ...clock, console, Promise, appQuitting: false, activityFlushedForQuit: false, updateInstalling: false,
    app: { removeListener: noop, on: (_name, fn) => { context.quit = fn; }, exit: () => calls.push('exit'), quit: () => calls.push('quit') },
    mainWindow: null, holdBootstrapQuit: noop, unsavedGuard: { beforeQuit: () => false },
    log: { error: (...args) => calls.push(args.join(' ')), warn: noop },
    stopScheduler: noop, mainLoopMonitor: { stop: noop }, TRACE: { on: false },
    shutdownAllMcp: noop, localTranscriptTracker: { dispose: noop }, unsubscribeTaskJobs: noop,
    taskRecords: { dispose: noop }, projectsWatcher: null, cliSessionState: { stop: noop },
    bgAgents: { stop: noop }, remoteIndexer: { dispose: noop }, remoteWatcher: { stopAll: noop },
    remoteActivityTracker: { dispose: noop }, activeSessions: new Map(), closedSessions: new Map(),
    killPty: () => calls.push('kill'), flushProjectsBeforeExit: noop, flushWindowBounds: noop,
    sessionCache: { shutdownProducers: noop }, sessionTransitions: { drainMetadataWrites: noop },
    writer: { releaseLiveSession: noop, drain: noop }, activityReporter: { flush: noop, stop: noop },
    projectsClient: { shutdown: noop }, fileListsClient: { shutdown: noop }, searchClient: { shutdown: noop },
    closeDb: async () => { throw new Error('client.close rejected'); }, activityTrace: { close: noop },
    autoUpdater: { quitAndInstall: () => calls.push('install') }, ...extra,
  });
  const start = source.indexOf('let shutdownPromise;');
  const end = source.indexOf('\n}\n\nstartApplication().catch', start);
  vm.runInContext(source.slice(start, end), context);
  const installStart = source.indexOf("ipcMain.handle('updater-install'");
  const installEnd = source.indexOf('\n});', installStart) + 4;
  context.ipcMain = { handle: (_name, fn) => { context.install = fn; } };
  vm.runInContext(source.slice(installStart, installEnd), context);
  return { context, clock, calls };
}

test('quit exits even when the writer close rejects and a later quit is never trapped', async () => {
  const f = lifecycleFixture();
  f.context.quit({ preventDefault() {} });
  await turn();
  assert.ok(f.calls.includes('exit'), f.calls.join(', '));
  let prevented = false;
  f.context.quit({ preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
});

test('update install reaches updater within 1500 ms with queued writes', async () => {
  const f = lifecycleFixture({ flushProjectsBeforeExit: () => new Promise(() => {}) });
  const installing = f.context.install();
  await turn();
  f.clock.advance(1500);
  await turn();
  assert.ok(f.calls.includes('install'), f.calls.join(', '));
  await installing;
});

test('a throwing update installer preserves database and PTYs and a later quit still drains', async () => {
  const f = lifecycleFixture({
    autoUpdater: { quitAndInstall() { throw new Error('install rejected'); } },
    closeDb: () => f.calls.push('close'), activeSessions: new Map([['live', { exited: false }]]),
  });
  await f.context.install().catch(() => {});
  assert.equal(f.calls.includes('kill'), false);
  assert.equal(f.calls.includes('close'), false);
  assert.equal(f.context.appQuitting, false);
  f.context.quit({ preventDefault() {} });
  await turn();
  assert.ok(f.calls.includes('exit'));
});

test('quit has one 1500 ms deadline across a stalled producer and writer', async () => {
  const f = lifecycleFixture({ flushProjectsBeforeExit: () => new Promise(() => {}) });
  f.context.quit({ preventDefault() {} });
  await turn();
  assert.deepEqual(f.clock.delays(), [1500]);
  f.clock.advance(1500);
  await turn();
  assert.ok(f.calls.includes('exit'));
});

test('a window close preserves exit drains and session ids until coordinated release', async () => {
  const released = [];
  let resolveExit;
  const exitDrain = new Promise(resolve => { resolveExit = resolve; });
  const f = lifecycleFixture({
    closeDb: async () => {}, writer: { releaseLiveSession: id => released.push(id) },
    activeSessions: new Map([['closed', { exited: false, exitDrain }]]),
    changesWatchers: { closeAll() {} }, closeAllFileWatchers() {}, unsubscribeBgAgents() {},
    subagentWatchers: new Map(),
  });
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = source.indexOf("mainWindow.on('closed'");
  const end = source.indexOf('\n  });', start) + 6;
  let closed;
  f.context.mainWindow = { on: (_name, fn) => { closed = fn; } };
  vm.runInContext(source.slice(start, end), f.context);
  closed();
  assert.equal(f.context.activeSessions.size, 0);
  assert.equal(f.context.closedSessions.has('closed'), true);
  f.context.quit({ preventDefault() {} });
  await turn();
  assert.deepEqual(released, []);
  resolveExit();
  await turn();
  assert.deepEqual(released, ['closed']);
  assert.ok(f.calls.includes('exit'));
});

test('second-instance tolerates a destroyed window and bootstrap failure is visible before exit', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  let second;
  const start = source.indexOf("app.on('second-instance'");
  const end = source.indexOf('\n  });', start) + 6;
  vm.runInNewContext(source.slice(start, end), {
    app: { on: (_event, fn) => { second = fn; } },
    mainWindow: { isDestroyed: () => true, isMinimized: () => assert.fail('destroyed window queried') },
  });
  assert.doesNotThrow(second);
  let fail;
  const calls = [];
  vm.runInNewContext(source.slice(source.indexOf('startApplication().catch')), {
    startApplication: () => ({ catch: fn => { fail = fn; } }),
    log: { error: () => calls.push('log') }, dialog: { showErrorBox: () => calls.push('dialog') },
    app: { exit: () => calls.push('exit') },
  });
  fail(new Error('bootstrap failed'));
  assert.deepEqual(calls, ['log', 'dialog', 'exit']);
});

test('read-only acknowledgments never clear or resend the settings mirror', async () => {
  let worker;
  const settings = [];
  const client = createWriterWorkerClient({ onSettings: value => settings.push(value), workerFactory() {
    worker = new EventEmitter();
    worker.terminate = async () => {};
    worker.postMessage = message => queueMicrotask(() => worker.emit('message', { id: message.id, result: [] }));
    queueMicrotask(() => worker.emit('message', { ready: true, settings: [['global', { kept: true }]] }));
    return worker;
  } });
  try {
    await client.ready;
    await client.request('scheduleRegistry', 'list', []);
    assert.equal(settings.length, 1);
  } finally { await client.close(); }
});

test('a missed heartbeat terminates the unresponsive worker and preserves queued recovery', async () => {
  const f = clientFixture();
  await f.client.ready;
  try {
    const job = f.client.request('setSetting', 'blocked', true);
    const failed = assert.rejects(job, /unknown.*heartbeat/);
    f.clock.advance(500);
    await failed;
    await turn();
    assert.ok(f.clock.delays().includes(100));
    f.clock.advance(100);
    await turn();
    assert.equal(f.workers.length, 2);
  } finally { await f.client.close().catch(() => {}); }
});
