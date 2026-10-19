'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cache = require('../session-cache');
const { createContinuationReader } = require('../bg-handoff');
const { encodeProjectPath } = require('../encode-project-path');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-continuation-656-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = encodeProjectPath(root);
  fs.mkdirSync(path.join(root, folder));
  const text = child => [
    { type: 'user', cwd: root, message: { content: 'hello' } },
    ...(child ? [{ type: 'continued-in', sessionId: 'old', continuedInSessionId: child }] : []),
    { type: 'assistant', message: { content: 'unchanged tail '.repeat(12) } },
  ].map(JSON.stringify).join('\n') + '\n';
  const file = path.join(root, folder, 'old.jsonl');
  for (const id of ['old', 'aaa', 'bbb']) fs.writeFileSync(path.join(root, folder, id + '.jsonl'), text(id === 'old' ? 'aaa' : null));
  const rows = new Map(), meta = new Map();
  const db = {
    getSetting: () => ({}), getAllFolderMeta: () => meta, getFolderMeta: id => meta.get(id), getAllMeta: () => new Map(),
    getAllCached: () => [...rows.values()], getCachedByFolder: () => [...rows.values()], getCachedSession: id => rows.get(id),
    upsertCachedSessions: entries => entries.forEach(row => { JSON.stringify(row); rows.set(row.sessionId, row); }),
    setCachedContinuationIndex(id, serialized) { rows.set(id, { ...rows.get(id), continuationIndex: serialized }); },
    setFolderMeta(id, projectPath, indexMtimeMs) { meta.set(id, { projectPath, indexMtimeMs }); },
    getMeta() {}, setName() {}, upsertSearchEntries() {}, replaceSessionMetrics() {}, touchCachedModified() {},
    deleteCachedFolder() {}, deleteCachedSession() {}, deleteSearchFolder() {}, deleteSearchSession() {},
  };
  const init = () => cache.init({ PROJECTS_DIR: root, db, activeSessions: new Map(), getMainWindow: () => null, log: console });
  return { file, folder, rows, text, init, root, db };
}

function stamp(t, file, change) {
  const stat = fs.statSync;
  let changed = false;
  const inode = 2n ** 54n;
  assert.equal(Number(inode), Number(inode + 1n));
  t.mock.method(fs, 'statSync', (name, options) => {
    const result = stat(name, options);
    if (name !== file) return result;
    const dev = 1n + (changed && change === 'dev' ? 1n : 0n);
    const ino = inode + (changed && change === 'colliding inode' ? 1n : 0n);
    const birthtimeNs = 1_000_000_000n + (changed && change === 'birthtime' ? 1n : 0n);
    const mtimeNs = 2_000_000_000n + (changed && change === 'sub-ms mtime' ? 100n : 0n);
    return Object.assign(result, options?.bigint ? { dev, ino, birthtimeNs, mtimeNs }
      : { dev: Number(dev), ino: Number(ino), birthtimeMs: 1000, mtimeMs: 2000, mtime: new Date(2000) });
  });
  return () => { changed = true; };
}

for (const caller of ['refresh', 'resolve', 'background']) {
  for (const change of ['colliding inode', 'sub-ms mtime', 'dev', 'birthtime']) {
    test(`#656 ${caller}: equal-size replacement with ${change} drops the old continuation`, async t => {
      const h = fixture(t);
      const changed = stamp(t, h.file, change);
      h.init();
      cache.refreshFolder(h.folder);
      const read = createContinuationReader(h.file, 'old');
      const ids = async () => {
        if (caller === 'background') return read();
        if (caller === 'resolve') return (await cache.resolveSessionContinuations('old')).candidates.map(row => row.sessionId);
        cache.refreshFolder(h.folder, { files: new Set(['old.jsonl']) });
        return JSON.parse(h.rows.get('old').continuationIndex).ids;
      };
      assert.deepEqual(await ids(), ['aaa']);
      const old = h.text('aaa'), replacement = h.text('bbb');
      assert.equal(Buffer.byteLength(old), Buffer.byteLength(replacement));
      assert.equal(old.slice(-64), replacement.slice(-64));
      fs.renameSync(h.file, h.file + '.previous');
      fs.writeFileSync(h.file, replacement);
      changed();
      assert.deepEqual(await ids(), ['bbb'], 'the replacement must expose its current continuation');
      assert.doesNotThrow(() => JSON.stringify([...h.rows.values()]));
    });
  }
}

for (const caller of ['refresh', 'resolve', 'background']) {
  for (const field of ['dev', 'ino', 'birthtimeNs', 'mtimeNs', 'size']) {
    test(`#656 ${caller}: ${field} changed during the scan leaves evidence unresolved`, async t => {
      const h = fixture(t);
      h.init();
      cache.refreshFolder(h.folder);
      h.rows.get('old').continuationIndex = null;
      const stat = fs.statSync;
      let readStarted = false;
      const readSync = fs.readSync;
      t.mock.method(fs, 'readSync', (...args) => { readStarted = true; return readSync(...args); });
      t.mock.method(fs, 'statSync', (name, options) => {
        const result = stat(name, options);
        if (name === h.file && options?.bigint && readStarted) result[field] += 1n;
        return result;
      });
      if (caller === 'refresh') {
        h.rows.get('old').fileMtime = '';
        cache.refreshFolder(h.folder, { files: new Set(['old.jsonl']) });
        assert.equal(h.rows.get('old').continuationIndex, null);
      } else if (caller === 'background') assert.equal(await createContinuationReader(h.file, 'old')(), null);
      else assert.equal((await cache.resolveSessionContinuations('old')).unresolved, true);
    });
  }
}

test('#656 resolve: a cold caller revalidates a persisted complete index', async t => {
  const h = fixture(t);
  const changed = stamp(t, h.file, 'colliding inode');
  h.init();
  cache.refreshFolder(h.folder);
  fs.renameSync(h.file, h.file + '.previous');
  fs.writeFileSync(h.file, h.text('bbb'));
  changed();
  h.init();
  const result = await cache.resolveSessionContinuations('old');
  assert.deepEqual(result.candidates.map(row => row.sessionId), ['bbb']);
});

for (const caller of ['resolve', 'background']) {
  test(`#656 ${caller}: bounded scan chunks finish without leaking BigInt`, async t => {
    const h = fixture(t);
    fs.appendFileSync(h.file, '{}\n'.repeat(350000));
    h.init();
    cache.refreshFolder(h.folder);
    h.rows.get('old').continuationIndex = null;
    const result = caller === 'background' ? await createContinuationReader(h.file, 'old')()
      : (await cache.resolveSessionContinuations('old', { chunkBytes: 256 * 1024 })).candidates.map(row => row.sessionId);
    assert.deepEqual(result, ['aaa']);
    assert.doesNotThrow(() => JSON.stringify([...h.rows.values()]));
  });
}

test('#656 resolve: a replacement during the final yield cannot publish the old index', async t => {
  const h = fixture(t);
  h.init();
  cache.refreshFolder(h.folder);
  h.rows.get('old').continuationIndex = null;
  const read = fs.readSync;
  let scheduled = false;
  t.mock.method(fs, 'readSync', (...args) => {
    const n = read(...args);
    if (!scheduled) {
      scheduled = true;
      setImmediate(() => {
        fs.renameSync(h.file, h.file + '.previous');
        fs.writeFileSync(h.file, h.text('bbb'));
      });
    }
    return n;
  });
  const result = await cache.resolveSessionContinuations('old');
  assert.equal(result.unresolved, true);
  assert.equal(h.rows.get('old').continuationIndex, null);
});

test('#656 refresh: an unreadable display header still clears the replaced continuation', t => {
  const h = fixture(t);
  const changed = stamp(t, h.file, 'colliding inode');
  h.init();
  cache.refreshFolder(h.folder);
  fs.renameSync(h.file, h.file + '.previous');
  fs.writeFileSync(h.file, '{}\n');
  changed();
  cache.refreshFolder(h.folder, { files: new Set(['old.jsonl']) });
  const index = JSON.parse(h.rows.get('old').continuationIndex);
  assert.deepEqual(index.ids, []);
});

for (const caller of ['resolve', 'background']) {
  test(`#656 ${caller}: verified growth keeps incremental scanning`, async t => {
    const h = fixture(t);
    h.init();
    cache.refreshFolder(h.folder);
    const read = createContinuationReader(h.file, 'old');
    const ids = async () => caller === 'background' ? read()
      : (await cache.resolveSessionContinuations('old')).candidates.map(row => row.sessionId);
    assert.deepEqual(await ids(), ['aaa']);
    const start = fs.statSync(h.file).size;
    fs.appendFileSync(h.file, JSON.stringify({ type: 'continued-in', sessionId: 'old', continuedInSessionId: 'bbb' }) + '\n');
    const readSync = fs.readSync, positions = [];
    t.mock.method(fs, 'readSync', (...args) => {
      if (args[3] > 64) positions.push(args[4]);
      return readSync(...args);
    });
    assert.deepEqual(await ids(), ['aaa', 'bbb']);
    assert.equal(positions[0], start);
  });
}

for (const [name, count, restart] of [['restart', 4, true], ['snapshot eviction', 140, false]]) {
  test(`#656b refresh: ${name} preserves all unchanged persisted indexes without upserts`, t => {
    const h = fixture(t);
    for (let i = 3; i < count; i++) fs.writeFileSync(path.join(h.root, h.folder, `session-${i}.jsonl`), h.text(null));
    const upsert = t.mock.method(h.db, 'upsertCachedSessions');
    h.init();
    cache.refreshFolder(h.folder);
    assert.equal(h.rows.size, count);
    const indexes = [...h.rows].map(([id, row]) => [id, row.continuationIndex]);
    assert.ok(indexes.every(([, index]) => index !== null));
    if (restart) h.init();
    upsert.mock.resetCalls();
    cache.refreshFolder(h.folder);
    assert.deepEqual([...h.rows].map(([id, row]) => [id, row.continuationIndex]), indexes);
    assert.equal(upsert.mock.callCount(), 0, 'unchanged rows require no upsert');
  });
}

for (const finalYield of [false, true]) {
  test(`#656b resolve: append during ${finalYield ? 'final' : 'chunk'} yield resolves the current graph incrementally`, async t => {
    const h = fixture(t);
    if (!finalYield) fs.appendFileSync(h.file, '{}\n'.repeat(400000));
    h.init();
    cache.refreshFolder(h.folder);
    h.rows.get('old').continuationIndex = null;
    const read = fs.readSync, positions = [];
    let appended = false, scheduled = false;
    t.mock.method(fs, 'readSync', (...args) => {
      const n = read(...args);
      if (appended && args[3] > 64) positions.push(args[4]);
      if (!scheduled) {
        scheduled = true;
        setImmediate(() => {
          fs.appendFileSync(h.file, finalYield
            ? JSON.stringify({ type: 'continued-in', sessionId: 'old', continuedInSessionId: 'bbb' }) + '\n'
            : '{"type":"progress"}\n');
          appended = true;
        });
      }
      return n;
    });
    const result = await cache.resolveSessionContinuations('old', { chunkBytes: 256 * 1024 });
    assert.equal(appended, true);
    assert.equal(result.unresolved, false, 'plain growth must not hold a conversation unresolved');
    assert.deepEqual(result.candidates.map(row => row.sessionId), finalYield ? ['aaa', 'bbb'] : ['aaa']);
    const index = JSON.parse(h.rows.get('old').continuationIndex);
    assert.equal(index.bytes, fs.statSync(h.file).size, 'the appended bytes must be indexed before publishing');
    assert.ok(positions[0] > 0, 'growth resumes the prior cursor');
  });
}

test('#656b background: growth during a synchronous chunk keeps its cursor for the next poll', async t => {
  const h = fixture(t);
  fs.appendFileSync(h.file, '{}\n'.repeat(400000));
  const read = createContinuationReader(h.file, 'old');
  const readSync = fs.readSync, positions = [];
  let appended = false, nextPoll = false;
  t.mock.method(fs, 'readSync', (...args) => {
    const n = readSync(...args);
    if (nextPoll && args[3] > 64) positions.push(args[4]);
    if (!appended && args[3] > 64) {
      fs.appendFileSync(h.file, '{"type":"progress"}\n');
      appended = true;
    }
    return n;
  });
  assert.equal(await read(), null, 'the changing chunk is not published');
  nextPoll = true;
  assert.deepEqual(await read(), ['aaa']);
  assert.ok(positions[0] > 0, 'the next poll must resume instead of rereading from zero');
});

test('#656b refresh: unchanged files avoid a duplicate ISO mtime stat', t => {
  const h = fixture(t);
  fs.utimesSync(h.file, 1792042103.8329908, 1792042103.8329908);
  h.init();
  cache.refreshFolder(h.folder);
  const expectedMtime = fs.statSync(h.file).mtime.toISOString();
  const stat = t.mock.method(fs, 'statSync');
  cache.refreshFolder(h.folder);
  const calls = stat.mock.calls.filter(call => call.arguments[0] === h.file);
  assert.equal(calls.length, 2, 'one invalidation stat plus the existing folder-index stat');
  assert.equal(calls[0].arguments[1]?.bigint, true);
  assert.equal(h.rows.get('old').fileMtime, expectedMtime);
});

test('#656c refresh: exact nanosecond rounding agrees with Node at a millisecond boundary', t => {
  const h = fixture(t);
  fs.utimesSync(h.file, 1791593318.8294998, 1791593318.8294998);
  const stat = fs.statSync;
  t.mock.method(fs, 'statSync', (name, options) => {
    const result = stat(name, options);
    if (name === h.file && options?.bigint) result.mtimeNs = 1791593318829499800n;
    return result;
  });
  assert.equal(stat(h.file).mtime.toISOString(), '2026-10-10T00:48:38.829Z');
  h.init();
  cache.refreshFolder(h.folder);
  fs.appendFileSync(h.file, '{}\n');
  fs.utimesSync(h.file, 1791593318.8294998, 1791593318.8294998);
  cache.refreshFolder(h.folder, { files: new Set(['old.jsonl']) });
  const row = h.rows.get('old');
  assert.equal(row.fileMtime, '2026-10-10T00:48:38.829Z');
  assert.equal(JSON.parse(row.continuationIndex).mtime, row.fileMtime);
});

function expectedStamp(file) {
  const stat = fs.statSync(file, { bigint: true });
  return Object.fromEntries(['dev', 'ino', 'birthtimeNs', 'mtimeNs', 'size'].map(field => [field, stat[field].toString()]));
}

test('#656c cold resolve: a matching persisted stamp resolves with zero bytes read', async t => {
  const h = fixture(t);
  h.init();
  cache.refreshFolder(h.folder);
  for (const row of h.rows.values()) {
    const index = JSON.parse(row.continuationIndex);
    index.stamp = expectedStamp(path.join(h.root, h.folder, row.sessionId + '.jsonl'));
    row.continuationIndex = JSON.stringify(index);
  }
  h.init();
  const read = t.mock.method(fs, 'readSync');
  const fullRead = t.mock.method(fs, 'readFileSync');
  const stat = t.mock.method(fs, 'statSync');
  const result = await cache.resolveSessionContinuations('old');
  assert.equal(result.unresolved, false);
  assert.deepEqual(result.candidates.map(row => row.sessionId), ['aaa']);
  assert.equal(read.mock.callCount(), 0, 'even the head and tail must not be read');
  assert.equal(fullRead.mock.callCount(), 0);
  assert.equal(stat.mock.callCount(), 2, 'one BigInt stat for each visited node');
  assert.ok(stat.mock.calls.every(call => call.arguments[1]?.bigint));
  assert.doesNotThrow(() => JSON.stringify([...h.rows.values()]));
});

for (const change of ['colliding inode', 'birthtime', 'sub-ms mtime']) {
  test(`#656c cold resolve: persisted ${change} mismatch rescans an equal-size replacement`, async t => {
    const h = fixture(t);
    const changed = stamp(t, h.file, change);
    h.init();
    cache.refreshFolder(h.folder);
    const index = JSON.parse(h.rows.get('old').continuationIndex);
    assert.deepEqual(index.stamp, expectedStamp(h.file));
    const replacement = h.text('bbb');
    assert.equal(Buffer.byteLength(replacement), fs.statSync(h.file).size);
    assert.equal(replacement.slice(-64), h.text('aaa').slice(-64));
    fs.renameSync(h.file, h.file + '.previous');
    fs.writeFileSync(h.file, replacement);
    changed();
    h.init();
    const result = await cache.resolveSessionContinuations('old');
    assert.equal(result.unresolved, false);
    assert.deepEqual(result.candidates.map(row => row.sessionId), ['bbb']);
    assert.deepEqual(JSON.parse(h.rows.get('old').continuationIndex).stamp, expectedStamp(h.file));
    assert.doesNotThrow(() => JSON.stringify([...h.rows.values()]));
  });
}

test('#656c cold resolve: a legacy index rescans once, persists the stamp and survives another restart', async t => {
  const h = fixture(t);
  h.init();
  cache.refreshFolder(h.folder);
  for (const row of h.rows.values()) {
    const index = JSON.parse(row.continuationIndex);
    delete index.stamp;
    row.continuationIndex = JSON.stringify(index);
  }
  h.init();
  const read = t.mock.method(fs, 'readSync');
  assert.deepEqual((await cache.resolveSessionContinuations('old')).candidates.map(row => row.sessionId), ['aaa']);
  assert.ok(read.mock.callCount() > 0);
  assert.deepEqual(JSON.parse(h.rows.get('old').continuationIndex).stamp, expectedStamp(h.file));
  h.init();
  read.mock.resetCalls();
  assert.deepEqual((await cache.resolveSessionContinuations('old')).candidates.map(row => row.sessionId), ['aaa']);
  assert.equal(read.mock.callCount(), 0);
  assert.doesNotThrow(() => JSON.stringify([...h.rows.values()]));
});

for (const field of ['dev', 'ino', 'birthtimeNs', 'mtimeNs', 'size']) {
  test(`#656c full scan: a ${field} change during the read cannot persist a trusted stamp`, t => {
    const h = fixture(t);
    const stat = fs.statSync, readFile = fs.readFileSync;
    let read = false;
    t.mock.method(fs, 'readFileSync', (name, ...args) => {
      const result = readFile(name, ...args);
      if (name === h.file) read = true;
      return result;
    });
    t.mock.method(fs, 'statSync', (name, options) => {
      const result = stat(name, options);
      if (name === h.file && options?.bigint && read) result[field] += 1n;
      return result;
    });
    const row = cache.readSessionFile(h.file, h.folder, h.root);
    assert.ok(row);
    assert.equal(row.continuationIndex, null);
    assert.doesNotThrow(() => JSON.stringify(row));
  });
}

test('#656c worker population: persisted complete indexes carry exact stamps and resolve cold without reads', async t => {
  const h = fixture(t);
  h.db.isInitialScanComplete = () => true;
  h.db.setInitialScanComplete = () => {};
  h.init();
  await cache.populateCacheViaWorker();
  assert.equal(h.rows.size, 3);
  for (const row of h.rows.values()) {
    assert.deepEqual(JSON.parse(row.continuationIndex).stamp,
      expectedStamp(path.join(h.root, h.folder, row.sessionId + '.jsonl')));
  }
  assert.doesNotThrow(() => JSON.stringify([...h.rows.values()]));
  h.init();
  const read = t.mock.method(fs, 'readSync');
  const result = await cache.resolveSessionContinuations('old');
  assert.equal(result.unresolved, false);
  assert.deepEqual(result.candidates.map(row => row.sessionId), ['aaa']);
  assert.equal(read.mock.callCount(), 0);
});
