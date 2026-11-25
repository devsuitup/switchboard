'use strict';
const { SESSION_CONTENT_INDEX_VERSION: CONTENT_VERSION } = require('../src/main/session-index/full-read-state');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = require('./fixtures/warm-start-1144.cjs');
const options = { skip: !base.supported && 'SQLite fixture unavailable on Node 20' };
require('./fixtures/isolated-codex-home.cjs')(test);

const { timers, setup, failReads } = require('./fixtures/deferred-1193.cjs');

for (const runtime of ['claude', 'subagent', 'codex']) {
  test(runtime + ': deferred read is retried in the same run, with certified neighbors skipped', options, async t => {
    const { f, file, id, folder } = await setup(t, runtime);
    f.db.connection.prepare('UPDATE cache_meta SET fullIndexVersion = NULL WHERE folder = ?').run(folder);
    const clock = timers(t);
    failReads(t, f, [file], 'EBUSY', 1);
    assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
    assert.equal(f.db.getCachedSession(id).fullReadStamp, null);
    assert.equal(f.db.getFolderMeta(folder).fullIndexPending, null, 'acknowledged partial state is sealed');
    assert.equal(f.db.getFolderMeta(folder).fullIndexVersion, CONTENT_VERSION);
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
  assert.equal((await f.cache.populateCacheViaWorker()).ok, true, 'successful exhaustion must admit later non-forced populates');
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
    const name = runtime === 'subagent' ? 'parent/' + path.basename(file) : path.basename(file);
    assert.deepEqual(warnings, [`[index] read failed folder=${folder} file=${name} size=${fs.statSync(file).size} error=${error === 'short' ? 'ERR_JSONL_SHORT_READ' : error}`]);
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
