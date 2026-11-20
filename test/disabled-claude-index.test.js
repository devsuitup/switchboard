'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Worker } = require('node:worker_threads');
const { encodeProjectPath } = require('../encode-project-path');
const cache = require('../session-cache');
const openStore = require('./fixtures/conversation-store.cjs');
const ID = '11111111-1111-4111-8111-111111111111';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disabled-claude-'));
  const projectsDir = path.join(root, 'projects'), project = path.join(root, 'project');
  const folder = encodeProjectPath(project);
  fs.mkdirSync(project);
  fs.mkdirSync(path.join(projectsDir, folder), { recursive: true });
  const file = path.join(projectsDir, folder, ID + '.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd: project, timestamp: '2026-11-19T12:00:00Z',
    message: { role: 'user', content: 'retained Claude transcript' } }) + '\n');
  const previous = process.env.SWITCHBOARD_DATA_DIR;
  process.env.SWITCHBOARD_DATA_DIR = path.join(root, 'data');
  const db = openStore();
  cache.init({ PROJECTS_DIR: projectsDir, activeSessions: new Map(), db, getMainWindow: () => null,
    log: { info() {}, warn() {}, error() {} } });
  cache.setRemoteRoots(new Map());
  t.after(() => {
    db.closeDb();
    if (previous === undefined) delete process.env.SWITCHBOARD_DATA_DIR; else process.env.SWITCHBOARD_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, projectsDir, folder, file, db };
}

function scan(f, disabledHarnesses, extra = {}) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const worker = new Worker(path.join(__dirname, '../workers/scan-projects.js'), {
      workerData: { projectsDir: f.projectsDir, disabledHarnesses, ...extra },
      env: { ...process.env, CODEX_HOME: path.join(f.root, 'codex') },
    });
    worker.on('message', message => messages.push(message));
    worker.on('error', reject);
    worker.on('exit', code => code ? reject(new Error(`worker exit ${code}`)) : resolve(messages));
  });
}

test('disabled Claude cold scans omit valid transcripts and preserve the real cached row', { skip: !openStore.supported }, async t => {
  const f = fixture(t);
  const enabled = await scan(f, []);
  const result = enabled.find(m => m.result?.folder === f.folder)?.result;
  assert.equal(result?.sessions.length, 1, 'positive control: the worker parses the transcript');
  cache.writeScannedFolder(result);
  assert.ok(f.db.getCachedSession(ID));
  for (const extra of [{}, { folders: [f.folder] }, { folders: [], targets: [{ folder: f.folder, files: [ID + '.jsonl'], existingRows: [] }] }]) {
    const disabled = await scan(f, ['claude'], extra);
    assert.ok(disabled.some(m => m.type === 'done' && m.ok));
    assert.equal(disabled.filter(m => m.result?.folder === f.folder).length, 0,
      'a disabled CLI must not scan and emit its valid transcript');
  }
  assert.ok(f.db.getCachedSession(ID), 'disabling does not delete cached rows');
  assert.equal((await scan(f, [])).find(m => m.result?.folder === f.folder)?.result.sessions.length, 1);
});

test('disabled Claude reconciliation avoids filesystem reads and preserves rows until re-enabled', { skip: !openStore.supported }, async t => {
  const f = fixture(t);
  cache.refreshFolder(f.folder);
  f.db.setSetting('global', { disabledHarnesses: ['claude'] });
  fs.rmSync(f.file);
  const seen = [], reads = [];
  const readdir = fs.readdirSync, stat = fs.statSync;
  t.mock.method(fs, 'readdirSync', (file, ...args) => {
    if (String(file).startsWith(f.projectsDir)) reads.push(file);
    return readdir(file, ...args);
  });
  t.mock.method(fs, 'statSync', (file, ...args) => {
    if (String(file).startsWith(f.projectsDir)) reads.push(file);
    return stat(file, ...args);
  });
  cache.reconcileCacheFromFilesystem({ throttle: false, onFolder: folder => seen.push(folder) });
  await cache.reconcileCacheFromFilesystemAsync({ throttle: false, onFolder: folder => seen.push(folder) });
  assert.deepEqual(seen, [], 'disabled Claude is absent from both reconciliation paths');
  assert.deepEqual(reads, [], 'disabled reconciliation does not list or stat Claude transcripts');
  assert.ok(f.db.getCachedSession(ID), 'a vanished transcript keeps its cached row while disabled');
  f.db.setSetting('global', { disabledHarnesses: [] });
  cache.reconcileCacheFromFilesystem({ throttle: false });
  assert.equal(f.db.getCachedSession(ID), null, 're-enabling reconciles the vanished transcript');
});

test('Claude watcher closes on disable, discards queued work and starts again on enable', { skip: !openStore.supported }, async t => {
  const f = fixture(t);
  cache.refreshFolder(f.folder);
  const filename = path.join(__dirname, '../main.js');
  const source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf('let projectsWatcher = null;');
  const end = source.indexOf('// --- IPC: app version ---', start);
  assert.ok(start > 0 && end > start);
  const watches = [], timers = new Map();
  let timerId = 0;
  const writes = [];
  const context = vm.createContext({
    fs: { ...fs, watch: (_root, _opts, callback) => {
      const watcher = { callback, closed: false, on() {}, close() { this.closed = true; } };
      watches.push(watcher);
      return watcher;
    } }, path, console, PROJECTS_DIR: f.projectsDir, DEFAULT_HARNESS: 'claude',
    getSetting: f.db.getSetting, prefixedHarnesses: () => [],
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id),
    flushProjectsBeforeExit: null, localTranscriptTracker: { record() {} },
    detectSessionTransitions() {}, notifyRendererProjectsChanged() {},
    writer: { refreshFolder: folder => { writes.push(folder); return cache.refreshFolder(folder); },
      dropFolderRows: folder => { writes.push(folder); return cache.dropFolderRows(folder); } },
    log: { info() {}, error() {} },
  });
  vm.runInContext(source.slice(start, end), context, { filename, lineOffset: source.slice(0, start).split('\n').length - 1 });
  context.startProjectsWatcher();
  assert.equal(watches.length, 1);
  watches[0].callback('change', path.join(f.folder, ID + '.jsonl'));
  f.db.setSetting('global', { disabledHarnesses: ['claude'] });
  context.restartHarnessWatchers();
  assert.equal(watches[0].closed, true, 'switching Claude off closes its watcher');
  assert.equal(watches.length, 1, 'disabled Claude never opens a replacement watcher');
  fs.rmSync(f.file);
  for (const callback of timers.values()) await callback();
  await context.flushProjectsBeforeExit();
  assert.deepEqual(writes, [], 'a queued refresh cannot delete a disabled CLI row');
  assert.ok(f.db.getCachedSession(ID));
  f.db.setSetting('global', { disabledHarnesses: [] });
  context.restartHarnessWatchers();
  assert.equal(watches.length, 2, 're-enabling resumes watching');
  for (const callback of timers.values()) await callback();
  watches[0].callback('change', path.join(f.folder, ID + '.jsonl'));
  await context.flushProjectsBeforeExit();
  assert.deepEqual(writes, [], 'callbacks from the old watcher stay inert after re-enabling');
  watches[1].callback('change', path.join(f.folder, ID + '.jsonl'));
  await context.flushProjectsBeforeExit();
  assert.deepEqual(writes, [f.folder]);
  assert.equal(f.db.getCachedSession(ID), null);
});
