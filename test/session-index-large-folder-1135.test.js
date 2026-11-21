'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { fixture, supported } = require('./fixtures/warm-start-1144.cjs');
const { createWriterWorkerClient } = require('../session-index-writer-client');
const { createWorker } = require('./fixtures/project-deletion-worker.cjs');
const sqlite = { skip: !supported && 'SQLite requires native binding or Node 22' };

async function loadFixture(t) {
  const f = await fixture(t, { separateReader: true });
  const client = createWriterWorkerClient({ workerFactory: () => createWorker(f.db), timeoutMs: 300000, heartbeatMs: 300000 });
  await client.ready;
  f.worker.client.request = client.request;
  t.after(() => client.terminate());
  return f;
}

function slowTransport(t, f, costOf = args => Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(args)) / 4096))) {
  const worker = new EventEmitter(), commands = [];
  const request = f.worker.client.request;
  let latest;
  const client = createWriterWorkerClient({
    timeoutMs: 10, heartbeatMs: 100000,
    workerFactory: () => worker,
    setTimeout(fn, ms) { latest = { fn, ms }; return latest; },
    clearTimeout() {},
  });
  worker.terminate = async () => {};
  worker.postMessage = message => {
    worker.emit('message', { id: message.id, started: true });
    const deadline = latest;
    const cost = costOf(message.args);
    commands.push({ command: message.command, cost, deadline: deadline.ms });
    request(message.command, ...message.args).then(result => {
      if (cost > deadline.ms) deadline.fn();
      worker.emit('message', { id: message.id, result });
    }, error => worker.emit('message', { id: message.id, error: { message: error.message, code: error.code } }));
  };
  worker.emit('message', { ready: true, settings: [] });
  f.worker.client.request = client.request;
  t.after(() => client.terminate());
  return commands;
}

function observeWrites(t, f) {
  const writes = new Map(), upsert = f.db.upsertCachedSessions;
  t.mock.method(f.db, 'upsertCachedSessions', rows => {
    for (const row of rows) writes.set(row.sessionId, (writes.get(row.sessionId) || 0) + 1);
    return upsert(rows);
  });
  return writes;
}

function loseCertificateBatch(t, f) {
  const certify = f.db.certifyFullRead;
  const committed = new Set();
  let armed = true;
  t.mock.method(f.db, 'nextChunkSize', () => 1);
  t.mock.method(f.db, 'certifyFullRead', (...args) => {
    if (armed && committed.size === 2) {
      armed = false;
      throw Object.assign(new Error('writer command timed out; outcome unknown'), { code: 'WRITER_TIMEOUT' });
    }
    const result = certify(...args);
    if (armed && result) committed.add(args[2]);
    return result;
  });
  return committed;
}

test('large cold folder finishes when slow writer commands exceed a fixed deadline', sqlite, async t => {
  const f = await loadFixture(t);
  for (let i = 0; i < 12; i++) f.write('large-' + i, 'body '.repeat(1800));
  const commands = slowTransport(t, f);
  const result = await f.cache.populateCacheViaWorker();
  assert.equal(result.ok, true, 'large folder must finish under simulated writer load');
  assert.ok(commands.some(command => command.cost > 10), 'the fixture exceeds the old per-command deadline');
  assert.equal(f.db.isInitialScanComplete(), true);
  assert.equal(f.db.getCachedByFolder(f.folder).length, 12);
  assert.equal(f.db.getFolderMeta(f.folder).fullIndexPending, null);
  assert.ok(f.db.getCachedByFolder(f.folder).every(row => row.fullReadStamp));
});

test('retry after an unknown certificate batch preserves durably certified rows', sqlite, async t => {
  const f = await loadFixture(t);
  for (let i = 0; i < 8; i++) f.write('resume-' + i);
  const writes = observeWrites(t, f), committed = loseCertificateBatch(t, f);
  assert.equal((await f.cache.populateCacheViaWorker()).ok, false);
  assert.equal(committed.size, 2);
  assert.equal(f.db.isInitialScanComplete(), false);
  assert.ok(f.db.getFolderMeta(f.folder).fullIndexPending);
  const retried = await f.restart();
  assert.equal(retried.ok, true, retried.error);
  for (const id of committed) assert.equal(writes.get(id), 1, 'certified row must not be rewritten: ' + id);
  for (const row of f.db.getCachedByFolder(f.folder)) {
    assert.ok(row.fullReadStamp);
    if (!committed.has(row.sessionId)) assert.equal(writes.get(row.sessionId), 2, 'uncertified row must be republished');
  }
  assert.equal(f.db.isInitialScanComplete(), true);
  assert.equal(f.db.getFolderMeta(f.folder).fullIndexPending, null);
});

test('resume revalidates changed sources while preserving stable neighbors', sqlite, async t => {
  const f = await loadFixture(t);
  for (let i = 0; i < 8; i++) f.write('changed-' + i);
  const writes = observeWrites(t, f), committed = loseCertificateBatch(t, f);
  assert.equal((await f.cache.populateCacheViaWorker()).ok, false);
  const changed = [...committed][0];
  fs.appendFileSync(f.write(changed), JSON.stringify({ type: 'user', cwd: f.root, uuid: 'appended', message: { content: 'new bytes' } }) + '\n');
  assert.equal((await f.restart()).ok, true);
  assert.equal(writes.get(changed), 2);
  assert.equal(f.db.getCachedSession(changed).messageCount, 2);
  for (const id of [...committed].slice(1)) assert.equal(writes.get(id), 1, 'unchanged certified neighbor survives');
});

test('many small rows receive a work budget even without a large byte payload', async t => {
  const f = { worker: { client: { request: async () => true } } };
  slowTransport(t, f, args => args[0].length / 4);
  await assert.doesNotReject(f.worker.client.request('deriveCachedNames', Array.from({ length: 128 }, () => ({}))));
});

for (const changed of ['token', 'certificate', 'configuration']) {
  test('resume refuses a changed ' + changed, sqlite, async t => {
    const f = await loadFixture(t);
    for (let i = 0; i < 4; i++) f.write('guard-' + i);
    const writes = observeWrites(t, f), committed = loseCertificateBatch(t, f);
    assert.equal((await f.cache.populateCacheViaWorker()).ok, false);
    if (changed === 'token') f.db.beginFullIndex(f.folder, 'superseded');
    if (changed === 'certificate') for (const id of committed) f.db.invalidateFullRead(id);
    if (changed === 'configuration') f.db.setSetting('global', { disabledHarnesses: ['codex'] });
    const retried = await f.restart();
    assert.equal(retried.ok, true, retried.error);
    for (const id of committed) assert.equal(writes.get(id), 2, 'changed ' + changed + ' forbids reuse');
  });
}

test('a single large text payload receives a byte budget independently of row count', async t => {
  const f = { worker: { client: { request: async () => true } } };
  slowTransport(t, f);
  await assert.doesNotReject(f.worker.client.request('effects', [{ name: 'upsertSearchEntries',
    args: [[{ id: 'large', type: 'session', body: 'x'.repeat(131072) }]] }], 0));
});
