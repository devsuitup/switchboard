'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionIndexWriter } = require('../session-index-writer');

test('882 transcript index notifications follow successful commit and identify affected sessions', async () => {
  const events = [], committedAtNotification = [];
  let db, release, fail = false, hold = true;
  const committed = new Map();
  const backend = { getSetting: () => 0, getCachedSession: id => committed.get(id), getMeta: () => null };
  const cache = { init: ctx => { db = ctx.db; },
    refreshFolder() {
      db.upsertCachedSessions([{ sessionId: 'session-a', folder: 'folder' }]);
      db.setCachedFileSize('session-a', 100);
      db.touchCachedModified('session-b', 1);
      return true;
    },
    dropFolderRows: folder => db.deleteCachedFolder(folder),
  };
  const writer = createSessionIndexWriter({ readonlyBackend: backend,
    onSessionsChanged: ids => { events.push(ids); committedAtNotification.push(committed.has('session-a')); },
    client: { ready: Promise.resolve(), async request() {
      if (fail) throw new Error('commit failed');
      if (hold) await new Promise(resolve => { release = resolve; });
      committed.set('session-a', {});
    } } }, cache);
  await writer.ready;
  writer.initializeCache({});
  const pending = writer.refreshFolder('folder');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, [], 'uncommitted index data must not invalidate availability');
  release();
  await pending;
  assert.deepEqual(events, [['session-a']]);
  assert.deepEqual(committedAtNotification, [true], 'observer sees committed data');
  fail = true;
  await assert.rejects(writer.refreshFolder('folder'), /commit failed/);
  assert.equal(events.length, 1, 'failed commits send no notification');
  fail = false;
  hold = false;
  await writer.setCachedFileSize('session-c', 5);
  assert.equal(events.length, 1, 'size-only writes cannot change availability');
  await writer.deleteCachedSession('session-d');
  assert.deepEqual(events[1], ['session-d']);
  await writer.deleteCachedFolder('folder');
  assert.equal(events[2], null, 'a deleted folder invalidates all cached paths');
});

for (const mode of ['compute', 'direct']) for (const thrown of [Object.assign(new Error('observer exploded'), { code: 'WRITER_STALE' }), null, undefined]) {
  test(`882b throwing ${String(thrown)} observer cannot reject an acknowledged ${mode} write`, async () => {
    const warnings = [], order = [];
    let db, commits = 0, observations = 0;
    const backend = { getSetting: () => 0, getCachedSession: () => null, getMeta: () => null };
    const writer = createSessionIndexWriter({ readonlyBackend: backend,
      log: { warn: message => warnings.push(message) },
      onSessionsChanged() {
        observations++;
        order.push('observer');
        throw thrown;
      },
      client: { ready: Promise.resolve(), async request() { commits++; order.push('commit'); return 42; } },
    }, { init: ctx => { db = ctx.db; },
      refreshFolder() { db.upsertCachedSessions([{ sessionId: 'a', folder: 'folder' }]); return true; },
      applyContinuationRefresh(folder, collector, committed) { if (committed) order.push('final apply'); },
    });
    await writer.ready;
    writer.initializeCache({});
    const [result] = await Promise.allSettled([mode === 'compute' ? writer.refreshFolder('folder') : writer.upsertCachedSessions([{ sessionId: 'a' }])]);
    assert.equal(result.status, 'fulfilled', 'committed commands must resolve even if their observer throws');
    assert.equal(result.value, mode === 'compute' ? true : 42);
    assert.deepEqual(order, mode === 'compute' ? ['commit', 'final apply', 'observer'] : ['commit', 'observer']);
    assert.equal(commits, 1, 'observer errors must not trigger stale-write retries');
    assert.equal(observations, 1);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('[session-index-writer] sessions observer failed: ' + (thrown?.message ?? String(thrown))));
  });
}

test('882b modified-time and size-only effects send no availability notification', async () => {
  const events = [];
  let db;
  const writer = createSessionIndexWriter({
    readonlyBackend: { getSetting: () => 0, getCachedSession: () => ({ sessionId: 'a' }) },
    onSessionsChanged: (...args) => events.push(args),
    client: { ready: Promise.resolve(), request: async () => {} },
  }, { init: ctx => { db = ctx.db; }, refreshFolder() { db.touchCachedModified('a', 1); db.setCachedFileSize('a', 10); } });
  await writer.ready;
  writer.initializeCache({});
  await writer.refreshFolder('folder');
  await writer.setCachedFileSize('a', 20);
  assert.deepEqual(events, [], 'metadata effects cannot change transcript availability');
});

test('882b mixed effects distinguish upserts from deletions and folder deletes dominate', async () => {
  const events = [];
  let db, deleteFolder = false;
  const writer = createSessionIndexWriter({
    readonlyBackend: { getSetting: () => 0, getCachedSession: () => null, getMeta: () => null, getCachedByFolder: () => [] },
    onSessionsChanged: (...args) => events.push(args),
    client: { ready: Promise.resolve(), request: async () => {} },
  }, { init: ctx => { db = ctx.db; }, refreshFolder() {
    db.upsertCachedSessions([{ sessionId: 'a', folder: 'folder' }, { sessionId: 'a', folder: 'folder' }]);
    db.deleteCachedSession('b');
    db.deleteCachedSession('b');
    if (deleteFolder) db.deleteCachedFolder('folder');
  } });
  await writer.ready;
  writer.initializeCache({});
  await writer.refreshFolder('folder');
  assert.deepEqual(events, [[['b'], undefined], [['a'], { upsertOnly: true }]]);
  events.length = 0;
  deleteFolder = true;
  await writer.refreshFolder('folder');
  assert.deepEqual(events, [[null, undefined]], 'folder deletes subsume per-session invalidation');
});

for (const command of ['cleanupWorktree', 'dropRemoteFolder']) {
  test(`882b ${command} fully invalidates only after a successful acknowledgment`, async () => {
    const events = [];
    let release, fail = false;
    const writer = createSessionIndexWriter({ readonlyBackend: {},
      onSessionsChanged: ids => events.push(ids),
      client: { ready: Promise.resolve(), async request() {
        await new Promise(resolve => { release = resolve; });
        if (fail) throw new Error('commit failed');
      } },
    }, {});
    await writer.ready;
    const pending = writer[command]('folder');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, [], 'no notification before ACK');
    release();
    await pending;
    assert.deepEqual(events, [null], 'compound folder deletions invalidate all cached transcript paths');
    fail = true;
    const rejected = writer[command]('folder');
    await new Promise(resolve => setImmediate(resolve));
    release();
    await assert.rejects(rejected, /commit failed/);
    assert.deepEqual(events, [null], 'failed compound deletes send no notification');
  });
}

for (const mode of ['compute', 'direct']) {
  test(`894 ${mode} folder-move notifications wait for ACK and failed writes leave memos untouched`, async () => {
    const events = [];
    let db, release, fail = false;
    const rows = [
      { sessionId: 'moved', folder: 'remote::folder' },
      { sessionId: 'same', folder: 'folder' },
      { sessionId: 'new', folder: 'folder' },
      { sessionId: 'moved', folder: 'remote::folder' },
    ];
    const writer = createSessionIndexWriter({
      readonlyBackend: { getSetting: () => 0, getCachedSession: id => id === 'new' ? null : { sessionId: id, folder: 'folder' }, getMeta: () => null },
      onSessionsChanged: (...args) => events.push(args),
      client: { ready: Promise.resolve(), async request() {
        await new Promise(resolve => { release = resolve; });
        if (fail) throw new Error('commit failed');
      } },
    }, { init: ctx => { db = ctx.db; }, refreshFolder() { db.upsertCachedSessions(rows); } });
    await writer.ready;
    writer.initializeCache({});
    const upsert = () => mode === 'compute' ? writer.refreshFolder('folder') : writer.upsertCachedSessions(rows);
    const pending = upsert();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, [], 'a planned folder move cannot invalidate before ACK');
    release();
    await pending;
    assert.deepEqual(events, [[['moved'], undefined], [['same', 'new'], { upsertOnly: true }]]);
    events.length = 0;
    fail = true;
    const rejected = upsert();
    await new Promise(resolve => setImmediate(resolve));
    release();
    await assert.rejects(rejected, /commit failed/);
    assert.deepEqual(events, [], 'failed folder moves discard the notification plan');
  });
}
