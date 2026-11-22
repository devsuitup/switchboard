'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { fixture, logicalIndex, supported } = require('./fixtures/warm-start-1144.cjs');
const openStore = require('./fixtures/conversation-store.cjs');
const { createSessionIndexWriter } = require('../session-index-writer');
const sqlite = { skip: !supported && 'SQLite requires native binding or Node 22' };
const line = (cwd, content) => JSON.stringify({ type: 'user', cwd, uuid: content,
  timestamp: '2024-01-02T00:00:00.000Z', message: { content } }) + '\n';
const reply = JSON.stringify({ type: 'assistant', uuid: 'reply', timestamp: '2024-01-02T00:00:01.000Z',
  message: { model: 'claude-x', usage: { input_tokens: 100, output_tokens: 50 }, content: [{ type: 'text', text: 'wombatreply' }] } }) + '\n';

async function assertReadProjection(f, live, readBytes) {
  const incremental = logicalIndex(f.db);
  const currentBytes = fs.readFileSync(live);
  const data = process.env.SWITCHBOARD_DATA_DIR;
  await f.cache.shutdownProducers();
  process.env.SWITCHBOARD_DATA_DIR = path.join(f.root, 'reference');
  const reference = openStore();
  const worker = require('./fixtures/project-deletion-worker.cjs')(reference);
  const writer = createSessionIndexWriter({ readonlyBackend: reference, client: worker.client });
  try {
    fs.writeFileSync(live, readBytes);
    await writer.ready;
    writer.initializeCache({ PROJECTS_DIR: f.projects, activeSessions: new Map(), getMainWindow: () => null,
      log: { info() {}, warn() {}, error() {} } });
    assert.equal((await f.cache.populateCacheViaWorker({ force: true })).ok, true);
    const project = index => ({
      sessions: index.sessions.map(row => ({ sessionId: row.sessionId, summary: row.summary, projectPath: row.projectPath })),
      search: index.search, metrics: index.metrics,
    });
    assert.deepEqual(project(incremental), project(logicalIndex(reference)),
      'after raced population and watcher, content and metrics equal a rebuild of the bytes read');
  } finally {
    await f.cache.shutdownProducers();
    reference.closeDb();
    fs.writeFileSync(live, currentBytes);
    process.env.SWITCHBOARD_DATA_DIR = data;
  }
}

for (const restarts of [1, 2]) for (const targeted of [true, false]) {
  test(`raced existing row publishes read content and metrics: restarts=${restarts}, targeted=${targeted}`, sqlite, async t => {
    const f = await fixture(t), live = f.write('live');
    f.write('neighbor');
    f.write('gone');
    assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
    fs.unlinkSync(path.join(f.dir, 'gone.jsonl'));
    fs.appendFileSync(live, line(f.root, 'quokkaclosed') + reply);
    const emit = Worker.prototype.emit;
    let readBytes, appends = 0;
    t.mock.method(Worker.prototype, 'emit', function (event, msg, ...args) {
      if (event === 'message' && msg?.result?.startup) {
        readBytes = fs.readFileSync(live);
        fs.appendFileSync(live, line(f.root, 'append' + appends++));
      }
      return emit.call(this, event, msg, ...args);
    });
    for (let i = 0; i < restarts; i++) assert.equal((await f.restart()).ok, true);
    t.mock.restoreAll();
    assert.equal(appends, restarts);
    assert.equal(f.db.getFolderMeta(f.folder).fullIndexPending, null);
    assert.equal(f.db.getCachedSession('live').fullReadStamp, null);
    await f.writer.refreshFolder(f.folder, targeted ? { files: new Set(['live.jsonl']) } : undefined);
    const index = logicalIndex(f.db);
    assert.ok(index.search.find(row => row.id === 'live').body.includes('quokkaclosed'), 'FTS body has content written while closed');
    assert.equal(f.db.getCachedSession('live').fullReadStamp, null, 'raced bytes never receive a certificate');
    assert.deepEqual(index.metrics.filter(row => row.sessionId === 'live' && row.model === 'claude-x')
      .map(row => [row.date, row.inputTokens, row.outputTokens]), [['2024-01-02', 100, 50]], 'closed-run token metrics survive the race');
    assert.equal(f.db.getCachedSession('live').messageCount, 3 + restarts, 'watcher counts the latest append');
    await assertReadProjection(f, live, readBytes);
  });
}

for (const reason of ['forced', 'pending', 'version', 'configuration', 'missing-baseline', 'project-path']) {
  test('full read with a race deletes vanished transcripts: ' + reason, sqlite, async t => {
    const f = await fixture(t), live = f.write('live');
    f.write('gone');
    f.write('neighbor');
    assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
    fs.unlinkSync(path.join(f.dir, 'gone.jsonl'));
    if (reason === 'pending') f.db.connection.prepare("UPDATE cache_meta SET fullIndexPending = 'interrupted'").run();
    if (reason === 'version') f.db.connection.prepare('UPDATE cache_meta SET fullIndexVersion = 0').run();
    if (reason === 'configuration') await f.writer.setSetting('projectRemaps', { '/unused': '/changed' });
    if (reason === 'missing-baseline') f.db.connection.prepare('DELETE FROM cache_meta').run();
    if (reason === 'project-path') f.db.connection.prepare('UPDATE cache_meta SET projectPath = ?').run('/old');
    const emit = Worker.prototype.emit;
    let readBytes;
    t.mock.method(Worker.prototype, 'emit', function (event, msg, ...args) {
      if (event === 'message' && msg?.result?.startup) {
        readBytes = fs.readFileSync(live);
        fs.appendFileSync(live, line(f.root, 'late'));
      }
      return emit.call(this, event, msg, ...args);
    });
    assert.equal((await f.restart({ force: reason === 'forced' })).ok, true);
    t.mock.restoreAll();
    assert.equal(f.scans()[0].reason, ['version', 'configuration'].includes(reason) ? 'forced' : reason);
    assert.equal(f.db.getCachedSession('gone'), null, 'full read drops a vanished transcript before any watcher repair');
    assert.ok(!logicalIndex(f.db).search.some(row => row.id === 'gone'), 'vanished transcript is absent from search');
    await f.writer.refreshFolder(f.folder, { files: new Set(['live.jsonl']) });
    await assertReadProjection(f, live, readBytes);
  });
}

for (const check of ['name', 'deferrals']) test('deferred startup repairs accepted ' + check, sqlite, async t => {
  const f = await fixture(t), live = f.write('live');
  f.write('named', 'named', [{ type: 'custom-title', customTitle: 'Transcript name' }]);
  f.write('accounted');
  f.descriptors.push({ sessionId: 'named', nameSource: 'collision' });
  assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
  f.descriptors.length = 0;
  f.cache.applyContinuationRefresh(f.folder, { deferred: new Set(['accounted.jsonl', 'live.jsonl']), accounted: new Set() });
  const emit = Worker.prototype.emit;
  t.mock.method(Worker.prototype, 'emit', function (event, msg, ...args) {
    if (event === 'message' && msg?.result?.startup) fs.appendFileSync(live, line(f.root, 'late'));
    return emit.call(this, event, msg, ...args);
  });
  const publish = f.writer.writeScannedFolderPartial.bind(f.writer);
  f.writer.writeScannedFolderPartial = async result => {
    assert.ok(f.cache.continuationRefreshScope(f.folder, { files: new Set(['other.jsonl']) }).files.has('accounted.jsonl'), 'accepted path remains deferred before ACK');
    const written = await publish(result);
    f.cache.applyContinuationRefresh(f.folder, { deferred: new Set(['newer.jsonl']), accounted: new Set() });
    return written;
  };
  assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
  if (check === 'name') {
    assert.equal(f.db.getMeta('named')?.name, 'Transcript name', 'accepted name is repaired even when another source races');
    assert.ok(f.db.getNameDerivation('named'), 'accepted name has a completed derivation witness');
  }
  const scope = f.cache.continuationRefreshScope(f.folder, { files: new Set(['other.jsonl']) }).files;
  assert.ok(!scope.has('accounted.jsonl'), 'accepted path clears after ACK despite a deferred neighbor');
  assert.ok(scope.has('live.jsonl'), 'raced path remains deferred');
  assert.ok(scope.has('newer.jsonl'), 'newer deferral remains');
});

test('raced startup never overwrites a row already replaced by the watcher', sqlite, async t => {
  const f = await fixture(t), live = f.write('live');
  assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
  fs.appendFileSync(live, line(f.root, 'closed'));
  const emit = Worker.prototype.emit;
  let newer;
  t.mock.method(Worker.prototype, 'emit', function (event, msg, ...args) {
    if (event === 'message' && msg?.result?.startup) {
      fs.appendFileSync(live, line(f.root, 'watcher'));
      newer = { ...f.db.getCachedSession('live'), summary: 'newer watcher row', fullReadStamp: null };
      f.db.upsertCachedSessions([newer]);
    }
    return emit.call(this, event, msg, ...args);
  });
  assert.equal((await f.restart()).ok, true);
  assert.equal(f.db.getCachedSession('live').summary, newer.summary, 'watcher replacement wins over older parsed bytes');
});
