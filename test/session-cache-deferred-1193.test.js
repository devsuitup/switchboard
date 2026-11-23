'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const base = require('./fixtures/warm-start-1144.cjs');
const codex = require('./fixtures/warm-start-1152.cjs');
const options = { skip: !base.supported && 'SQLite fixture unavailable on Node 20' };
require('./fixtures/isolated-codex-home.cjs')(test);

function timers(t) {
  const pending = new Map();
  const timeout = global.setTimeout, clear = global.clearTimeout;
  t.mock.method(global, 'setTimeout', (fn, ms, ...args) => {
    if (String(fn).includes('populateCacheViaWorker')) {
      const token = { unref() {} };
      pending.set(token, { fn, ms });
      return token;
    }
    return timeout(fn, ms, ...args);
  });
  t.mock.method(global, 'clearTimeout', token => { pending.delete(token); return clear(token); });
  return { pending, async fire() {
    assert.equal(pending.size, 1, 'every deferred folder must reach the in-run retry timer');
    const [token, timer] = pending.entries().next().value;
    pending.delete(token);
    return timer.fn();
  } };
}

async function setup(t, runtime = 'claude') {
  const f = await (runtime === 'codex' ? codex : base).fixture(t);
  const folder = runtime === 'codex' ? f.codexFolder : f.folder;
  let file, id;
  if (runtime === 'codex') { file = f.codexWrite(0); id = f.ids[0]; f.codexWrite(1); }
  else {
    f.write('neighbor');
    if (runtime === 'subagent') {
      f.write('parent');
      file = path.join(f.dir, 'parent', 'subagents', 'agent-failed.jsonl');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd: f.root, isSidechain: true, message: { content: 'original' } }) + '\n');
      id = 'sub:parent:failed';
    } else { file = f.write('failed'); id = 'failed'; }
  }
  assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
  const warnings = [];
  const initialize = () => f.writer.initializeCache({ PROJECTS_DIR: f.projects, activeSessions: f.activeSessions,
    getMainWindow: () => null, log: { info: line => f.logs.push(line), warn: line => warnings.push(line), error() {} } });
  initialize();
  f.logs.length = 0;
  fs.appendFileSync(file, '\n');
  return { f, file, id, folder, warnings, initialize };
}

function failReads(t, f, files, code = 'EBUSY', count = Infinity) {
  const emit = Worker.prototype.emit;
  const failures = new Set(files);
  let attempts = 0;
  t.mock.method(Worker.prototype, 'emit', function (event, msg, ...args) {
    const dir = msg?.result?.startup && require('../src/main/session-index/full-read-state').startupFolderPath(f.projects, msg.result.folder);
    if (event === 'message' && dir && files.some(file => file.startsWith(dir + path.sep)) && attempts < count) {
      const open = fs.openSync;
      const read = fs.readSync, handles = new Set();
      const patch = t.mock.method(fs, 'openSync', function (file, ...rest) {
        if (failures.has(file) && /at (?:Object\.)?readSessionFile /.test(new Error().stack)) {
          if (code === 'short') { const fd = open.call(this, file, ...rest); handles.add(fd); return fd; }
          throw Object.assign(new Error('private content and ' + file), { code });
        }
        const fd = open.call(this, file, ...rest);
        handles.delete(fd);
        return fd;
      });
      const readPatch = t.mock.method(fs, 'readSync', function (fd, ...rest) {
        return handles.has(fd) ? 0 : read.call(this, fd, ...rest);
      });
      try {
        const replacement = codex.scan({ projectsDir: f.projects, inventory: [msg.result.inventory],
          scope: [msg.result.folder], disabledHarnesses: [], force: msg.result.reason === 'forced' })
          .find(item => item.result);
        if (replacement) { msg = { ...msg, ...replacement }; attempts++; }
      } finally { patch.mock.restore(); readPatch.mock.restore(); }
    }
    return emit.call(this, event, msg, ...args);
  });
}

for (const runtime of ['claude', 'subagent', 'codex']) {
  test(runtime + ': deferred read is retried in the same run, with certified neighbors skipped', options, async t => {
    const { f, file, id, folder } = await setup(t, runtime);
    f.db.connection.prepare('UPDATE cache_meta SET fullIndexVersion = NULL WHERE folder = ?').run(folder);
    const clock = timers(t);
    failReads(t, f, [file], 'EBUSY', 1);
    assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
    assert.equal(f.db.getCachedSession(id).fullReadStamp, null);
    assert.equal(f.db.getFolderMeta(folder).fullIndexPending, null, 'acknowledged partial state is sealed');
    assert.equal(f.db.getFolderMeta(folder).fullIndexVersion, 1);
    assert.equal((await clock.fire()).ok, true);
    assert.ok(f.db.getCachedSession(id).fullReadStamp, 'retry certifies the recovered source');
    assert.equal(f.scans().at(-1).filesRead, 1, 'retry does not read certified neighbors');
    assert.equal(clock.pending.size, 0, 'recovery disarms retry');
    await base.assertRebuildOracle(t, f);
  });

  test(runtime + ': reopening after a transient failure reads only the failed source', options, async t => {
    const { f, file, id, folder } = await setup(t, runtime);
    f.db.connection.prepare('UPDATE cache_meta SET fullIndexVersion = NULL WHERE folder = ?').run(folder);
    timers(t);
    failReads(t, f, [file], 'EACCES', 1);
    assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
    assert.equal(f.db.getCachedSession(id).fullReadStamp, null);
    await f.reopen();
    assert.equal((await f.restart()).ok, true);
    assert.equal(f.scans().find(scan => scan.folder === folder).filesRead, 1, 'reopen must not reread the whole folder');
    await base.assertRebuildOracle(t, f);
  });
}

test('deferred retries use the bounded backoff and force resets it', options, async t => {
  const { f, file } = await setup(t);
  const clock = timers(t);
  failReads(t, f, [file]);
  assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
  for (const delay of [30000, 120000, 600000]) {
    assert.equal(clock.pending.size, 1, 'a transient failure must schedule a retry');
    const timer = [...clock.pending.values()][0];
    assert.ok(timer.ms <= delay && timer.ms >= delay - 1000);
    assert.equal((await clock.fire()).ok, true);
  }
  assert.equal(clock.pending.size, 0, 'no unbounded retry loop');
  assert.equal((await f.cache.populateCacheViaWorker()).ok, false, 'automatic callers respect exhausted budget');
  assert.equal((await f.cache.populateCacheViaWorker({ force: true })).ok, true);
  assert.equal(clock.pending.size, 1, 'force starts a fresh retry budget');
  await f.cache.shutdownProducers();
  assert.equal(clock.pending.size, 0, 'shutdown cancels the retry');
});

for (const runtime of ['claude', 'subagent', 'codex']) for (const error of ['EBUSY', 'short']) {
  test(runtime + ': each failed body read logs one private-path-free warning: ' + error, options, async t => {
    const { f, file, folder, warnings } = await setup(t, runtime);
    timers(t);
    failReads(t, f, [file], error);
    assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
    assert.deepEqual(warnings, [`[index] read failed folder=${folder} file=${path.basename(file)} size=${fs.statSync(file).size} error=${error === 'short' ? 'ERR_JSONL_SHORT_READ' : error}`]);
    assert.equal(f.logs.some(line => line.includes('transcript-read-failed')), false);
  });
}

test('all deferred folders join writer failures in one scoped retry', options, async t => {
  const { f, file, folder } = await setup(t);
  const { encodeProjectPath } = require('../encode-project-path');
  const addFolder = name => {
    const cwd = path.join(f.root, name), key = encodeProjectPath(cwd), dir = path.join(f.projects, key);
    fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, name + '.jsonl');
    fs.writeFileSync(target, JSON.stringify({ type: 'user', cwd, uuid: name, message: { content: name } }) + '\n');
    return { file: target, folder: key };
  };
  const second = addFolder('second'), writerFailure = addFolder('writer'), healthy = addFolder('healthy');
  assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
  for (const target of [file, second.file, writerFailure.file]) fs.appendFileSync(target, '\n');
  const clock = timers(t);
  failReads(t, f, [file, second.file], 'EIO', 2);
  const publish = f.writer.writeScannedFolderPartial.bind(f.writer);
  let failed = false;
  f.writer.writeScannedFolderPartial = result => {
    if (result.folder === writerFailure.folder && !failed) { failed = true; throw new Error('synthetic writer failure'); }
    return publish(result);
  };
  assert.equal((await f.cache.populateCacheViaWorker()).ok, false);
  f.logs.length = 0;
  assert.equal((await clock.fire()).ok, true);
  assert.deepEqual(f.scans().map(scan => scan.folder).sort(), [folder, second.folder, writerFailure.folder].sort());
  assert.equal(f.scans().some(scan => scan.folder === healthy.folder), false);
  assert.ok(f.db.getCachedSession('failed').fullReadStamp);
  assert.ok(f.db.getCachedSession('second').fullReadStamp);
  assert.equal(clock.pending.size, 0);
  await base.assertRebuildOracle(t, f);
});
