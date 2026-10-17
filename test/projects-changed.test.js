'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { encodeProjectPath } = require('../encode-project-path');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-changed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = encodeProjectPath(root);
  const directory = path.join(root, folder);
  fs.mkdirSync(directory);
  const rows = new Map(), meta = new Map(), folders = new Map();
  const db = {
    getCachedByFolder: key => [...rows.values()].filter(row => row.folder === key),
    getAllCached: () => [...rows.values()], getAllMeta: () => meta,
    getMeta: id => meta.get(id), getCachedSession: id => rows.get(id),
    getFolderMeta: key => folders.get(key), getAllFolderMeta: () => folders,
    getSetting: () => null, isInitialScanComplete: () => true,
    upsertCachedSessions: values => values.forEach(row => rows.set(row.sessionId, { ...row })),
    deleteCachedSession: id => rows.delete(id),
    deleteCachedFolder: key => { for (const row of db.getCachedByFolder(key)) rows.delete(row.sessionId); folders.delete(key); },
    setFolderMeta: (key, projectPath, indexMtimeMs) => folders.set(key, { projectPath, indexMtimeMs }),
    setName: (id, name) => meta.set(id, { ...meta.get(id), name }),
    touchCachedModified: (id, modified) => Object.assign(rows.get(id), { modified, fileMtime: modified }),
    replaceSessionMetrics() {}, deleteSearchFolder() {}, deleteSearchSession() {}, upsertSearchEntries() {},
  };
  const sent = [], traced = [], timers = [];
  let now = 0;
  const scheduled = new Map();
  const clock = {
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...scheduled].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        now = next[1].at;
        scheduled.delete(next[0]);
        next[1].callback();
      }
      now = end;
    },
    scheduled,
  };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const traceState = { on: true };
  const filename = path.join(__dirname, '../session-cache.js');
  const localRequire = createRequire(filename);
  const context = { module: { exports: {} }, __dirname: path.dirname(filename), console, Buffer, Set, Map, Date: ClockDate,
    require: name => name === './activity-trace' ? { state: traceState, trace: (...args) => traced.push(args) } : localRequire(name),
    setTimeout: (callback, delay) => {
      const timer = { unrefed: false, unref() { this.unrefed = true; } };
      const run = () => { scheduled.delete(timer); callback(); };
      scheduled.set(timer, { callback: run, at: now + delay });
      timers.push(run);
      return timer;
    },
    clearTimeout: timer => scheduled.delete(timer), setImmediate,
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const cache = context.module.exports;
  cache.init({ PROJECTS_DIR: root, activeSessions: new Map(), db, log: console,
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (...args) => sent.push(args) } }),
  });
  let watched;
  const mainFile = path.join(__dirname, '../main.js');
  const main = fs.readFileSync(mainFile, 'utf8');
  const watcher = { PROJECTS_DIR: root, path, Set, Map, console, log: console,
    fs: { ...fs, watch: (_dir, _options, callback) => { watched = callback; return { on() {} }; } },
    writer: { refreshFolder: async (...args) => cache.refreshFolder(...args), dropFolderRows: async (...args) => cache.dropFolderRows(...args) },
    detectSessionTransitions() {}, localTranscriptTracker: { record() {} },
    notifyRendererProjectsChanged: (...args) => cache.notifyRendererProjectsChanged(...args),
    setTimeout: () => 1, clearTimeout() {}, projectsWatcher: null, flushProjectsBeforeExit: null,
  };
  const start = main.indexOf('function startProjectsWatcher()');
  const end = main.indexOf('// --- IPC: app version', start);
  vm.runInNewContext(main.slice(start, end) + '\nstartProjectsWatcher();', watcher, { filename: mainFile });
  function write(id, extra = []) {
    const file = path.join(directory, id + '.jsonl');
    fs.writeFileSync(file, [JSON.stringify({ type: 'user', cwd: root, message: { role: 'user', content: 'hello' } }),
      ...extra.map(line => JSON.stringify(line))].join('\n') + '\n');
    fs.utimesSync(file, new Date('2030-01-01'), new Date('2030-01-01'));
    return file;
  }
  return { cache, rows, meta, folders, folder, directory, write, sent, traced, timers, traceState, clock,
    async event(relative = 'one.jsonl') { watched('change', path.join(folder, relative)); await watcher.flushProjectsBeforeExit(); },
    async folderEvent() { watched('rename', folder); await watcher.flushProjectsBeforeExit(); },
  };
}

test('watcher skips unchanged rows and continuation bookkeeping with the same display fields', async t => {
  const f = fixture(t);
  f.write('one');
  f.cache.refreshFolder(f.folder);
  await f.event();
  assert.equal(f.sent.length, 0, 'an unchanged transcript must not reload projects');
  f.write('one', [{ type: 'system', content: 'internal bookkeeping' }]);
  await f.event();
  assert.equal(f.sent.length, 0, 'internal continuation stamps must not reload projects');
});

test('watcher sends a new row and a same-mtime transcript rename with the watcher cause', async t => {
  const f = fixture(t);
  f.write('one');
  await f.event();
  assert.equal(f.sent.length, 1);
  assert.deepEqual(Array.from(f.sent[0][1].cause), ['watcher']);
  f.timers.shift()();
  f.write('one', [{ type: 'custom-title', customTitle: 'Renamed' }]);
  await f.event();
  assert.equal(f.sent.length, 2);
  assert.equal(f.meta.get('one').name, 'Renamed');
});

for (const [field, line] of [
  ['slug', { type: 'system', slug: 'different-group' }],
  ['scheduleSlug', { type: 'user', scheduleSlug: 'daily-check' }],
  ['aiTitle', { type: 'ai-title', aiTitle: 'New title' }],
]) {
  test(`watcher notifies when ${field} changes without an mtime change`, async t => {
    const f = fixture(t);
    f.write('one');
    assert.equal(f.cache.refreshFolder(f.folder), true);
    assert.equal(f.cache.refreshFolder(f.folder), false);
    f.write('one', [line]);
    await f.event();
    assert.equal(f.sent.length, 1);
    assert.ok(f.rows.get('one')[field]);
  });
}

test('watcher coalesces repeated activity-only flushes across 30 seconds', async t => {
  const f = fixture(t);
  const file = f.write('one');
  f.cache.refreshFolder(f.folder);
  for (let step = 0; step < 20; step++) {
    if (step) f.clock.advance(1500);
    const modified = new Date(Date.UTC(2030, 0, 2) + step * 1500);
    fs.utimesSync(file, modified, modified);
    await f.event();
    assert.equal(f.sent.length, 0, 'activity must not trigger the 1.5-second reload');
    assert.equal(f.rows.get('one').modified, modified.toISOString(), 'cache writes stay current');
  }
  f.clock.advance(1499);
  assert.equal(f.sent.length, 0);
  f.clock.advance(1);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(Array.from(f.sent[0][1].cause), ['activity']);
  assert.deepEqual(Array.from(f.traced[0][2].cause), ['activity']);
});

test('a structural change satisfies pending activity without a second reload', async t => {
  const f = fixture(t);
  const file = f.write('one');
  f.cache.refreshFolder(f.folder);
  fs.utimesSync(file, new Date('2030-01-02'), new Date('2030-01-02'));
  await f.event();
  assert.equal(f.sent.length, 0);
  f.clock.advance(10000);
  f.write('one', [{ type: 'custom-title', customTitle: 'Renamed during activity' }]);
  await f.event();
  assert.equal(f.sent.length, 1);
  assert.deepEqual(Array.from(f.sent[0][1].cause), ['watcher']);
  assert.equal(f.meta.get('one').name, 'Renamed during activity');
  f.clock.advance(30000);
  assert.equal(f.sent.length, 1, 'the structural reload satisfies pending activity');
});

test('activity timer is unrefed and cleared on producer shutdown', async t => {
  const f = fixture(t);
  f.cache.notifyRendererProjectsChanged('activity');
  assert.equal(f.sent.length, 0);
  assert.equal(f.clock.scheduled.size, 1);
  assert.ok([...f.clock.scheduled.keys()].every(timer => timer.unrefed));
  await f.cache.shutdownProducers();
  assert.equal(f.clock.scheduled.size, 0);
  f.clock.advance(60000);
  assert.equal(f.sent.length, 0);
});

test('activity-only notifications remain at least 30 seconds apart', t => {
  const f = fixture(t);
  f.cache.notifyRendererProjectsChanged('activity');
  f.clock.advance(30000);
  assert.equal(f.sent.length, 1);
  f.cache.notifyRendererProjectsChanged('activity');
  f.clock.advance(29999);
  assert.equal(f.sent.length, 1);
  f.clock.advance(1);
  assert.equal(f.sent.length, 2);
  assert.deepEqual(Array.from(f.sent[1][1].cause), ['activity']);
});

test('an unrelated structural cause satisfies pending activity', t => {
  const f = fixture(t);
  f.cache.notifyRendererProjectsChanged('activity');
  f.clock.advance(10000);
  f.cache.notifyRendererProjectsChanged('cli-status');
  assert.equal(f.sent.length, 1);
  assert.deepEqual(Array.from(f.sent[0][1].cause), ['cli-status']);
  f.clock.advance(30000);
  assert.equal(f.sent.length, 1);
});

test('a trailing structural emission satisfies activity requested during cooldown', t => {
  const f = fixture(t);
  f.cache.notifyRendererProjectsChanged('watcher');
  f.clock.advance(500);
  f.cache.notifyRendererProjectsChanged('activity');
  f.cache.notifyRendererProjectsChanged('archive');
  assert.equal(f.sent.length, 1);
  f.clock.advance(1000);
  assert.equal(f.sent.length, 2);
  assert.deepEqual(Array.from(f.sent[1][1].cause), ['archive']);
  f.clock.advance(30000);
  assert.equal(f.sent.length, 2);
});

test('watcher skips an internal file-mtime repair when displayed fields stay unchanged', async t => {
  const f = fixture(t);
  f.write('one');
  f.cache.refreshFolder(f.folder);
  f.rows.get('one').fileMtime = '2020-01-01T00:00:00.000Z';
  f.rows.get('one').continuationIndex = JSON.stringify({ ...JSON.parse(f.rows.get('one').continuationIndex),
    mtime: '2020-01-01T00:00:00.000Z' });
  await f.event();
  assert.equal(f.sent.length, 0);
  assert.equal(f.rows.get('one').fileMtime, '2030-01-01T00:00:00.000Z');
});

test('watcher sends a continuation graph change at the same displayed timestamp', async t => {
  const f = fixture(t);
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  f.write(id);
  f.cache.refreshFolder(f.folder);
  f.write(id, [{ type: 'continued-in', sessionId: id, continuedInSessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }]);
  await f.event(id + '.jsonl');
  assert.equal(f.sent.length, 1);
  assert.deepEqual(JSON.parse(f.rows.get(id).continuationIndex).ids, ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']);
});

test('watcher removes rows but ignores an already empty missing folder', async t => {
  const f = fixture(t);
  const file = f.write('one');
  f.cache.refreshFolder(f.folder);
  fs.unlinkSync(file);
  await f.event();
  assert.equal(f.sent.length, 1);
  f.timers.shift()();
  fs.rmSync(f.directory, { recursive: true });
  await f.folderEvent();
  assert.equal(f.sent.length, 2, 'the cached empty project disappeared');
  f.timers.shift()();
  await f.folderEvent();
  assert.equal(f.sent.length, 2, 'no cached row or project changed');
});

test('notifier traces and sends distinct causes coalesced over the trailing throttle window', t => {
  const f = fixture(t);
  f.cache.notifyRendererProjectsChanged('watcher');
  f.cache.notifyRendererProjectsChanged('bg-jobs');
  f.cache.notifyRendererProjectsChanged('cli-status');
  f.cache.notifyRendererProjectsChanged('bg-jobs');
  assert.equal(f.sent.length, 1);
  f.timers.shift()();
  assert.equal(f.sent.length, 2);
  assert.deepEqual(Array.from(f.sent[1][1].cause), ['bg-jobs', 'cli-status']);
  assert.equal(f.traced[1][0], 'projects.changed');
  assert.deepEqual(Array.from(f.traced[1][2].cause), ['bg-jobs', 'cli-status']);
  f.timers.shift()();
  f.traceState.on = false;
  f.cache.notifyRendererProjectsChanged('archive');
  assert.equal(f.traced.length, 2);
  assert.equal(f.sent.length, 3);
});
