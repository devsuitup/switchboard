'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const openStore = require('./fixtures/conversation-store.cjs');
const { timers, setup, failReads } = require('./fixtures/deferred-1193.cjs');
const options = { skip: !openStore.supported && 'SQLite fixture unavailable on Node 20' };
require('./fixtures/isolated-codex-home.cjs')(test);

async function bridgeFixture(t) {
  const state = await setup(t);
  const { f } = state;
  const bridge = [{ type: 'bridge-session', bridgeSessionId: 'bridge-1213' }];
  const bad = f.write('bridge-bad', 'bad', bridge);
  const sibling = f.write('bridge-sibling', 'sibling', bridge);
  assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
  assert.equal(f.db.getCachedSession('bridge-sibling').bridgeSessionId, 'bridge-1213');
  f.logs.length = 0;
  state.warnings.length = 0;
  return { ...state, bad, sibling };
}

test('a changed bridge winner converges after reconcile across two restarts', options, async t => {
  const { f, folder } = await setup(t);
  const bridge = [{ type: 'bridge-session', bridgeSessionId: 'bridge-winner-1213' }];
  const sibling = f.write('a-winner', 'winner', bridge);
  const bad = f.write('z-bad', 'bad', bridge);
  assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
  const winner = f.db.getCachedSession('a-winner');
  assert.equal(winner.created, f.db.getCachedSession('z-bad').created);
  assert.equal(winner.mergedIntoSessionId, null);
  fs.appendFileSync(bad, '\n');
  fs.appendFileSync(sibling, JSON.stringify({ type: 'user', uuid: 'winner-added', cwd: f.root,
    timestamp: '2024-01-02T00:00:00.000Z', message: { content: 'winner changed' } }) + '\n');
  fs.utimesSync(sibling, new Date('2025-01-01'), new Date('2025-01-01'));
  timers(t);
  failReads(t, f, [bad], 'ERR_STRING_TOO_LONG');
  assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
  assert.equal(f.db.getCachedSession('a-winner').messageCount, winner.messageCount);
  f.cache.init({ PROJECTS_DIR: f.projects, activeSessions: f.activeSessions, getMainWindow: () => null,
    db: f.db, log: { info() {}, warn() {}, error() {} } });
  await f.cache.reconcileCacheFromFilesystemAsync({ throttle: false });
  const refreshed = f.db.getCachedSession('a-winner');
  assert.equal(refreshed.messageCount, winner.messageCount + 1);
  assert.equal(refreshed.fullReadStamp, null, 'the winner takes the header-only refresh path');
  assert.equal(refreshed.modified, refreshed.fileMtime);
  const open = fs.openSync;
  let opens = 0;
  t.mock.method(fs, 'openSync', function (file, ...args) {
    if (file === bad) opens++;
    return open.call(this, file, ...args);
  });
  for (let restart = 1; restart <= 2; restart++) {
    await f.reopen();
    assert.equal((await f.restart()).ok, true);
    assert.equal(f.db.getFolderMeta(folder).indexMtimeMs,
      require('../folder-index-state').getFolderIndexMtimeMs(f.dir),
      `restart ${restart}: a reconciled winner keeps the real folder mtime`);
    assert.equal(f.scans().find(scan => scan.folder === folder).filesDeferred, 0,
      `restart ${restart}: a reconciled winner is no longer deferred`);
    f.cache.init({ PROJECTS_DIR: f.projects, activeSessions: f.activeSessions, getMainWindow: () => null,
      db: f.db, log: { info() {}, warn() {}, error() {} } });
    await f.cache.reconcileCacheFromFilesystemAsync({ throttle: false });
    assert.equal(opens, 0, `restart ${restart}: the witnessed source is not reopened`);
  }
});

test('bridge repair completes on the first run for a mirror sharing predecessor UUIDs', options, async t => {
  const { f, folder, bad, sibling } = await bridgeFixture(t);
  fs.writeFileSync(sibling, fs.readFileSync(bad, 'utf8') + JSON.stringify({ type: 'user',
    uuid: 'mirror-added', cwd: f.root, timestamp: '2024-01-02T00:00:00.000Z',
    message: { content: 'mirror continuation' } }) + '\n');
  assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
  assert.equal(f.db.getCachedSession('bridge-sibling').mergedIntoSessionId, 'bridge-bad',
    'the inventory contains a real compaction mirror');
  fs.appendFileSync(bad, '\n');
  timers(t);
  failReads(t, f, [bad], 'ERR_STRING_TOO_LONG');
  await f.writer.setSetting('bridge_uuid_reindex_folders', [folder]);
  assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
  assert.deepEqual(Array.from(f.db.getSetting('bridge_uuid_reindex_folders')), [],
    'an unchanged mirror must complete the pending repair on the first run');
});

test('a bridge sibling deleted before startup is removed by reconcile', options, async t => {
  const { f, bad, sibling } = await bridgeFixture(t);
  fs.appendFileSync(bad, '\n');
  fs.unlinkSync(sibling);
  timers(t);
  failReads(t, f, [bad], 'ERR_STRING_TOO_LONG');
  assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
  f.cache.init({ PROJECTS_DIR: f.projects, activeSessions: f.activeSessions, getMainWindow: () => null,
    db: f.db, log: { info() {}, warn() {}, error() {} } });
  await f.cache.reconcileCacheFromFilesystemAsync({ throttle: false });
  assert.ok(!f.db.getCachedSession('bridge-sibling'), 'reconcile must remove the deleted sibling row');
});

test('bridge repair completes despite a persistent deterministic failure', options, async t => {
  const { f, folder, bad } = await bridgeFixture(t);
  fs.appendFileSync(bad, '\n');
  timers(t);
  failReads(t, f, [bad], 'ERR_STRING_TOO_LONG');
  await f.writer.setSetting('bridge_uuid_reindex_folders', [folder]);
  assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
  assert.deepEqual(Array.from(f.db.getSetting('bridge_uuid_reindex_folders')), [],
    'the first startup must complete the bridge repair');
  await f.reopen();
  assert.equal((await f.restart()).ok, true);
  assert.notEqual(f.scans().find(scan => scan.folder === folder).reason, 'version',
    'completed repair must not invalidate the next startup');
});

for (const check of ['mtime', 'deferred', 'reconcile', 'null-stamp']) {
  test(`unchanged bridge sibling after restart: ${check}`, options, async t => {
    const { f, folder, bad } = await bridgeFixture(t);
    fs.appendFileSync(bad, '\n');
    timers(t);
    failReads(t, f, [bad], 'ERR_STRING_TOO_LONG');
    assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
    if (check === 'null-stamp') f.db.invalidateFullRead('bridge-sibling');
    await f.reopen();
    assert.equal((await f.restart()).ok, true);
    if (check === 'mtime') assert.equal(f.db.getFolderMeta(folder).indexMtimeMs,
      require('../folder-index-state').getFolderIndexMtimeMs(f.dir), 'unchanged siblings keep the real folder mtime');
    if (check === 'deferred' || check === 'null-stamp') assert.equal(f.scans().find(scan => scan.folder === folder).filesDeferred, 0,
      'unchanged siblings must not be deferred again');
    if (check === 'reconcile') {
      const open = fs.openSync;
      let opens = 0;
      t.mock.method(fs, 'openSync', function (file, ...args) {
        if (file === bad) opens++;
        return open.call(this, file, ...args);
      });
      f.cache.init({ PROJECTS_DIR: f.projects, activeSessions: f.activeSessions, getMainWindow: () => null,
        db: f.db, log: { info() {}, warn() {}, error() {} } });
      await f.cache.reconcileCacheFromFilesystemAsync({ throttle: false });
      assert.equal(opens, 0, 'reconcile must not reopen the witnessed source in an unchanged folder');
    }
  });
}

for (const error of ['ERR_STRING_TOO_LONG', 'TypeError', 'SyntaxError']) {
  test(`${error}: a sibling changed before startup is refreshed by reconcile in the same run`, options, async t => {
    const { f, folder, bad, sibling } = await bridgeFixture(t);
    const before = f.db.getCachedSession('bridge-sibling').messageCount;
    fs.appendFileSync(bad, '\n');
    fs.appendFileSync(sibling, JSON.stringify({ type: 'user', uuid: 'changed-sibling', cwd: f.root,
      timestamp: '2024-01-02T00:00:00.000Z', message: { content: 'changed before startup' } }) + '\n');
    const clock = timers(t);
    failReads(t, f, [bad], error);
    assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
    assert.equal(clock.pending.size, 0, 'deterministic failures and their siblings do not arm retries');
    assert.equal(f.db.getCachedSession('bridge-sibling').messageCount, before, 'startup withholds the bridge sibling');
    f.cache.init({ PROJECTS_DIR: f.projects, activeSessions: f.activeSessions, getMainWindow: () => null,
      db: f.db, log: { info() {}, warn() {}, error() {} } });
    await f.cache.reconcileCacheFromFilesystemAsync({ throttle: false });
    assert.equal(f.db.getCachedSession('bridge-sibling').messageCount, before + 1,
      'reconcile must publish the sibling changed before startup without another filesystem change');
    assert.equal(f.scans().find(scan => scan.folder === folder).filesDeferred, 1, 'the withheld sibling remains counted');
  });
}

for (const phase of ['read', 'publication']) {
  test(`${phase}: an unchanged bridge sibling has its own deferral cause`, options, async t => {
    const { f, folder, bad, sibling, warnings } = await bridgeFixture(t);
    fs.appendFileSync(bad, '\n');
    const clock = timers(t);
    const siblingBefore = fs.readFileSync(sibling);
    if (phase === 'read') failReads(t, f, [bad], 'changed', 1);
    else {
      const emit = Worker.prototype.emit;
      let appended = false;
      t.mock.method(Worker.prototype, 'emit', function (event, msg, ...args) {
        if (event === 'message' && msg?.result?.folder === folder && !appended) {
          appended = true;
          fs.appendFileSync(bad, '\n');
        }
        return emit.call(this, event, msg, ...args);
      });
    }
    assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
    assert.deepEqual(fs.readFileSync(sibling), siblingBefore);
    assert.deepEqual(warnings.filter(line => line.includes('file=bridge-sibling.jsonl ')),
      [`[index] read failed folder=${folder} file=bridge-sibling.jsonl size=${siblingBefore.length} error=bridge-sibling`],
      'bridge expansion must not report a race on an unchanged sibling');
    assert.equal(clock.pending.size, 0, 'bridge-sibling is not a retryable read error');
  });
}

test('the final stale replan logs its read errors once before failing the folder', options, async t => {
  const { f, file, folder, warnings } = await setup(t);
  timers(t);
  const emit = Worker.prototype.emit;
  let attempts = 0;
  t.mock.method(Worker.prototype, 'emit', function (event, msg, ...args) {
    if (event === 'message' && msg?.result?.folder === folder) {
      attempts++;
      msg.replan = true;
    }
    return emit.call(this, event, msg, ...args);
  });
  failReads(t, f, [file]);
  const result = await f.cache.populateCacheViaWorker();
  assert.equal(result.ok, false);
  assert.match(result.error, /replan limit reached/);
  assert.equal(attempts, 3, 'initial attempt plus two replans');
  assert.deepEqual(warnings,
    [`[index] read failed folder=${folder} file=${path.basename(file)} size=${fs.statSync(file).size} error=EBUSY`],
    'the rejected final attempt must retain its read-error diagnostic without duplicates');
});
