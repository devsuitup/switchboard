'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { fixture, assertRebuildOracle, supported } = require('./fixtures/warm-start-1144.cjs');
const { folderReadWitness } = require('../src/main/session-index/full-read-state');
const sqlite = { skip: !supported && 'SQLite requires native binding or Node 22' };
const line = (cwd, content) => JSON.stringify({ type: 'user', cwd, uuid: content, timestamp: '2024-01-02T00:00:00.000Z', message: { content } }) + '\n';

for (const phase of ['cold', 'warm']) {
  for (const timing of ['late', 1, 50]) test('source append during ' + phase + ' population: ' + timing, sqlite, async t => {
    const f = await fixture(t);
    const live = f.write('live');
    for (let i = 0; i < (timing === 50 ? 120 : 30); i++) f.write('other' + i, 'x'.repeat(4000));
    if (phase === 'warm') {
      assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
      fs.appendFileSync(live, line(f.root, 'closed change'));
    }
    const emit = Worker.prototype.emit;
    let appends = 0, timer;
    const append = () => fs.appendFileSync(live, line(f.root, 'append-' + appends++));
    t.mock.method(Worker.prototype, 'emit', function (event, msg, ...args) {
      if (event === 'message' && msg?.result?.startup) append();
      return emit.call(this, event, msg, ...args);
    });
    if (typeof timing === 'number') timer = setInterval(append, timing);
    let result;
    try { result = phase === 'cold' ? await f.cache.populateCacheViaWorker() : await f.restart(); }
    finally { clearInterval(timer); t.mock.restoreAll(); }
    assert.ok(appends > 0);
    assert.equal(result.ok, true, phase + ' population completes while a transcript changes');
    assert.equal(f.db.isInitialScanComplete(), true, 'raced folder counts towards initial population');
    const meta = f.db.getFolderMeta(f.folder);
    assert.equal(meta.fullIndexPending, null, 'raced folder seals stable neighbors');
    assert.equal(meta.fullIndexVersion, 1);
    assert.equal(f.db.getCachedSession('live').fullReadStamp, null);
    assert.ok(f.db.getCachedSession('live'), 'raced transcript remains visible');
    assert.equal(f.db.getCachedByFolder(f.folder).length, timing === 50 ? 121 : 31, 'stable neighbors are published');
    assert.equal((await f.restart()).ok, true, 'quiescent warm restart completes');
    assert.equal(f.scans()[0].filesRead, 1, 'warm restart rereads only the live file');
    await assertRebuildOracle(t, f);
  });
}

for (const ms of [200, 30]) test('watcher refreshes live folder every ' + ms + 'ms during startup', sqlite, async t => {
  const f = await fixture(t), live = f.write('live');
  for (let i = 0; i < 20; i++) f.write('other' + i, 'y'.repeat(3000));
  assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
  for (let i = 0; i < 5; i++) fs.appendFileSync(path.join(f.dir, 'other' + i + '.jsonl'), line(f.root, 'closed-' + i));
  let stop = false, refreshes = 0;
  const loop = (async () => {
    while (!stop) {
      fs.appendFileSync(live, line(f.root, 'live-' + refreshes));
      await f.writer.refreshFolder(f.folder);
      refreshes++;
      await new Promise(resolve => setTimeout(resolve, ms));
    }
  })();
  let result;
  try { result = await f.restart(); }
  finally { stop = true; await loop; }
  assert.ok(refreshes > 0);
  assert.equal(result.ok, true, 'warm start completes while the live folder is refreshed: ' + JSON.stringify({ result, scans: f.scans() }));
  assert.equal((await f.restart()).ok, true);
  await assertRebuildOracle(t, f);
});

for (const at of ['publication', 'beginFullIndex', 'effects']) test('unselected header refresh does not fence ' + at, sqlite, async t => {
  const f = await fixture(t), other = f.write('other');
  f.write('live');
  assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
  fs.appendFileSync(other, line(f.root, 'closed'));
  let refreshes = 0;
  const touch = () => f.db.touchCachedModified('live', '2030-01-01T00:00:' + String(refreshes++).padStart(2, '0') + '.000Z');
  if (at === 'publication') {
    const emit = Worker.prototype.emit;
    t.mock.method(Worker.prototype, 'emit', function (event, msg, ...args) {
      if (event === 'message' && msg?.result?.startup) touch();
      return emit.call(this, event, msg, ...args);
    });
  } else {
    const request = f.worker.client.request;
    f.worker.client.request = async (name, ...args) => {
      if (name === at) touch();
      return request(name, ...args);
    };
  }
  assert.equal((await f.restart()).ok, true, 'unselected headers cannot exhaust startup replans');
  assert.equal(refreshes, 1, 'no retry for an unselected header');
  assert.equal(f.db.getCachedSession('other').messageCount, 2);
});

test('readonly and writable connections produce identical folder witnesses', sqlite, async t => {
  const f = await fixture(t, { separateReader: true });
  f.write('source');
  assert.notEqual(f.reader.connection, f.db.connection);
  assert.equal((await f.cache.populateCacheViaWorker()).ok, true, 'quiet cold scan has no WRITER_STALE');
  assert.equal(folderReadWitness(f.reader, f.folder), folderReadWitness(f.db, f.folder), 'witness bytes agree across connections');
  fs.appendFileSync(path.join(f.dir, 'source.jsonl'), line(f.root, 'quiet append'));
  assert.equal((await f.restart()).ok, true, 'quiet warm scan has no WRITER_STALE');
  assert.equal(f.db.getCachedSession('source').messageCount, 2);
});

test('watcher publishes a new session without sealing a marked repair', sqlite, async t => {
  const f = await fixture(t);
  f.write('source');
  assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
  await f.writer.setSetting('bridge_uuid_reindex_folders', [f.folder]);
  f.write('new');
  assert.equal(await f.writer.refreshFolder(f.folder, { files: new Set(['new.jsonl']) }), true);
  assert.ok(f.db.getCachedSession('new'));
  assert.deepEqual(Array.from(f.db.getSetting('bridge_uuid_reindex_folders')), [f.folder]);
  assert.equal(f.db.getFolderMeta(f.folder).fullIndexVersion, null, 'a watcher must leave a marked repair unsealed');
});

test('shutdown during stale publication never starts a retry scan', sqlite, async t => {
  const f = await fixture(t);
  f.write('source');
  assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
  fs.appendFileSync(path.join(f.dir, 'source.jsonl'), line(f.root, 'selected'));
  const emit = Worker.prototype.emit;
  let selections = 0, shutdown;
  t.mock.method(Worker.prototype, 'emit', function (event, msg, ...args) {
    if (event === 'message' && msg?.result?.startup) {
      selections++;
      f.db.touchCachedModified('source', '2030-01-01T00:00:00.000Z');
      shutdown ||= f.cache.shutdownProducers();
    }
    return emit.call(this, event, msg, ...args);
  });
  const result = await f.restart();
  await shutdown;
  assert.equal(result.ok, false);
  assert.equal(selections, 1, 'shutdown must prevent a fresh retry worker');
});

test('snapshot failure during replan does not abandon later folders', sqlite, async t => {
  const f = await fixture(t);
  f.write('source');
  assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
  fs.appendFileSync(path.join(f.dir, 'source.jsonl'), line(f.root, 'selected'));
  const otherRoot = path.join(f.root, 'second');
  fs.mkdirSync(otherRoot);
  const folder = require('../encode-project-path').encodeProjectPath(otherRoot);
  fs.mkdirSync(path.join(f.projects, folder));
  fs.writeFileSync(path.join(f.projects, folder, 'second.jsonl'), line(otherRoot, 'second'));
  const emit = Worker.prototype.emit;
  const all = f.db.getAllCached;
  let failing = false;
  t.mock.method(f.db, 'getAllCached', () => {
    if (failing) { failing = false; throw new Error('injected retry snapshot failure'); }
    return all();
  });
  t.mock.method(Worker.prototype, 'emit', function (event, msg, ...args) {
    if (event === 'message' && msg?.result?.folder === f.folder) {
      f.db.touchCachedModified('source', '2030-01-01T00:00:00.000Z');
      failing = true;
    }
    return emit.call(this, event, msg, ...args);
  });
  const result = await f.restart();
  assert.equal(result.ok, false);
  assert.ok(f.db.getCachedSession('second'), 'later folder is published after a failed retry snapshot');
  assert.deepEqual(result.failedFolders, [f.folder], 'failure retains its folder scope');
});
