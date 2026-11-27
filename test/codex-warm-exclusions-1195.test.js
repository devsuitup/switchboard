'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const openStore = require('./fixtures/conversation-store.cjs');
const fx = require('./fixtures/warm-start-1152.cjs');
require('./fixtures/isolated-codex-home.cjs')(test);
const options = { skip: !openStore.supported && 'SQLite requires native binding or Node 22' };

const excluded = {
  empty: () => '',
  malformed: () => '{incomplete json',
  'no metadata': cwd => fx.body(cwd, 'orphan').split('\n').filter(line => !line.includes('session_meta')).join('\n'),
  'no prompt': cwd => JSON.stringify({ type: 'session_meta', payload: { cwd } }) + '\n',
  subagent: cwd => fx.body(cwd, 'excluded', { thread_source: 'subagent' }),
};

for (const [kind, content] of Object.entries(excluded)) {
  test('Codex unchanged ' + kind + ' is skipped after reopening, then becomes a session', options, async t => {
    const f = await fx.fixture(t);
    f.codexWrite(0, 'neighbor');
    const file = f.codexWrite(1);
    fs.writeFileSync(file, content(f.root));
    assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
    assert.equal(f.db.getCachedSession(f.ids[1]), null);
    await f.reopen();
    const warmReads = [];
    for (let i = 0; i < 2; i++) {
      assert.equal((await f.restart()).ok, true);
      warmReads.push(f.codexScans()[0].filesRead);
    }
    assert.deepEqual(warmReads, [0, 0], 'unchanged excluded rollout must not be reread on either warm start');
    assert.equal(f.codexScans()[0].reason, 'unchanged');
    assert.equal(f.codexScans()[0].filesFailed, 0);
    await f.writer.refreshFolder(f.codexFolder);
    await f.reopen();
    assert.equal((await f.restart()).ok, true);
    assert.equal(f.codexScans()[0].filesRead, 0, 'refresh preserves the negative observation');
    const stamp = fs.statSync(file);
    fs.writeFileSync(file, fx.body(f.root, 'now a real session'));
    fs.utimesSync(file, stamp.atime, stamp.mtime);
    assert.equal((await f.restart()).ok, true);
    assert.equal(f.codexScans()[0].filesRead, 1, 'changed exclusion is reconsidered');
    assert.equal(f.db.getCachedSession(f.ids[1]).summary, 'now a real session');
    assert.ok(f.db.getCachedSession(f.ids[1]).fullReadStamp);
    assert.equal((await f.restart()).ok, true);
    assert.equal(f.codexScans()[0].filesRead, 0);
  });
}

test('Codex exec and deterministic parse rejection already survive reopening', options, async t => {
  const f = await fx.fixture(t);
  f.codexWrite(0, 'exec', { meta: { originator: 'codex_exec' } });
  const rejected = f.codexWrite(1);
  fs.writeFileSync(rejected, 'null\n');
  assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
  assert.equal(f.db.getCachedSession(f.ids[0]).entrypoint, 'sdk-codex-exec');
  assert.equal(f.db.getCachedSession(f.ids[1]), null);
  assert.equal(JSON.parse(f.db.getFolderMeta(f.codexFolder).readFailures)[0][1].error, 'TypeError');
  await f.reopen();
  for (let i = 0; i < 2; i++) {
    assert.equal((await f.restart()).ok, true);
    assert.equal(f.codexScans()[0].filesRead, 0);
  }
});

test('Codex append during a full read is retried once and then stays unchanged', options, async t => {
  const f = await fx.fixture(t);
  const file = f.codexWrite(0);
  assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
  fs.appendFileSync(file, '\n');
  const inventory = [{ folder: f.codexFolder, rows: f.db.getCachedByFolder(f.codexFolder), meta: f.db.getFolderMeta(f.codexFolder), metadata: [] }];
  const original = fs.readSync;
  let appended = false;
  const patch = t.mock.method(fs, 'readSync', function (...args) {
    const bytes = original.apply(this, args);
    if (!appended && /readSessionFile/.test(new Error().stack)) {
      appended = true;
      fs.appendFileSync(file, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'late append' } }) + '\n');
    }
    return bytes;
  });
  const messages = fx.scan({ projectsDir: f.projects, inventory, scope: [f.codexFolder], disabledHarnesses: [] });
  patch.mock.restore();
  assert.ok(appended, 'append reached the actual parser read');
  const result = messages.find(message => message.result)?.result;
  assert.ok(result.deferred.includes(path.basename(file)), 'raced observation is not certified');
  await f.writer.writeScannedFolderPartial(result);
  await f.reopen();
  assert.equal((await f.restart()).ok, true);
  assert.equal(f.codexScans()[0].filesRead, 1);
  assert.equal(f.db.getCachedSession(f.ids[0]).messageCount, 2);
  assert.equal((await f.restart()).ok, true);
  assert.equal(f.codexScans()[0].filesRead, 0, 'settled append does not repeat forever');
});

for (const mode of ['force', 'version', 'config']) {
  test('Codex ' + mode + ' revalidates exclusions and reseals them', options, async t => {
    const f = await fx.fixture(t);
    f.codexWrite(0);
    const file = f.codexWrite(1);
    fs.writeFileSync(file, '');
    assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
    if (mode === 'version') f.db.connection.prepare('UPDATE cache_meta SET fullIndexVersion = 99').run();
    if (mode === 'config') f.db.connection.prepare("UPDATE cache_meta SET fullIndexConfig = 'old'").run();
    assert.equal((await f.restart({ force: mode === 'force' })).ok, true);
    assert.equal(f.codexScans()[0].filesRead, 2, 'explicit invalidation retries both sources');
    await f.reopen();
    assert.equal((await f.restart()).ok, true);
    assert.equal(f.codexScans()[0].filesRead, 0, 'revalidated exclusion is durable');
    fs.unlinkSync(file);
    assert.equal((await f.restart()).ok, true);
    assert.deepEqual(JSON.parse(f.db.getFolderMeta(f.codexFolder).readFailures || '[]'), [], 'removed exclusion is pruned');
  });
}

test('Codex a session becoming excluded is deleted once and stays skipped', options, async t => {
  const f = await fx.fixture(t);
  f.codexWrite(0, 'neighbor');
  const file = f.codexWrite(1);
  assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
  fs.writeFileSync(file, '');
  assert.equal((await f.restart()).ok, true);
  assert.equal(f.db.getCachedSession(f.ids[1]), null);
  await f.reopen();
  assert.equal((await f.restart()).ok, true);
  assert.equal(f.codexScans()[0].filesRead, 0, 'deleted session leaves a durable exclusion');
});
