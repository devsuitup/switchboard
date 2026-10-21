'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createWriterWorkerClient } = require('../session-index-writer-client');

function scenario(name, code) {
  test(name, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-worker-6166b-'));
    try {
      const result = spawnSync(require('electron'), ['-e', `
        const assert = require('node:assert/strict');
        const path = require('node:path');
        const Database = require('better-sqlite3');
        const { Worker } = require('node:worker_threads');
        const { createSessionIndexWriter } = require('./session-index-writer');
        (async () => { ${code} })().catch(error => { console.error(error); process.exitCode = 1; });
      `], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 20000,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: dir } });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

scenario('main connection rejects writes after writer bootstrap', `
  const writer = createSessionIndexWriter();
  try {
    await writer.ready;
    const db = require('./db');
    assert.throws(() => db.setSetting('stray', true), /readonly/i);
    await writer.setSetting('acknowledged', true);
    assert.equal(db.getSetting('acknowledged'), true);
  } finally { await writer.closeDb(); }
`);

for (const phase of ['before-commit', 'after-commit']) scenario('writer crash ' + phase + ' fails explicitly and restarts within its bound', `
  let starts = 0;
  const writer = createSessionIndexWriter({ workerFactory: () => {
    starts++;
    return new Worker(path.resolve(starts === 1 ? 'test/fixtures/writer-crash.cjs' : 'workers/session-index-writer.js'), { workerData: { phase: '${phase}' } });
  } });
  try {
    await writer.ready;
    await assert.rejects(writer.toggleStar('uncertain'), /unknown|exited|crash/i);
    await writer.setSetting('after-crash', 7);
    assert.ok(starts >= 2 && starts <= 4, 'bounded worker restart');
    const db = require('./db');
    assert.equal(db.getSetting('after-crash'), 7);
    assert.equal(db.getMeta('uncertain')?.starred || 0, '${phase}' === 'after-commit' ? 1 : 0);
  } finally { await writer.closeDb(); }
`);

scenario('SQLITE_BUSY retries are bounded and a released lock permits the next command', `
  const writer = createSessionIndexWriter();
  await writer.ready;
  const blocker = new Database(require('./db').DB_PATH);
  try {
    blocker.exec('BEGIN IMMEDIATE');
    const start = Date.now();
    await assert.rejects(writer.setSetting('locked', 1), /BUSY|locked/i);
    assert.ok(Date.now() - start < 2500, 'lock wait must be bounded');
    blocker.exec('ROLLBACK');
    await writer.setSetting('after-lock', 2);
    assert.equal(require('./db').getSetting('after-lock'), 2);
  } finally { if (blocker.inTransaction) blocker.exec('ROLLBACK'); blocker.close(); await writer.closeDb(); }
`);

scenario('quit drains every queued command before closing and rejects later admission', `
  const writer = createSessionIndexWriter();
  await writer.ready;
  const acknowledgments = [];
  const jobs = Array.from({ length: 48 }, (_, i) => writer.setSetting('queued:' + i, i).then(() => acknowledgments.push(i)));
  const closing = writer.closeDb();
  await Promise.all(jobs);
  await closing;
  assert.equal(acknowledgments.length, 48);
  await assert.rejects(writer.setSetting('late', 1), /clos|shut/i);
  const db = new Database(path.join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'), { readonly: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'queued:%'").get().n, 48);
  db.close();
`);

scenario('large metric replacements publish atomically in the compatible metrics table', `
  const writer = createSessionIndexWriter();
  try {
    await writer.ready;
    await writer.upsertCachedSessions([{ sessionId: 'metrics', folder: 'folder' }]);
    await writer.replaceSessionMetrics('metrics', [{ date: '2026-10-15', model: 'old', messageCount: 7 }]);
    const db = require('./db');
    const rows = Array.from({ length: 96 }, (_, i) => ({ date: '2026-10-15', model: 'model-' + i, messageCount: 1 }));
    const replacing = writer.replaceSessionMetrics('metrics', rows);
    let reading = true;
    const observations = (async () => { while (reading) {
      const total = db.getTotalCounts().totalMessages;
      assert.ok(total === 7 || total === 96, 'readers must not see partial metrics: ' + total);
      await new Promise(resolve => setTimeout(resolve, 1));
    } })();
    try { await replacing; } finally { reading = false; await observations; }
    assert.equal(db.getTotalCounts().totalMessages, 96);
    const measured = await writer.measurements();
    assert.ok(measured.length >= 3);
    assert.ok(measured.every(unit => unit.ms >= 0));
    assert.equal(db.connection.prepare("SELECT type FROM sqlite_master WHERE name = 'session_metrics'").get().type, 'table');
  } finally { await writer.closeDb(); }
`);

scenario('full sized FTS bodies survive indexing and rename within the input cap', `
  const writer = createSessionIndexWriter();
  try {
    await writer.ready;
    await writer.upsertCachedSessions([{ sessionId: 'long', folder: 'folder', summary: 'summary' }]);
    await writer.upsertSearchEntries([{ id: 'long', type: 'session', folder: 'folder', title: 'summary', body: '界'.repeat(31000) + ' searchterm ' }]);
    await writer.renameSession('long', 'new title');
    assert.equal(require('./db').searchByType('session', 'searchterm').length, 1);
    const measured = await writer.measurements();
    assert.ok(measured.every(unit => unit.bytes <= 65536));
  } finally { await writer.closeDb(); }
`);

scenario('quit lets an accepted remap reach its completion command before closing', `
  const fs = require('node:fs');
  const writer = createSessionIndexWriter();
  await writer.ready;
  const root = process.env.SWITCHBOARD_DATA_DIR;
  const dir = path.join(root, 'transcripts');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'session.jsonl'), JSON.stringify({ cwd: '/old' }) + '\\n');
  const remapping = writer.remapProjectTranscripts({ folder: 'folder', folderPath: dir, oldPath: '/old', newPath: root });
  const closing = writer.closeDb();
  await remapping;
  await closing;
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'session.jsonl'), 'utf8')).cwd, root);
  const db = new Database(path.join(root, 'switchboard.db'), { readonly: true });
  assert.equal(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'projectRemaps'").get().value).folder, root);
  db.close();
`);

scenario('shutdown rejects new admission while preserving accepted nested workflow completions and final bounds', `
  const fs = require('node:fs');
  const writer = createSessionIndexWriter();
  await writer.ready;
  const root = process.env.SWITCHBOARD_DATA_DIR;
  const dir = path.join(root, 'transcripts');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'session.jsonl'), JSON.stringify({ cwd: '/old' }) + '\\n');
  const remapping = writer.remapProjectTranscripts({ folder: 'folder', folderPath: dir, oldPath: '/old', newPath: root });
  const closing = writer.beginShutdown(async () => {
    await writer.patchGlobal({ finalBounds: true });
    await writer.closeDb();
  });
  await assert.rejects(writer.setSetting('late', 1), /closing/);
  await Promise.all([remapping, closing]);
  const db = new Database(path.join(root, 'switchboard.db'), { readonly: true });
  assert.equal(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'projectRemaps'").get().value).folder, root);
  assert.equal(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'global'").get().value).finalBounds, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'session.jsonl'), 'utf8')).cwd, root);
  db.close();
`);

scenario('PTY exit cleanup in its spawn context releases retained rows after shutdown admission closes', `
  const { AsyncResource } = require('node:async_hooks');
  const cache = require('./session-cache');
  const writer = createSessionIndexWriter({}, cache);
  await writer.ready;
  const root = process.env.SWITCHBOARD_DATA_DIR;
  const projects = path.join(root, 'projects');
  fs.mkdirSync(projects);
  writer.initializeCache({ PROJECTS_DIR: projects, activeSessions: new Map(), getMainWindow: () => null, log: { warn() {} } });
  await writer.upsertCachedSessions([{ sessionId: 'pty-head', folder: 'missing', summary: 'retained' }]);
  await writer.applyProjectsWorkerEffects({ effects: [], keptLiveRows: [['pty-head', 'missing']] });
  const pty = new AsyncResource('pty-spawn');
  try {
    await writer.beginShutdown(async () => {
      assert.equal(await pty.runInAsyncScope(() => writer.releaseLiveSession('pty-head')), true);
      await assert.rejects(pty.runInAsyncScope(() => writer.patchGlobal({ late: true })), /closing/);
      assert.equal(require('./db').getCachedSession('pty-head'), null);
    });
  } finally { await writer.closeDb(); }
  await assert.rejects(writer.releaseLiveSession('pty-head'), /closing/);
`);

scenario('an offer changed before completion reports the conflict without consuming newer state', `
  let complete, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const writer = createSessionIndexWriter({ workerFactory: () => {
    const worker = new Worker(path.resolve('workers/session-index-writer.js'));
    const post = worker.postMessage.bind(worker);
    worker.postMessage = message => {
      if (message.command === 'completeOffer') { complete = () => post(message); entered(); }
      else post(message);
    };
    return worker;
  } });
  try {
    await writer.ready;
    const project = process.env.SWITCHBOARD_DATA_DIR;
    const { archivedEntry } = require('./archived-projects');
    const entry = archivedEntry(null, project);
    await writer.setSetting('scheduleReenableOffers', { [entry]: { disabledSchedules: ['old.md'] } });
    const enabling = writer.reenableOfferedSchedules(project, '', {
      notify() {}, reenable: () => ({ enabled: ['old'], failed: [] }),
    });
    await waiting;
    const newer = { [entry]: { disabledSchedules: ['new.md'] } };
    await writer.setSetting('scheduleReenableOffers', newer);
    complete();
    const result = await enabling;
    assert.match(result.error || '', /changed/);
    assert.deepEqual(require('./db').getSetting('scheduleReenableOffers'), newer);
  } finally { await writer.closeDb(); }
`);

test('update install waits for the reversible drain before invoking the updater', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = source.indexOf("ipcMain.handle('updater-install'");
  const end = source.indexOf('\n});', start) + 4;
  let invoke, release;
  const drained = new Promise(resolve => { release = resolve; });
  const calls = [];
  vm.runInNewContext(require('./app-source').extractFunction(source, 'resetUpdateAttempt') + '\n' + source.slice(start, end), {
    ipcMain: { handle: (_name, fn) => { invoke = fn; } },
    mainWindow: null, quitAttemptToken: null, updateInstallPromise: null, updateWaitTimer: null,
    setTimeout, clearTimeout, unsavedGuard: { invalidate() {} }, activityFlushedForQuit: false, updateInstalling: false,
    process: { platform: 'win32' }, log: { error() {} },
    drainForUpdate: async () => { calls.push('drain'); await drained; calls.push('drained'); },
    autoUpdater: { quitAndInstall: () => calls.push('install') },
    stopNonDatabaseResources: () => calls.push('cleanup'),
  });
  const installing = invoke();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['drain']);
  release();
  await installing;
  assert.deepEqual(calls, ['drain', 'drained', 'install']);
});

test('exhausting the restart circuit also fails close explicitly', async () => {
  let starts = 0;
  const client = createWriterWorkerClient({ maxRestarts: 2, workerFactory: () => {
    starts++;
    const worker = new EventEmitter();
    worker.terminate = async () => {};
    worker.postMessage = () => queueMicrotask(() => worker.emit('exit', 17));
    queueMicrotask(() => worker.emit('message', { ready: true, settings: [] }));
    return worker;
  } });
  await client.ready;
  for (let attempt = 0; attempt < 3; attempt++) await assert.rejects(client.request('toggleStar', 'id'), /unknown/);
  await assert.rejects(client.request('setSetting', 'late', 1), /exited|shut/);
  await assert.rejects(client.close(), /circuit is open/);
  assert.equal(starts, 3);
});

test('forced writer termination rejects queued work and never recovers its restart circuit', async () => {
  let current, starts = 0;
  const client = createWriterWorkerClient({ workerFactory: () => {
    starts++;
    current = new EventEmitter();
    current.terminate = () => Promise.resolve();
    current.postMessage = () => {};
    queueMicrotask(() => current.emit('message', { ready: true, settings: [] }));
    return current;
  } });
  await client.ready;
  const crashed = client.request('setSetting', 'crashed', 1);
  current.emit('exit', 17);
  await assert.rejects(crashed, /unknown/);
  const jobs = Array.from({ length: 40 }, (_, i) => client.request('setSetting', 'pending:' + i, i));
  const rejections = Promise.all(jobs.map(job => assert.rejects(job, /shut down.*unknown/)));
  const stopped = client.terminate();
  await rejections;
  await assert.rejects(client.request('setSetting', 'late', 1), /shut down/);
  await stopped;
  assert.equal(starts, 1, 'termination clears the scheduled restart');
});

test('forced termination rejects bootstrap and queued callers before a stuck worker terminates', async () => {
  let release, terminated = 0;
  const terminating = new Promise(resolve => { release = resolve; });
  const client = createWriterWorkerClient({ workerFactory: () => {
    const worker = new EventEmitter();
    worker.postMessage = () => {};
    worker.terminate = () => { terminated++; return terminating; };
    return worker;
  } });
  const waiting = assert.rejects(client.ready, /shut down.*unknown/);
  const jobs = Array.from({ length: 40 }, (_, i) => assert.rejects(client.request('setSetting', 'pending:' + i, i), /shut down.*unknown/));
  const stopped = client.terminate();
  await Promise.all([waiting, ...jobs]);
  assert.equal(terminated, 1);
  release();
  await stopped;
});
