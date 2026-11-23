'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = require('./fixtures/warm-start-1144.cjs');
const codex = require('./fixtures/warm-start-1152.cjs');
require('./fixtures/isolated-codex-home.cjs')(test);
const options = { skip: !base.supported && 'SQLite fixture unavailable on Node 20' };

for (const runtime of ['claude', 'codex']) {
  test(runtime + ': a deterministic failure preserves the old row and survives reopening', options, async t => {
    const f = await (runtime === 'codex' ? codex : base).fixture(t);
    const folder = runtime === 'codex' ? f.codexFolder : f.folder;
    const file = runtime === 'codex' ? f.codexWrite(0, 'old') : f.write('old', 'old');
    if (runtime === 'codex') f.codexWrite(1); else f.write('neighbor');
    assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
    fs.appendFileSync(file, '\n');
    const inventory = [{ folder, meta: f.db.getFolderMeta(folder), rows: f.db.getCachedByFolder(folder), metadata: [] }];
    const open = fs.openSync;
    const patch = t.mock.method(fs, 'openSync', function (target, ...args) {
      if (target === file && /at (?:Object\.)?readSessionFile /.test(new Error().stack)) throw new RangeError('synthetic deterministic failure');
      return open.call(this, target, ...args);
    });
    const messages = codex.scan({ projectsDir: f.projects, inventory, scope: [folder], disabledHarnesses: [] });
    patch.mock.restore();
    const result = messages.find(msg => msg.result)?.result;
    assert.ok(result?.readFailures?.length, 'deterministic failure produces a durable witness instead of failing its folder');
    await f.writer.writeScannedFolderPartial(result);
    const id = runtime === 'codex' ? f.ids[0] : 'old';
    assert.equal(f.db.getCachedSession(id).summary, 'old');
    assert.equal(f.db.getCachedSession(id).fullReadStamp, null);
    assert.equal(f.db.getFolderMeta(folder).fullIndexPending, null);
    await f.reopen();
    assert.equal((await f.restart()).ok, true);
    assert.equal(f.scans().find(item => item.folder === folder).filesRead, 0);
    let refreshReads = 0;
    const refreshOpen = t.mock.method(fs, 'openSync', function (target, ...args) {
      if (target === file && /scanLines/.test(new Error().stack)) refreshReads++;
      return open.call(this, target, ...args);
    });
    await f.writer.refreshFolder(folder);
    refreshOpen.mock.restore();
    assert.equal(refreshReads, 1, 'explicit refresh retries the witnessed source');
    fs.appendFileSync(file, '\n');
    assert.equal((await f.restart()).ok, true);
    assert.equal(f.scans().find(item => item.folder === folder).filesRead, 1);
    await base.assertRebuildOracle(t, f);
  });
}

for (const kind of ['P full baseline', 'S sealed baseline']) {
  test(kind + ': a failed transcript seals its neighbors and retries only after change', options, async t => {
    const f = await base.fixture(t);
    f.write('good1'); f.write('good2');
    assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
    if (kind.startsWith('P')) f.db.connection.prepare('UPDATE cache_meta SET fullIndexVersion = NULL, fullIndexConfig = NULL').run();
    const bad = f.write('poison', [{ type: 'text', text: 42 }]);
    assert.equal((await f.restart()).ok, true, 'one parse failure must not fail the folder');
    assert.equal(f.scans()[0].filesFailed, 1);
    assert.equal(f.db.getFolderMeta(f.folder).fullIndexPending, null);
    assert.equal(f.db.getFolderMeta(f.folder).fullIndexVersion, 1);
    const failures = f.logs.filter(line => line.startsWith('[index] read failed '));
    assert.equal(failures.length, 1, 'failed path and error logged once');
    assert.equal(failures[0], `[index] read failed folder=${f.folder} file=${path.basename(bad)} size=${fs.statSync(bad).size} error=TypeError`);
    await f.reopen();
    assert.equal((await f.restart()).ok, true);
    assert.equal(f.scans()[0].filesRead, 0, 'unchanged failed source has a durable failure witness');
    assert.equal(f.logs.filter(line => line.startsWith('[index] read failed ')).length, 0);
    const open = fs.openSync;
    let refreshReads = 0;
    const patch = t.mock.method(fs, 'openSync', function (target, ...args) {
      if (target === bad && /scanLines/.test(new Error().stack)) refreshReads++;
      return open.call(this, target, ...args);
    });
    await f.writer.refreshFolder(f.folder);
    patch.mock.restore();
    assert.equal(refreshReads, 1, 'explicit refresh retries an unchanged unindexed failure');
    f.write('poison', 'repaired');
    assert.equal((await f.restart()).ok, true);
    assert.equal(f.scans()[0].filesRead, 1, 'only the changed failed file is retried');
    assert.equal(f.db.getCachedSession('poison').summary, 'repaired');
    await base.assertRebuildOracle(t, f);
  });
}

for (const runtime of ['claude', 'codex']) {
  test('L ' + runtime + ': a live write seals the folder and the next start reads only the deferred source', options, async t => {
    const f = await (runtime === 'codex' ? codex : base).fixture(t);
    const folder = runtime === 'codex' ? f.codexFolder : f.folder;
    if (runtime === 'codex') { f.codexWrite(0); f.codexWrite(1); }
    else { f.write('quiet'); f.write('live'); }
    assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
    f.db.connection.prepare('UPDATE cache_meta SET fullIndexVersion = NULL, fullIndexConfig = NULL WHERE folder = ?').run(folder);
    const live = runtime === 'codex' ? f.codexWrite(1, 'changed') : f.write('live', 'changed');
    const rowId = runtime === 'codex' ? f.ids[1] : 'live';
    const inventory = [{ folder, meta: f.db.getFolderMeta(folder), rows: f.db.getCachedByFolder(folder), metadata: [] }];
    const open = fs.openSync, read = fs.readSync, readFile = fs.readFileSync;
    const handles = new Set();
    let appended = false;
    const append = () => { if (!appended && /at (?:Object\.)?readSessionFile /.test(new Error().stack)) { appended = true; fs.appendFileSync(live, JSON.stringify({ type: 'progress', padding: 'appended during scan' }) + '\n'); } };
    const patches = [
      t.mock.method(fs, 'openSync', function (file, ...args) { const fd = open.call(this, file, ...args); if (file === live) handles.add(fd); return fd; }),
      t.mock.method(fs, 'readSync', function (fd, ...args) { const n = read.call(this, fd, ...args); if (handles.has(fd)) append(); return n; }),
      t.mock.method(fs, 'readFileSync', function (file, ...args) { const bytes = readFile.call(this, file, ...args); if (file === live) append(); return bytes; }),
    ];
    const messages = codex.scan({ projectsDir: f.projects, inventory, scope: [folder], disabledHarnesses: [] });
    for (const patch of patches) patch.mock.restore();
    const result = messages.find(msg => msg.type === 'folder').result;
    assert.equal(appended, true);
    assert.ok(result.deferred.includes(path.basename(live)));
    await f.writer.writeScannedFolderPartial(result);
    assert.equal(f.db.getFolderMeta(folder).fullIndexPending, null, 'a live source must not leave the folder pending');
    assert.equal(f.db.getFolderMeta(folder).fullIndexVersion, 1, 'partial startup publication restores the content version');
    assert.equal(f.db.getCachedSession(rowId).fullReadStamp, null, 'only the live source remains uncertified');
    await f.reopen();
    assert.equal((await f.restart()).ok, true);
    const scan = f.scans().find(item => item.folder === folder);
    assert.equal(scan.filesRead, 1, 'second start reads only the deferred source');
    await base.assertRebuildOracle(t, f);
  });
}
