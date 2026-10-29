'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cache = require('../session-cache');
const { subagentSessionId } = require('../read-session-file');
const { memoryWriter } = require('./fixtures/writer-memory.cjs');
const { fixture, OLD, line } = require('./fixtures/continuation-718.cjs');
const openStore = require('./fixtures/conversation-store.cjs');

for (const subagent of [false, true]) {
  for (const targeted of [false, true]) {
    test(`pinned mtime growth refreshes ${subagent ? 'subagent' : 'unlinked'} rows, targeted=${targeted}`, async t => {
      const h = fixture(t);
      const relative = subagent ? path.join(OLD, 'subagents', 'agent-child.jsonl') : OLD + '.jsonl';
      const file = path.join(h.dir, relative);
      const id = subagent ? subagentSessionId(OLD, 'child') : OLD;
      const pinned = new Date('2026-10-19T09:00:00.000Z');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, line({ type: 'user', cwd: h.root, isSidechain: subagent,
        timestamp: '2026-10-19T08:00:00.000Z', message: { content: 'hello' } }));
      fs.utimesSync(file, pinned, pinned);
      const writer = memoryWriter(h.db, cache);
      await writer.ready;
      const init = () => writer.initializeCache({ PROJECTS_DIR: h.root, activeSessions: h.activeSessions,
        getMainWindow: () => null, log: h.log });
      init();
      await writer.refreshFolder(h.folder);
      const initial = h.rows.get(id);
      assert.ok(initial, 'initial row indexed');
      assert.equal(initial.messageCount, 1);
      h.rows.set(id, { ...initial, continuationIndex: null, fileMtime: pinned.toISOString() });
      const originalSize = fs.statSync(file).size;
      fs.appendFileSync(file, line({ type: 'assistant', timestamp: '2026-10-19T10:00:00.000Z',
        message: { content: 'new answer' } }) + line({ type: 'custom-title', customTitle: 'Fresh preview' }));
      fs.utimesSync(file, pinned, pinned);
      assert.equal(fs.statSync(file).mtime.toISOString(), pinned.toISOString());
      assert.ok(fs.statSync(file).size > originalSize, 'actual transcript growth');
      init();
      const opts = targeted ? { files: new Set([relative]) } : {};
      await writer.refreshFolder(h.folder, opts);
      const refreshed = h.rows.get(id);
      assert.equal(refreshed.messageCount, 2, 'growth with identical mtime must reindex the message count');
      assert.equal(refreshed.customTitle, 'Fresh preview');
      assert.equal(refreshed.fileMtime, pinned.toISOString());
      assert.equal(refreshed.modified, subagent ? pinned.toISOString() : '2026-10-19T10:00:00.000Z');
      assert.equal(refreshed.fileSize, fs.statSync(file).size);
      assert.equal(h.meta.get(id).name, 'Fresh preview');
      const writes = h.effects.length;
      init();
      await writer.refreshFolder(h.folder, opts);
      assert.equal(h.effects.length, writes, 'unchanged transcript is skipped after reinitialization');
    });
  }
}

test('writer persists transcript sizes across reopen and upgrades legacy rows without a cache wipe', async t => {
  let store;
  t.after(() => store?.closeDb());
  const h = fixture(t);
  const previous = process.env.SWITCHBOARD_DATA_DIR;
  process.env.SWITCHBOARD_DATA_DIR = path.join(h.root, 'data');
  const open = () => {
    try { return openStore(); }
    finally {
      if (previous === undefined) delete process.env.SWITCHBOARD_DATA_DIR;
      else process.env.SWITCHBOARD_DATA_DIR = previous;
    }
  };
  store = open();
  h.write(OLD);
  const pinned = new Date('2026-10-19T09:00:00.000Z');
  fs.utimesSync(h.file(OLD), pinned, pinned);
  const writerFor = async () => {
    const writer = memoryWriter(store, cache);
    await writer.ready;
    writer.initializeCache({ PROJECTS_DIR: h.root, activeSessions: h.activeSessions,
      getMainWindow: () => null, log: h.log });
    return writer;
  };
  await (await writerFor()).refreshFolder(h.folder);
  const size = fs.statSync(h.file(OLD)).size;
  assert.equal(store.getCachedSession(OLD).fileSize, size, 'size survives the SQL upsert');
  store.closeDb();
  process.env.SWITCHBOARD_DATA_DIR = path.join(h.root, 'data');
  store = open();
  assert.equal(store.getCachedSession(OLD).fileSize, size, 'size survives reopening');
  const dbPath = store.DB_PATH;
  store.setName(OLD, 'Keep my name');
  store.closeDb();
  const { DatabaseSync } = require('node:sqlite');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec('ALTER TABLE session_cache DROP COLUMN fileSize');
  legacy.close();
  process.env.SWITCHBOARD_DATA_DIR = path.join(h.root, 'data');
  store = open();
  assert.equal(store.getCachedSession(OLD).fileSize, null, 'new column starts unknown on existing rows');
  assert.equal(store.getMeta(OLD).name, 'Keep my name');
  store.setCachedContinuationIndex(OLD, null);
  fs.appendFileSync(h.file(OLD), line({ type: 'assistant', timestamp: '2026-10-19T10:00:00.000Z', message: { content: 'answer' } }));
  fs.utimesSync(h.file(OLD), pinned, pinned);
  const writer = await writerFor();
  await writer.refreshFolder(h.folder);
  const refreshed = store.getCachedSession(OLD);
  assert.equal(refreshed.messageCount, 2);
  assert.equal(refreshed.fileSize, fs.statSync(h.file(OLD)).size);
  assert.equal(store.getMeta(OLD).name, 'Keep my name');
  const upserts = t.mock.method(store, 'upsertCachedSessions');
  await writer.refreshFolder(h.folder);
  assert.equal(upserts.mock.callCount(), 0, 'stable transcript needs no session upsert');
});
