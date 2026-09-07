'use strict';

// The scheduler: what it does with no host declared (nothing at all), and how
// it isolates a failing host. Timers and the transport are injected, so no
// wall-clock wait and no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createRemoteIndexer } = require('../remote-index');
const { MIN_REFRESH_MS } = require('../remote-hosts');

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-' + name + '-'));
}

/** A transport that fails the test if anything touches it. */
function forbiddenTransport() {
  const boom = () => { throw new Error('transport must not be called'); };
  return { listFiles: boom, fetchFiles: boom };
}

function fakeTimers() {
  const created = [];
  return {
    created,
    setInterval: (fn, ms) => { const h = { fn, ms, cleared: false }; created.push(h); return h; },
    clearInterval: (h) => { if (h) h.cleared = true; },
  };
}

test('no host declared: no timer, no transport call, no mirror directory', async () => {
  const dataDir = tmp('idx-none');
  try {
    const timers = fakeTimers();
    const roots = [];
    const indexer = createRemoteIndexer({
      getHosts: () => [],
      dataDir,
      transport: forbiddenTransport(),
      scanFolders: () => { throw new Error('scanFolders must not be called'); },
      setRemoteRoots: (m) => roots.push(m),
      timers,
      sync: () => { throw new Error('sync must not be called'); },
    });

    assert.equal(indexer.start(), false, 'start() must report it did not arm');
    assert.equal(timers.created.length, 0, 'no interval may be created');
    assert.equal(indexer.isRunning(), false);
    assert.deepEqual(await indexer.refreshNow(), { skipped: true, hosts: 0 });
    assert.equal(fs.existsSync(path.join(dataDir, 'remote')), false, 'nothing written to disk');
    assert.ok(roots.every(m => m.size === 0), 'the cache is told there are no remote roots');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('a host declared but disabled is treated as no host at all', () => {
  const dataDir = tmp('idx-off');
  try {
    const timers = fakeTimers();
    const indexer = createRemoteIndexer({
      getHosts: () => [{ alias: 'vps', enabled: false }],
      dataDir,
      transport: forbiddenTransport(),
      timers,
      sync: () => { throw new Error('sync must not be called'); },
    });
    assert.equal(indexer.start(), false);
    assert.equal(timers.created.length, 0);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('a declared host arms one timer no faster than 60 s and indexes what changed', async () => {
  const dataDir = tmp('idx-one');
  try {
    const timers = fakeTimers();
    const scans = [];
    let notified = 0;
    const indexer = createRemoteIndexer({
      getHosts: () => [{ alias: 'planificator', label: 'VPS' }],
      getRefreshMs: () => 1000, // asked for 1 s, must be floored
      dataDir,
      transport: {},
      scanFolders: (args) => { scans.push(args); return Promise.resolve({ ok: true }); },
      listIndexedFolderKeys: () => [],
      notify: () => { notified++; },
      timers,
      sync: async ({ projectsDir }) => {
        fs.mkdirSync(path.join(projectsDir, '-srv-supervision'), { recursive: true });
        return { fetched: 1, unchanged: 0, removed: 0, failed: 0, total: 1, changedFolders: new Set(['-srv-supervision']) };
      },
    });

    await indexer.refreshNow();

    assert.ok(scans.length >= 1, 'the mirror is indexed');
    assert.equal(scans[0].folderPrefix, 'planificator', 'rows must be keyed under the alias');
    assert.deepEqual(scans[0].folders, ['-srv-supervision']);
    assert.equal(scans[0].projectsDir, path.join(dataDir, 'remote', 'planificator', 'projects'));
    assert.ok(notified > 0, 'the sidebar is told to refresh');

    assert.equal(indexer.start(), true);
    assert.equal(timers.created.length, 1, 'exactly one interval');
    assert.equal(timers.created[0].ms, MIN_REFRESH_MS, 'a 1 s request is floored to 60 s');

    indexer.stop();
    assert.equal(timers.created[0].cleared, true);
    assert.equal(indexer.isRunning(), false);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('a failing host is logged and does not stop its peer', async () => {
  const dataDir = tmp('idx-fail');
  try {
    const scans = [];
    const warnings = [];
    const indexer = createRemoteIndexer({
      getHosts: () => [{ alias: 'dead' }, { alias: 'alive' }],
      dataDir,
      transport: {},
      scanFolders: (args) => { scans.push(args.folderPrefix); return Promise.resolve({ ok: true }); },
      listIndexedFolderKeys: () => [],
      log: { info() {}, warn: (m) => warnings.push(m), error() {} },
      timers: fakeTimers(),
      sync: async ({ alias, projectsDir }) => {
        if (alias === 'dead') throw new Error('ssh: connect to host dead port 22: timed out');
        fs.mkdirSync(path.join(projectsDir, '-srv-x'), { recursive: true });
        return { fetched: 1, unchanged: 0, removed: 0, failed: 0, total: 1, changedFolders: new Set(['-srv-x']) };
      },
    });

    const r = await indexer.refreshNow();

    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].alias, 'dead');
    assert.deepEqual(scans, ['alive'], 'the healthy host is still indexed');
    assert.ok(warnings.some(w => w.includes('dead')));
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('a mirror already on disk but absent from the cache is indexed once', async () => {
  const dataDir = tmp('idx-cold');
  try {
    const projectsDir = path.join(dataDir, 'remote', 'vps', 'projects');
    fs.mkdirSync(path.join(projectsDir, '-srv-a'), { recursive: true });
    fs.mkdirSync(path.join(projectsDir, '-srv-b'), { recursive: true });

    const scans = [];
    let indexed = [];
    const indexer = createRemoteIndexer({
      getHosts: () => [{ alias: 'vps' }],
      dataDir,
      transport: {},
      scanFolders: (args) => { scans.push(args.folders); return Promise.resolve({ ok: true }); },
      listIndexedFolderKeys: () => indexed,
      timers: fakeTimers(),
      // Nothing changed remotely.
      sync: async () => ({ fetched: 0, unchanged: 2, removed: 0, failed: 0, total: 2, changedFolders: new Set() }),
    });

    await indexer.refreshNow();
    assert.deepEqual(scans[0].sort(), ['-srv-a', '-srv-b'], 'an unindexed mirror is picked up');

    indexed = ['vps::-srv-a', 'vps::-srv-b'];
    await indexer.refreshNow();
    assert.equal(scans.length, 1, 'a second pass with nothing new does not rescan');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('folders of an undeclared alias are dropped from the cache', async () => {
  const dataDir = tmp('idx-prune');
  try {
    const dropped = [];
    const indexer = createRemoteIndexer({
      getHosts: () => [{ alias: 'vps' }],
      dataDir,
      transport: {},
      scanFolders: () => Promise.resolve({ ok: true }),
      listIndexedFolderKeys: () => ['C--Serveur-switchboard', 'vps::-srv-a', 'gone::-srv-old'],
      dropFolder: (k) => dropped.push(k),
      timers: fakeTimers(),
      sync: async () => ({ fetched: 0, unchanged: 0, removed: 0, failed: 0, total: 0, changedFolders: new Set() }),
    });

    await indexer.refreshNow();

    assert.deepEqual(dropped.filter(k => k.startsWith('gone')), ['gone::-srv-old']);
    assert.ok(!dropped.includes('C--Serveur-switchboard'), 'a local folder is never dropped');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

// Field failure, 2026-09-07: declaring a host in Settings calls restart(), whose
// stop() disposed the shared transport for good. Every pull after that answered
// "ssh inventory failed (exit -1): transport disposed" and the mirror stayed
// empty. See .ai/contexts/session-cache.md, "Remote hosts".
function lifecycleTransport() {
  let disposed = false;
  const calls = [];
  return {
    calls,
    isDisposed: () => disposed,
    async listFiles(alias) {
      if (disposed) throw new Error('ssh inventory failed (exit -1): transport disposed');
      calls.push(alias);
      return [];
    },
    fetchFiles: async () => ({ fetched: [], failed: [] }),
    cancelInFlight() {},
    dispose() { disposed = true; },
  };
}

test('restart() after adding a host keeps the transport usable', async () => {
  const dataDir = tmp('idx-restart');
  try {
    const timers = fakeTimers();
    const transport = lifecycleTransport();
    let hosts = [];
    const indexer = createRemoteIndexer({
      getHosts: () => hosts,
      dataDir,
      transport,
      timers,
      sync: async ({ alias, transport: t }) => {
        await t.listFiles(alias);
        return { changedFolders: [], errors: [] };
      },
      scanFolders: () => {},
      setRemoteRoots: () => {},
    });

    // Launched with no host: nothing armed, exactly as in the field.
    assert.equal(indexer.start(), false);

    // The user adds one in Settings; the IPC handler calls restart().
    hosts = [{ alias: 'planificator', enabled: true }];
    assert.equal(indexer.restart(), true, 'restart() must arm the timer');
    await indexer.refreshNow();

    assert.equal(transport.isDisposed(), false, 'restart() must never dispose the transport');
    assert.ok(transport.calls.length > 0, 'the inventory must actually run after restart()');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('dispose() is terminal: it stops the timer and ends the transport', async () => {
  const dataDir = tmp('idx-dispose');
  try {
    const timers = fakeTimers();
    const transport = lifecycleTransport();
    const indexer = createRemoteIndexer({
      getHosts: () => [{ alias: 'planificator', enabled: true }],
      dataDir,
      transport,
      timers,
      sync: async ({ alias, transport: t }) => {
        await t.listFiles(alias);
        return { changedFolders: [], errors: [] };
      },
      scanFolders: () => {},
      setRemoteRoots: () => {},
    });

    assert.equal(indexer.start(), true);
    indexer.dispose();
    assert.equal(transport.isDisposed(), true, 'shutdown must end the transport');
    assert.equal(indexer.isRunning(), false, 'shutdown must clear the timer');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});
