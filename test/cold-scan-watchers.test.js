'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const openStore = require('./fixtures/conversation-store.cjs');

const FOLDER = 'C--work-live';
const FILE = '11111111-1111-4111-8111-111111111111.jsonl';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function loadWatchers(t, { coldScan }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-scan-watchers-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectsDir = path.join(root, 'projects'), codexRoot = path.join(root, 'codex');
  fs.mkdirSync(path.join(projectsDir, FOLDER), { recursive: true });
  fs.mkdirSync(codexRoot);
  const filename = path.join(__dirname, '../main.js');
  const source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf('let projectsWatcher = null;');
  const end = source.indexOf('// --- IPC: app version ---', start);
  assert.ok(start > 0 && end > start);
  const watches = [], timers = new Map(), refreshes = [], transitions = [];
  let timerId = 0;
  const codex = { id: 'codex', sessionsRoot: () => codexRoot, watchFolderKey: parts => 'codex::' + parts[0],
    folderPath: () => null, listTranscripts: () => [] };
  const context = vm.createContext({
    fs: { ...fs, watch: (watchedRoot, _opts, callback) => {
      const watcher = { root: watchedRoot, callback, closed: false, on() {}, close() { this.closed = true; } };
      watches.push(watcher);
      return watcher;
    } }, path, console, PROJECTS_DIR: projectsDir, DEFAULT_HARNESS: 'claude',
    getSetting: () => null, prefixedHarnesses: () => [codex],
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id),
    setInterval: () => 0, clearInterval() {},
    flushProjectsBeforeExit: null, localTranscriptTracker: { record() {} },
    sessionTransitions: { hasPendingLaunches: () => false },
    detectSessionTransitions: folder => transitions.push(folder), notifyRendererProjectsChanged() {},
    coldScanInFlight: () => coldScan.current,
    writer: {
      refreshFolder: (folder, opts) => { refreshes.push([folder, opts?.files ? [...opts.files] : null]); return false; },
      dropFolderRows: () => false,
    },
    log: { info() {}, warn() {}, error() {} },
  });
  vm.runInContext(source.slice(start, end), context, { filename, lineOffset: source.slice(0, start).split('\n').length - 1 });
  const runTimers = async () => {
    for (let round = 0; round < 5 && timers.size; round++) {
      const due = [...timers.values()];
      timers.clear();
      for (const callback of due) await callback();
    }
  };
  return { context, watches, refreshes, transitions, runTimers, timers };
}

test('a watcher event during the cold scan reads nothing on the main thread until the scan settles', async t => {
  const scan = deferred();
  const coldScan = { current: scan.promise };
  const w = loadWatchers(t, { coldScan });
  w.context.startProjectsWatcher();
  w.context.startHarnessWatchers();
  const projects = w.watches.find(watch => watch.root.endsWith('projects'));
  const harness = w.watches.find(watch => watch.root.endsWith('codex'));
  assert.ok(projects && harness);

  projects.callback('change', path.join(FOLDER, FILE));
  harness.callback('change', path.join('2026', FILE));
  await w.runTimers();
  assert.deepEqual(w.refreshes, [], 'no transcript of a live session is read on the main thread while the cold scan runs');
  assert.deepEqual(w.transitions, [FOLDER], 'live-session transitions are still detected at once');

  projects.callback('change', path.join(FOLDER, 'other.jsonl'));
  await w.runTimers();
  await w.context.flushProjectsBeforeExit();
  assert.deepEqual(w.refreshes, [], 'nor by a later event, nor by the flush before exit');

  coldScan.current = null;
  scan.resolve({ ok: true });
  await new Promise(resolve => setImmediate(resolve));
  await w.runTimers();
  assert.deepEqual(w.refreshes.map(([folder]) => folder).sort(), ['codex::2026', FOLDER].sort(),
    'each deferred folder is refreshed once the cold scan has settled');
  assert.deepEqual(w.refreshes.find(([folder]) => folder === FOLDER)[1].sort(), [FILE, 'other.jsonl'].sort(),
    'with every file the watcher reported, still as a targeted refresh');
});

test('outside a cold scan the watchers refresh as before', async t => {
  const w = loadWatchers(t, { coldScan: { current: null } });
  w.context.startProjectsWatcher();
  w.context.startHarnessWatchers();
  w.watches.find(watch => watch.root.endsWith('projects')).callback('change', path.join(FOLDER, FILE));
  w.watches.find(watch => watch.root.endsWith('codex')).callback('change', path.join('2026', FILE));
  await w.runTimers();
  assert.deepEqual(w.refreshes.map(([folder]) => folder).sort(), ['codex::2026', FOLDER].sort());
});

test('coldScanInFlight names the first population only, never a later rescan', { skip: !openStore.supported && 'SQLite requires native binding or Node 22' }, async t => {
  const f = await require('./fixtures/warm-start-1144.cjs').fixture(t);
  f.write('22222222-2222-4222-8222-222222222222');
  assert.equal(f.cache.coldScanInFlight(), null, 'nothing is scanning yet');
  const cold = f.cache.populateCacheViaWorker();
  assert.equal(f.cache.coldScanInFlight(), cold, 'the first population of an empty index is the cold scan');
  assert.equal((await cold).ok, true);
  assert.equal(f.cache.coldScanInFlight(), null, 'and it is over once it settles');
  const warm = f.cache.populateCacheViaWorker({ force: true });
  assert.equal(f.cache.coldScanInFlight(), null, 'a rescan of an index that finished its first scan is not a cold scan');
  assert.equal((await warm).ok, true);
});

test('a harness watcher closed after the cold scan settled never runs its set-aside refresh', async t => {
  const scan = deferred();
  const coldScan = { current: scan.promise };
  const w = loadWatchers(t, { coldScan });
  w.context.startHarnessWatchers();
  w.watches.find(watch => watch.root.endsWith('codex')).callback('change', path.join('2026', FILE));
  await w.runTimers();
  coldScan.current = null;
  scan.resolve({ ok: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(w.timers.size > 0, 'the settlement queued the replay');
  w.context.stopHarnessWatchers();
  await w.runTimers();
  assert.deepEqual(w.refreshes, [], 'the CLI was switched off before the replay ran: nothing of it is read');
});
