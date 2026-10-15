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
    getCachedByFolder: () => [...rows.values()], getCachedSession: id => rows.get(id),
    upsertCachedSessions: entries => entries.forEach(row => { JSON.stringify(row); rows.set(row.sessionId, row); }),
    setCachedContinuationIndex(id, serialized) { rows.set(id, { ...rows.get(id), continuationIndex: serialized }); },
    setFolderMeta(id, projectPath, indexMtimeMs) { meta.set(id, { projectPath, indexMtimeMs }); },
    getMeta() {}, setName() {}, upsertSearchEntries() {}, replaceSessionMetrics() {}, touchCachedModified() {},
    deleteCachedFolder() {}, deleteCachedSession() {}, deleteSearchFolder() {}, deleteSearchSession() {},
  };
  const init = () => cache.init({ PROJECTS_DIR: root, db, activeSessions: new Map(), getMainWindow: () => null, log: console });
  return { file, folder, rows, text, init };
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
