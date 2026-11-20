'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { fixture, logicalIndex, supported } = require('./fixtures/warm-start-1144.cjs');
const sqlite = { skip: !supported && 'SQLite requires native binding or Node 22' };
const line = (cwd, content) => JSON.stringify({ type: 'user', cwd, uuid: content, timestamp: '2024-01-02T00:00:00.000Z', message: { content } }) + '\n';

for (const variant of ['zero-byte', 'no-sidechain', 'empty-content']) {
  test('null subagent cold/warm and rebuild oracle: ' + variant, sqlite, async t => {
    const f = await fixture(t);
    f.write('parent');
    const sub = path.join(f.dir, 'parent', 'subagents', 'agent-null.jsonl');
    fs.mkdirSync(path.dirname(sub), { recursive: true });
    const entry = { type: 'user', cwd: f.root, isSidechain: true, message: { content: 'indexed' } };
    fs.writeFileSync(sub, JSON.stringify(entry) + '\n');
    assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
    if (variant === 'no-sidechain') delete entry.isSidechain;
    if (variant === 'empty-content') entry.message.content = '';
    fs.writeFileSync(sub, variant === 'zero-byte' ? '' : JSON.stringify(entry) + '\n');
    assert.equal((await f.restart()).ok, true, 'warm null subagent completes');
    assert.equal(f.db.getCachedSession('sub:parent:null'), null);
    const incremental = logicalIndex(f.db);
    await f.writer.setSetting('initial_scan_complete', false);
    assert.equal((await f.restart({ force: true })).ok, true, 'cold null subagent completes');
    assert.equal(f.db.isInitialScanComplete(), true);
    assert.deepEqual(logicalIndex(f.db), incremental, 'null subagent equals full rebuild');
  });
}

test('startup replans a folder refreshed by its watcher before publication', sqlite, async t => {
  const f = await fixture(t);
  const live = f.write('live');
  const other = f.write('other');
  assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
  fs.appendFileSync(other, line(f.root, 'closed change'));
  const publish = f.writer.writeScannedFolderPartial.bind(f.writer);
  let injected = false;
  f.writer.writeScannedFolderPartial = async result => {
    if (!injected) {
      injected = true;
      fs.appendFileSync(live, line(f.root, 'live append'));
      await f.writer.refreshFolder(f.folder);
    }
    return publish(result);
  };
  assert.equal((await f.restart()).ok, true, 'same population replans a concurrent watcher refresh');
  assert.equal(f.db.getCachedSession('live').messageCount, 2);
  assert.equal(f.db.getCachedSession('other').messageCount, 2);
});

for (const at of ['beginFullIndex', 'effects']) {
  test('unrelated commits do not fence startup at ' + at, sqlite, async t => {
    const f = await fixture(t);
    const file = f.write('source');
    assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
    fs.appendFileSync(file, line(f.root, 'new content'));
    const request = f.worker.client.request;
    let injections = 0;
    f.worker.client.request = async (name, ...args) => {
      if (name === at) { injections++; await request('setSetting', 'unrelated', injections); }
      return request(name, ...args);
    };
    assert.equal((await f.restart()).ok, true, 'unrelated producer cannot fail the folder');
    assert.equal(injections, 1, 'no full rescan for unrelated commits');
  });
}

test('startup replans a row changed after begin and before effects', sqlite, async t => {
  const f = await fixture(t), file = f.write('source');
  assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
  fs.appendFileSync(file, line(f.root, 'selected change'));
  const request = f.worker.client.request;
  let injected = false;
  f.worker.client.request = async (name, ...args) => {
    if (name === 'effects' && !injected) {
      injected = true;
      fs.appendFileSync(file, line(f.root, 'later change'));
      await request('touchCachedModified', 'source', '2030-01-01T00:00:00.000Z');
    }
    return request(name, ...args);
  };
  assert.equal((await f.restart()).ok, true);
  assert.equal(f.db.getCachedSession('source').messageCount, 3, 'fresh selection must include the concurrent appended turn');
});

test('unrelated commits between startup chunks leave the folder publication intact', sqlite, async t => {
  const f = await fixture(t), file = f.write('source');
  assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
  fs.appendFileSync(file, line(f.root, 'selected change'));
  const request = f.worker.client.request;
  let armed = false, injected;
  f.worker.client.request = (name, ...args) => {
    if (name === 'effects') armed = true;
    return request(name, ...args);
  };
  t.mock.method(f.db, 'nextChunkSize', () => {
    if (armed && !injected) injected = request('setSetting', 'interleaved-setting', true);
    return 1;
  });
  assert.equal((await f.restart()).ok, true, 'an interleaved commit cannot abort later chunks');
  assert.ok(injected);
  await injected;
  assert.equal(f.scans().length, 1, 'unrelated commit does not require a new scan');
});

test('startup population has no subset deadline while its publication is pending', sqlite, async t => {
  const f = await fixture(t);
  f.write('source');
  const timeout = global.setTimeout;
  const deadlines = [];
  t.mock.method(global, 'setTimeout', (fn, ms, ...args) => {
    if (ms === 600000) deadlines.push(fn);
    return timeout(fn, ms, ...args);
  });
  assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
  assert.equal(deadlines.length, 0, 'population must not inherit the ten-minute subset deadline');
});

test('metadata derivation batches per folder and certified restarts avoid main-thread row stats', sqlite, async t => {
  const f = await fixture(t);
  for (let i = 0; i < 8; i++) f.write('name-' + i, 'summary', [{ type: 'custom-title', customTitle: 'Title ' + i }]);
  assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
  const roundtrips = f.calls.filter(call => /deriveCachedName|certifyNameDerivation/.test(call.name));
  assert.ok(roundtrips.length <= 2, 'metadata derivation needs at most two folder round trips, got ' + roundtrips.length);
  const stat = fs.statSync;
  let rowStats = 0;
  t.mock.method(fs, 'statSync', (file, ...args) => {
    if (String(file).startsWith(f.dir) && String(file).endsWith('.jsonl')) rowStats++;
    return stat(file, ...args);
  });
  assert.equal((await f.restart()).ok, true);
  assert.equal(rowStats, 0, 'a matching metadata certificate needs no main-thread transcript stat');
});

test('deleting a cached session also deletes its name certificate', sqlite, async t => {
  const f = await fixture(t);
  f.write('source');
  assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
  assert.ok(f.db.getNameDerivation('source'));
  await f.writer.deleteCachedSession('source');
  assert.equal(f.db.getNameDerivation('source'), null, 'deleted session leaves no name derivation row');
});

test('batched name derivation binds the project deletion epoch of every row', sqlite, async t => {
  const f = await fixture(t);
  f.write('source');
  assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
  const { bindDeletionProducer } = require('../src/main/projects/project-delete-writer');
  const binding = bindDeletionProducer(f.db, 'deriveCachedNames', [[{ sessionId: 'source' }]], true);
  assert.ok(binding.some(entry => entry.target === 'session:source'), 'the batched command must bind its session owner');
});

test('startup replan is bounded when the folder changes on every publication', sqlite, async t => {
  const f = await fixture(t);
  f.write('source');
  assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
  const emit = Worker.prototype.emit;
  let attempts = 0;
  t.mock.method(Worker.prototype, 'emit', function (event, message, ...args) {
    if (event === 'message' && message?.result?.startup) {
      attempts++;
      f.db.touchCachedModified('source', '2030-01-0' + attempts + 'T00:00:00.000Z');
    }
    return emit.call(this, event, message, ...args);
  });
  assert.equal((await f.restart()).ok, false);
  assert.equal(attempts, 3, 'one selection plus two bounded replans');
});
