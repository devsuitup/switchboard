'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const base = require('./fixtures/warm-start-1144.cjs');
const options = { skip: !base.supported && 'SQLite fixture unavailable on Node 20' };
require('./fixtures/isolated-codex-home.cjs')(test);

const { timers, setup, failReads } = require('./fixtures/deferred-1193.cjs');

for (const runtime of ['claude', 'subagent', 'codex']) for (const phase of ['read', 'publication']) {
  for (const check of ['warning', 'retry']) test(`${runtime}: ${phase} race ${check}`, options, async t => {
    const { f, file, id, folder, warnings } = await setup(t, runtime);
    const size = fs.statSync(file).size;
    const clock = timers(t);
    if (phase === 'read') failReads(t, f, [file], 'changed', 1);
    else {
      const emit = Worker.prototype.emit;
      let appended = false;
      t.mock.method(Worker.prototype, 'emit', function (event, msg, ...args) {
        if (event === 'message' && msg?.result?.folder === folder && !appended) {
          appended = true;
          fs.appendFileSync(file, '\n');
        }
        return emit.call(this, event, msg, ...args);
      });
    }
    assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
    assert.equal(f.db.getCachedSession(id).fullReadStamp, null);
    if (check === 'warning') {
      const name = runtime === 'subagent' ? 'parent/' + path.basename(file) : path.basename(file);
      const cause = phase === 'read' ? 'changed-during-read' : 'raced-before-publication';
      assert.deepEqual(warnings, [`[index] read failed folder=${folder} file=${name} size=${size} error=${cause}`], 'every deferred source logs its cause and observed size');
      assert.equal(f.scans().find(scan => scan.folder === folder).filesDeferred, 1, 'publication races appear in folder counters');
    } else {
      assert.equal(clock.pending.size, 0, 'live writes must not arm an in-run retry');
      await f.reopen();
      assert.equal((await f.restart()).ok, true);
      assert.ok(f.db.getCachedSession(id).fullReadStamp, 'next startup still reads the deferred source');
      assert.equal(f.scans().find(scan => scan.folder === folder).filesRead, 1);
    }
  });
}

test('deterministic bridge failure and its siblings arm no retry, including after restart', options, async t => {
  const { f, folder } = await setup(t);
  const bridge = [{ type: 'bridge-session', bridgeSessionId: 'bridge-fix1' }];
  const bad = f.write('bridge-bad', 'bad', bridge);
  f.write('bridge-sibling', 'sibling', bridge);
  assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
  assert.ok(f.db.getCachedByFolder(folder).some(row => row.bridgeSessionId === 'bridge-fix1'), 'fixture creates a bridge group');
  fs.appendFileSync(bad, '\n');
  const clock = timers(t);
  failReads(t, f, [bad], 'ERR_STRING_TOO_LONG');
  assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
  assert.equal(clock.pending.size, 0, 'deterministic bridge siblings must not arm retries');
  assert.ok(f.db.getFolderMeta(folder).indexMtimeMs > 0);
  await f.reopen();
  assert.equal((await f.restart()).ok, true);
  assert.equal(clock.pending.size, 0, 'persisted deterministic bridge failure must not arm retries');
  assert.ok(f.db.getFolderMeta(folder).indexMtimeMs > 0);
});

test('a replanned result logs each source only on the accepted attempt', options, async t => {
  const { f, file, folder, warnings } = await setup(t);
  timers(t);
  failReads(t, f, [file]);
  const emit = Worker.prototype.emit;
  let replanned = false;
  t.mock.method(Worker.prototype, 'emit', function (event, msg, ...args) {
    if (event === 'message' && msg?.result?.folder === folder && !replanned) {
      replanned = true;
      msg.replan = true;
    }
    return emit.call(this, event, msg, ...args);
  });
  assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
  assert.equal(replanned, true);
  assert.equal(warnings.length, 1, 'replanned results must not duplicate warnings');
});
