'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = require('./fixtures/warm-start-1144.cjs');
const codex = require('./fixtures/warm-start-1152.cjs');
require('./fixtures/isolated-codex-home.cjs')(test);
const options = { skip: !base.supported && 'SQLite requires native binding or Node 22' };

async function failedRead(t, runtime, error) {
  const f = await (runtime === 'codex' ? codex : base).fixture(t);
  const folder = runtime === 'codex' ? f.codexFolder : f.folder;
  const write = text => runtime === 'codex' ? f.codexWrite(0, text) : f.write('old', text);
  write('old');
  if (runtime === 'codex') f.codexWrite(1); else f.write('neighbor');
  assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
  const file = write('recovered');
  const inventory = [{ folder, meta: f.db.getFolderMeta(folder), rows: f.db.getCachedByFolder(folder), metadata: [] }];
  const open = fs.openSync, read = fs.readSync;
  const handles = new Set();
  let injected = 0;
  const patches = [t.mock.method(fs, 'openSync', function (target, ...args) {
    const body = target === file && /at (?:Object\.)?readSessionFile /.test(new Error().stack);
    if (body && error !== 'short') { injected++; throw error === 'TypeError' ? new TypeError('synthetic derivation error') : Object.assign(new Error('synthetic I/O failure'), { code: error }); }
    const fd = open.call(this, target, ...args);
    if (body) handles.add(fd); else handles.delete(fd);
    return fd;
  }), t.mock.method(fs, 'readSync', function (fd, ...args) {
    if (handles.has(fd) && error === 'short') { injected++; return 0; }
    return read.call(this, fd, ...args);
  })];
  const messages = codex.scan({ projectsDir: f.projects, inventory, scope: [folder], disabledHarnesses: [] });
  for (const patch of patches) patch.mock.restore();
  assert.ok(injected > 0, 'failure reaches the production body reader');
  assert.equal(messages.at(-1).ok, true, 'file failure still seals the folder');
  const result = messages.find(msg => msg.result)?.result;
  await f.writer.writeScannedFolderPartial(result);
  const id = runtime === 'codex' ? f.ids[0] : 'old';
  assert.equal(f.db.getCachedSession(id).summary, 'old');
  assert.equal(f.db.getCachedSession(id).fullReadStamp, null);
  assert.equal(f.db.getFolderMeta(folder).fullIndexPending, null);
  return { f, folder, file, id, result };
}

for (const runtime of ['claude', 'codex']) {
  for (const code of ['EBUSY', 'EACCES', 'EPERM', 'EMFILE', 'ENFILE', 'EIO', 'EAGAIN', 'short']) {
    test(`${runtime}: transient ${code} recovers on next start`, options, async t => {
      const { f, folder, file, id, result } = await failedRead(t, runtime, code);
      assert.equal(result.readFailures.length, 0, 'transient failures must not become durable witnesses');
      assert.ok(result.deferred.includes(path.basename(file)));
      await f.reopen();
      assert.equal((await f.restart()).ok, true);
      assert.equal(f.db.getCachedSession(id).summary, 'recovered');
      assert.ok(f.db.getCachedSession(id).fullReadStamp);
      assert.equal(f.scans().find(scan => scan.folder === folder).filesRead, 1);
      await base.assertRebuildOracle(t, f);
    });
  }
  for (const mode of ['force', 'version', 'config', 'watcher']) {
    test(`${runtime}: ${mode} recovers a deterministic witness`, options, async t => {
      const { f, folder, file, id, result } = await failedRead(t, runtime, 'TypeError');
      assert.equal(result.readFailures.length, 1);
      if (mode === 'version') f.db.connection.prepare('UPDATE cache_meta SET fullIndexVersion = 99').run();
      if (mode === 'config') f.db.connection.prepare("UPDATE cache_meta SET fullIndexConfig = 'old'").run();
      if (mode === 'watcher') await f.writer.refreshFolder(folder, { files: new Set([path.basename(file)]) });
      else assert.equal((await f.restart({ force: mode === 'force' })).ok, true);
      assert.equal(f.db.getCachedSession(id).summary, 'recovered', 'explicit invalidation retries the witnessed source');
      assert.ok(f.db.getCachedSession(id).fullReadStamp);
      assert.equal(JSON.parse(f.db.getFolderMeta(folder).readFailures || '[]').length, 0);
      await base.assertRebuildOracle(t, f);
    });
  }
  test(`${runtime}: unchanged deterministic witness retains folder mtime and unique checks`, options, async t => {
    const { f, folder, result } = await failedRead(t, runtime, 'TypeError');
    assert.ok(result.indexMtimeMs > 0, 'deterministic witnesses retain the real folder index mtime');
    assert.equal(new Set(result.checks.map(([file]) => file)).size, result.checks.length, 'failure stamps are not duplicated');
    await f.reopen();
    assert.equal((await f.restart()).ok, true);
    assert.equal(f.scans().find(scan => scan.folder === folder).filesRead, 0);
    assert.equal(f.db.getFolderMeta(folder).indexMtimeMs, result.indexMtimeMs);
  });
}
