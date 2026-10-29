'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cache = require('../session-cache');
const { subagentSessionId } = require('../read-session-file');
const { memoryWriter } = require('./fixtures/writer-memory.cjs');
const { fixture, OLD, HEAD, line } = require('./fixtures/continuation-718.cjs');
const openStore = require('./fixtures/conversation-store.cjs');

for (const kind of ['unlinked', 'subagent', 'linked']) {
  for (const targeted of [false, true]) {
    test(`unknown size is adopted without reading content or changing recency: ${kind}, targeted=${targeted}`, async t => {
      const h = fixture(t);
      const subagent = kind === 'subagent';
      const relative = subagent ? path.join(OLD, 'subagents', 'agent-child.jsonl') : OLD + '.jsonl';
      const file = path.join(h.dir, relative);
      const id = subagent ? subagentSessionId(OLD, 'child') : OLD;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, line({ type: 'user', sessionId: OLD, cwd: h.root, isSidechain: subagent,
        timestamp: '2026-10-19T08:00:00.000Z', message: { content: 'hello' } }) + (kind === 'linked' ? h.link() : ''));
      const pinned = new Date('2026-10-19T09:00:00.000Z');
      fs.utimesSync(file, pinned, pinned);
      const writer = memoryWriter(h.db, cache);
      await writer.ready;
      const init = () => writer.initializeCache({ PROJECTS_DIR: h.root, activeSessions: h.activeSessions,
        getMainWindow: () => null, log: h.log });
      init();
      await writer.refreshFolder(h.folder);
      const initial = h.rows.get(id);
      assert.ok(initial);
      if (kind === 'linked') assert.deepEqual(JSON.parse(initial.continuationIndex).ids, [HEAD]);
      const before = { ...initial, fileSize: null, modified: '2026-10-19T08:00:00.000Z' };
      h.rows.set(id, before);
      h.effects.length = 0;
      const readFile = fs.readFileSync;
      let fullReads = 0;
      t.mock.method(fs, 'readFileSync', function (target, ...args) {
        if (target === file) fullReads++;
        return readFile.call(this, target, ...args);
      });
      const opts = targeted ? { files: new Set([relative]) } : {};
      init();
      assert.equal(await writer.refreshFolder(h.folder, opts), false);
      assert.equal(fullReads, 0, 'unknown size must not trigger a full transcript read');
      assert.equal(h.effects.filter(([name]) => name === 'upsert' || name === 'touch').length, 0, 'adoption must not upsert content or touch recency');
      assert.deepEqual(h.rows.get(id), { ...before, fileSize: fs.statSync(file).size });
      init();
      const writes = h.effects.length;
      await writer.refreshFolder(h.folder, opts);
      assert.equal(h.effects.length, writes, 'adopted size survives cache reinitialization');
      fs.appendFileSync(file, line({ type: 'assistant', timestamp: '2026-10-19T10:00:00.000Z', message: { content: 'answer' } }));
      fs.utimesSync(file, pinned, pinned);
      init();
      await writer.refreshFolder(h.folder, opts);
      const grown = h.rows.get(id);
      assert.equal(grown.fileSize, fs.statSync(file).size, 'later pinned growth is detected after adoption');
      assert.equal(grown.messageCount, kind === 'linked' ? 1 : 2);
      assert.equal(fullReads, kind === 'linked' ? 0 : 1);
    });
  }
}

for (const subagent of [false, true]) {
  for (const delta of [0, 1]) {
    test(`pinned growth uses bounded reads above the continuation budget: subagent=${subagent}, delta=${delta}`, async t => {
      const h = fixture(t);
      const relative = subagent ? path.join(OLD, 'subagents', 'agent-child.jsonl') : OLD + '.jsonl';
      const file = path.join(h.dir, relative);
      const id = subagent ? subagentSessionId(OLD, 'child') : OLD;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, line({ type: 'user', cwd: h.root, isSidechain: subagent,
        timestamp: '2026-10-19T08:00:00.000Z', message: { content: 'hello' } }));
      const pinned = new Date('2026-10-19T09:00:00.000Z');
      fs.utimesSync(file, pinned, pinned);
      const writer = memoryWriter(h.db, cache);
      await writer.ready;
      writer.initializeCache({ PROJECTS_DIR: h.root, activeSessions: h.activeSessions, getMainWindow: () => null, log: h.log });
      await writer.refreshFolder(h.folder);
      const initial = h.rows.get(id);
      h.rows.set(id, { ...initial, continuationIndex: null });
      const answer = line({ type: 'assistant', timestamp: '2026-10-19T10:00:00.000Z', message: { content: 'answer' } });
      const title = line({ type: 'custom-title', customTitle: 'Fresh bounded title' });
      const budget = 1024 * 1024;
      const remaining = budget + delta - fs.statSync(file).size - Buffer.byteLength(answer + title);
      fs.appendFileSync(file, ' '.repeat(remaining - 1) + '\n' + answer + title);
      fs.utimesSync(file, pinned, pinned);
      assert.equal(fs.statSync(file).size, budget + delta);
      const readFile = fs.readFileSync;
      let fullReads = 0;
      t.mock.method(fs, 'readFileSync', function (target, ...args) {
        if (target === file) fullReads++;
        return readFile.call(this, target, ...args);
      });
      await writer.refreshFolder(h.folder, { files: new Set([relative]) });
      const refreshed = h.rows.get(id);
      assert.equal(fullReads, delta === 0 ? 1 : 0, 'pinned growth above the byte budget must not read the whole transcript');
      assert.equal(refreshed.messageCount, delta === 0 ? 2 : 1);
      assert.equal(refreshed.customTitle, 'Fresh bounded title');
      assert.equal(refreshed.fileSize, budget + delta);
      const writes = h.effects.length;
      await writer.refreshFolder(h.folder, { files: new Set([relative]) });
      assert.equal(h.effects.length, writes);
    });
  }
}

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
  const beforeAdoption = store.getCachedSession(OLD);
  const writer = await writerFor();
  const upserts = t.mock.method(store, 'upsertCachedSessions');
  await writer.refreshFolder(h.folder);
  assert.deepEqual({ ...store.getCachedSession(OLD) }, { ...beforeAdoption, fileSize: size });
  assert.equal(upserts.mock.callCount(), 0, 'legacy adoption persists without a content upsert');
  store.closeDb();
  process.env.SWITCHBOARD_DATA_DIR = path.join(h.root, 'data');
  store = open();
  assert.equal(store.getCachedSession(OLD).fileSize, size, 'adoption survives reopening SQLite');
  fs.appendFileSync(h.file(OLD), line({ type: 'assistant', timestamp: '2026-10-19T10:00:00.000Z', message: { content: 'answer' } }));
  fs.utimesSync(h.file(OLD), pinned, pinned);
  const reopenedWriter = await writerFor();
  await reopenedWriter.refreshFolder(h.folder);
  const refreshed = store.getCachedSession(OLD);
  assert.equal(refreshed.messageCount, 2);
  assert.equal(refreshed.fileSize, fs.statSync(h.file(OLD)).size);
  assert.equal(store.getMeta(OLD).name, 'Keep my name');
  const reopenedUpserts = t.mock.method(store, 'upsertCachedSessions');
  await reopenedWriter.refreshFolder(h.folder);
  assert.equal(reopenedUpserts.mock.callCount(), 0, 'stable transcript needs no session upsert');
  const beforeRelay = { ...store.getCachedSession(OLD) };
  store.setCachedFileSize(OLD, null);
  await reopenedWriter.applyProjectsWorkerEffects({ effects: [{ name: 'setCachedFileSize', args: [OLD, beforeRelay.fileSize] }], keptLiveRows: [] });
  assert.deepEqual({ ...store.getCachedSession(OLD) }, beforeRelay, 'Projects effect relay preserves content and recency');
});
