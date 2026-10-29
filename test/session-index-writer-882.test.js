'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionIndexWriter } = require('../session-index-writer');

test('882 transcript index notifications follow successful commit and identify affected sessions', async () => {
  const events = [];
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
    onSessionsChanged: ids => { events.push(ids); assert.equal(committed.has('session-a'), true); },
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
  assert.deepEqual(events, [['session-a', 'session-b']]);
  fail = true;
  await assert.rejects(writer.refreshFolder('folder'), /commit failed/);
  assert.equal(events.length, 1, 'failed commits send no notification');
  fail = false;
  hold = false;
  await writer.setCachedFileSize('session-c', 5);
  assert.deepEqual(events[1], ['session-c'], 'direct cache writes also notify');
  await writer.deleteCachedSession('session-d');
  assert.deepEqual(events[2], ['session-d']);
  await writer.deleteCachedFolder('folder');
  assert.equal(events[3], null, 'a deleted folder invalidates all cached paths');
});
