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

/** A controllable clock for the backoff seam (`ctx.now`) — no wall-clock wait. */
function fakeClock(start = 0) {
  let t = start;
  const fn = () => t;
  fn.advance = (ms) => { t += ms; };
  return fn;
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

test('getRemoteSessions surfaces per-host session descriptors from the same sync cycle', async () => {
  const dataDir = tmp('idx-sessions');
  try {
    const sessionsByAlias = {
      withSessions: [{ pid: 123, sessionId: 'abc' }],
      empty: [],
    };
    const indexer = createRemoteIndexer({
      getHosts: () => [{ alias: 'withSessions' }, { alias: 'empty' }],
      dataDir,
      transport: {},
      scanFolders: () => Promise.resolve({ ok: true }),
      listIndexedFolderKeys: () => [],
      timers: fakeTimers(),
      sync: async ({ alias }) => ({
        fetched: 0, unchanged: 0, removed: 0, failed: 0, total: 0,
        changedFolders: new Set(), sessions: sessionsByAlias[alias],
      }),
    });

    const r = await indexer.refreshNow();

    assert.deepEqual(r.errors, [], 'both hosts complete without error');
    const withSessions = indexer.getRemoteSessions('withSessions');
    assert.deepEqual(withSessions.sessions, sessionsByAlias.withSessions);
    assert.ok(Number.isInteger(withSessions.at), 'a successful cycle records when it happened');
    assert.equal(withSessions.error, null);
    const empty = indexer.getRemoteSessions('empty');
    assert.deepEqual(empty.sessions, []);
    assert.ok(Number.isInteger(empty.at), 'a host with zero live sessions still had a successful read');
    assert.equal(empty.error, null);
    const neverRefreshed = indexer.getRemoteSessions('some-alias-never-refreshed');
    assert.deepEqual(neverRefreshed.sessions, [], 'an unknown alias must never throw or return undefined');
    assert.equal(neverRefreshed.at, null, 'an alias never refreshed has no successful-read timestamp');
    assert.equal(neverRefreshed.error, null);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('getRemoteSessions is cleared, not left stale, after a cycle where sync() throws', async () => {
  const dataDir = tmp('idx-sessions-stale');
  try {
    let cycle = 0;
    const indexer = createRemoteIndexer({
      getHosts: () => [{ alias: 'planificator' }],
      dataDir,
      transport: {},
      scanFolders: () => Promise.resolve({ ok: true }),
      listIndexedFolderKeys: () => [],
      timers: fakeTimers(),
      sync: async () => {
        cycle++;
        if (cycle === 1) {
          return {
            fetched: 0, unchanged: 0, removed: 0, failed: 0, total: 0,
            changedFolders: new Set(), sessions: [{ pid: 1, sessionId: 'still-alive' }],
          };
        }
        throw new Error('ssh: connect to host planificator port 22: timed out');
      },
    });

    const r1 = await indexer.refreshNow();
    assert.deepEqual(r1.errors, []);
    const afterSuccess = indexer.getRemoteSessions('planificator');
    assert.deepEqual(afterSuccess.sessions, [{ pid: 1, sessionId: 'still-alive' }]);
    assert.ok(Number.isInteger(afterSuccess.at));
    assert.equal(afterSuccess.error, null);

    const r2 = await indexer.refreshNow();
    assert.equal(r2.errors.length, 1, 'the second cycle must be reported as failed');
    const afterFailure = indexer.getRemoteSessions('planificator');
    assert.deepEqual(afterFailure.sessions, [],
      'a failed cycle must not keep reporting hours-old sessions as live');
    assert.match(afterFailure.error, /timed out/,
      'the failure reason must survive on the accessor so the UI can distinguish it from a genuinely idle host');
    assert.equal(afterFailure.at, afterSuccess.at,
      'the last-successful-read timestamp is not a heartbeat: a failed cycle does not bump it');
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
      return { files: [], sessions: [] };
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

// Issue #215 acceptance: a host stuck in `ssh inventory failed ... transport
// disposed` must not be retried at a fixed cadence forever (the field log
// shows 226 identical attempts, one every 300.0 s, over ~19 h). Backoff is
// driven by an injected clock (`ctx.now`), never a real timer.

test('consecutive failures on one host back off exponentially and the delay is capped', async () => {
  const dataDir = tmp('idx-backoff-space');
  try {
    const clock = fakeClock(0);
    let attempts = 0;
    const BASE = 60_000;
    const CAP = 30 * 60 * 1000;
    const indexer = createRemoteIndexer({
      getHosts: () => [{ alias: 'dead' }],
      getRefreshMs: () => BASE,
      dataDir,
      transport: {},
      scanFolders: () => Promise.resolve({ ok: true }),
      listIndexedFolderKeys: () => [],
      timers: fakeTimers(),
      now: clock,
      sync: async () => { attempts++; throw new Error('ssh inventory failed (exit -1): transport disposed'); },
    });

    const expectedDelay = (failures) => Math.min(BASE * 2 ** (failures - 1), CAP);

    for (let failures = 1; failures <= 8; failures++) {
      await indexer.refreshNow();
      const state = indexer.getRemoteHostState('dead');
      assert.equal(state.consecutiveFailures, failures, `failure ${failures} counted`);
      assert.equal(state.nextAttemptAt - clock(), expectedDelay(failures), `delay after failure ${failures}`);

      // A tick before the backoff elapses must not spend another ssh attempt.
      const before = attempts;
      clock.advance(1);
      await indexer.refreshNow();
      assert.equal(attempts, before, `failure ${failures}: not due yet, must be skipped`);

      // Land exactly on the next due instant for the following iteration.
      clock.advance(state.nextAttemptAt - clock());
    }

    assert.equal(attempts, 8, 'every due cycle actually attempted the host once');
    assert.equal(expectedDelay(8), CAP, 'sanity: by the 8th failure the exponential has saturated at the cap, ' +
      'so the per-iteration assertion above already proved the ceiling holds');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('a success after consecutive failures resets the backoff to nominal immediately', async () => {
  const dataDir = tmp('idx-backoff-reset');
  try {
    const clock = fakeClock(0);
    let shouldFail = true;
    const indexer = createRemoteIndexer({
      getHosts: () => [{ alias: 'flaky' }],
      getRefreshMs: () => 60_000,
      dataDir,
      transport: {},
      scanFolders: () => Promise.resolve({ ok: true }),
      listIndexedFolderKeys: () => [],
      timers: fakeTimers(),
      now: clock,
      sync: async () => {
        if (shouldFail) throw new Error('ssh: connect to host flaky port 22: timed out');
        return { fetched: 0, unchanged: 0, removed: 0, failed: 0, total: 0, changedFolders: new Set() };
      },
    });

    // Three consecutive failures widen the gap well past the nominal cadence.
    let failedState;
    let delayBeforeRecovery;
    for (let i = 0; i < 3; i++) {
      await indexer.refreshNow();
      failedState = indexer.getRemoteHostState('flaky');
      delayBeforeRecovery = failedState.nextAttemptAt - clock();
      clock.advance(delayBeforeRecovery);
    }
    assert.equal(failedState.consecutiveFailures, 3);
    assert.equal(delayBeforeRecovery, 240_000, 'the 3rd failure widened the delay past the 60 s nominal cadence');

    // The host recovers on the next due attempt.
    shouldFail = false;
    await indexer.refreshNow();
    const recovered = indexer.getRemoteHostState('flaky');
    assert.equal(recovered.consecutiveFailures, 0, 'failure count drops to zero on success');
    assert.equal(recovered.lastError, null, 'the stale error is cleared');
    assert.equal(recovered.nextAttemptAt, 0, 'no artificial delay is left behind after recovery');

    // Immediately eligible again — no leftover cool-down from the outage.
    shouldFail = true; // if backoff state had survived, this would silently be skipped
    const r = await indexer.refreshNow();
    assert.equal(r.errors.length, 1, 'the very next cycle actually attempted the host again');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('a host backing off does not block its peers from refreshing on schedule', async () => {
  const dataDir = tmp('idx-backoff-isolation');
  try {
    const clock = fakeClock(0);
    const aliveCalls = [];
    const indexer = createRemoteIndexer({
      getHosts: () => [{ alias: 'dead' }, { alias: 'alive' }],
      getRefreshMs: () => 60_000,
      dataDir,
      transport: {},
      scanFolders: () => Promise.resolve({ ok: true }),
      listIndexedFolderKeys: () => [],
      timers: fakeTimers(),
      now: clock,
      sync: async ({ alias }) => {
        if (alias === 'dead') throw new Error('ssh: dead unreachable');
        aliveCalls.push(clock());
        return { fetched: 0, unchanged: 0, removed: 0, failed: 0, total: 0, changedFolders: new Set() };
      },
    });

    await indexer.refreshNow(); // dead fails once (60 s backoff), alive succeeds
    assert.equal(aliveCalls.length, 1);
    assert.equal(indexer.getRemoteHostState('dead').consecutiveFailures, 1);

    // Advance far less than dead's backoff: dead must be skipped, alive must not.
    clock.advance(1_000);
    const r = await indexer.refreshNow();
    assert.equal(aliveCalls.length, 2, 'alive is refreshed on every cycle regardless of dead backing off');
    assert.equal(indexer.getRemoteHostState('dead').consecutiveFailures, 1, 'dead was skipped, not re-attempted');
    assert.equal(r.errors.length, 0, 'a skipped host is not reported as a fresh error');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('failure logging is throttled: only the first failure and tier changes are logged', async () => {
  const dataDir = tmp('idx-backoff-log');
  try {
    const clock = fakeClock(0);
    const warnings = [];
    const indexer = createRemoteIndexer({
      getHosts: () => [{ alias: 'dead' }],
      getRefreshMs: () => 60_000,
      dataDir,
      transport: {},
      scanFolders: () => Promise.resolve({ ok: true }),
      listIndexedFolderKeys: () => [],
      log: { info() {}, warn: (m) => warnings.push(m), error() {} },
      timers: fakeTimers(),
      now: clock,
      sync: async () => { throw new Error('ssh inventory failed (exit -1): transport disposed'); },
    });

    for (let i = 0; i < 12; i++) {
      await indexer.refreshNow();
      clock.advance(indexer.getRemoteHostState('dead').nextAttemptAt - clock());
    }

    assert.equal(indexer.getRemoteHostState('dead').consecutiveFailures, 12, '12 attempts actually happened');
    assert.ok(warnings.length < 12, 'not every attempt is logged');
    assert.ok(warnings.length <= 6, `only the tier changes are logged, got ${warnings.length}`);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

// refreshHostNow(alias) — issue #240's per-host entry point for the watch
// channel: the same refresh path the periodic timer takes, narrowed to one
// host, so a push signal never pays for refreshing every declared host.
test('refreshHostNow refreshes only the named host, not its peers', async () => {
  const dataDir = tmp('idx-hostnow-scope');
  try {
    const scans = [];
    let notified = 0;
    const indexer = createRemoteIndexer({
      getHosts: () => [{ alias: 'vps' }, { alias: 'other' }],
      dataDir,
      transport: {},
      scanFolders: (args) => { scans.push(args.folderPrefix); return Promise.resolve({ ok: true }); },
      listIndexedFolderKeys: () => [],
      notify: () => { notified++; },
      timers: fakeTimers(),
      sync: async ({ alias, projectsDir }) => {
        fs.mkdirSync(path.join(projectsDir, '-srv-x'), { recursive: true });
        return { fetched: 1, unchanged: 0, removed: 0, failed: 0, total: 1, changedFolders: new Set(['-srv-x']) };
      },
    });

    const r = await indexer.refreshHostNow('vps');

    assert.equal(r.skipped, false);
    assert.equal(r.changed, true);
    assert.deepEqual(scans, ['vps'], 'only the named host was scanned');
    assert.equal(notified, 1, 'the same notify path the periodic cycle uses fires on change');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('refreshHostNow reports skipped for an alias that is not declared', async () => {
  const dataDir = tmp('idx-hostnow-unknown');
  try {
    const indexer = createRemoteIndexer({
      getHosts: () => [{ alias: 'vps' }],
      dataDir,
      transport: {},
      scanFolders: () => Promise.resolve({ ok: true }),
      listIndexedFolderKeys: () => [],
      timers: fakeTimers(),
      sync: () => { throw new Error('sync must not be called for an unknown alias'); },
    });

    assert.deepEqual(await indexer.refreshHostNow('ghost'), { skipped: true });
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('refreshHostNow honors the same per-host backoff refreshNow uses', async () => {
  const dataDir = tmp('idx-hostnow-backoff');
  try {
    const clock = fakeClock(0);
    let attempts = 0;
    const indexer = createRemoteIndexer({
      getHosts: () => [{ alias: 'dead' }],
      getRefreshMs: () => 60_000,
      dataDir,
      transport: {},
      scanFolders: () => Promise.resolve({ ok: true }),
      listIndexedFolderKeys: () => [],
      timers: fakeTimers(),
      now: clock,
      sync: async () => { attempts++; throw new Error('ssh: connect to host dead port 22: timed out'); },
    });

    await indexer.refreshHostNow('dead');
    assert.equal(attempts, 1);
    const state = indexer.getRemoteHostState('dead');
    assert.ok(state.nextAttemptAt > clock(), 'a failure must arm the backoff exactly as refreshNow does');

    // Still backing off: a second watch-triggered call must not spend another ssh attempt.
    await indexer.refreshHostNow('dead');
    assert.equal(attempts, 1, 'a host still backing off is skipped, not re-attempted');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('refreshHostNow and the periodic cycle never overlap on the same host', async () => {
  const dataDir = tmp('idx-hostnow-overlap');
  try {
    let inflightCount = 0;
    let maxInflight = 0;
    let releasePeriodic;
    const periodicGate = new Promise((resolve) => { releasePeriodic = resolve; });
    const indexer = createRemoteIndexer({
      getHosts: () => [{ alias: 'vps' }],
      dataDir,
      transport: {},
      scanFolders: () => Promise.resolve({ ok: true }),
      listIndexedFolderKeys: () => [],
      timers: fakeTimers(),
      sync: async ({ projectsDir }) => {
        inflightCount++;
        maxInflight = Math.max(maxInflight, inflightCount);
        await periodicGate;
        fs.mkdirSync(path.join(projectsDir, '-srv-x'), { recursive: true });
        inflightCount--;
        return { fetched: 1, unchanged: 0, removed: 0, failed: 0, total: 1, changedFolders: new Set(['-srv-x']) };
      },
    });

    const periodic = indexer.refreshNow();
    // A missing overlap guard would make this call join the same in-flight
    // sync() and hang on periodicGate forever — race a timeout so a broken
    // guard fails the test instead of hanging the whole run.
    let timeoutHandle;
    const timeout = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error(
        'refreshHostNow did not return promptly — it is not skipping the host the periodic cycle already owns',
      )), 2000);
      if (timeoutHandle.unref) timeoutHandle.unref();
    });
    let watchTriggered;
    try {
      watchTriggered = await Promise.race([indexer.refreshHostNow('vps'), timeout]);
    } finally {
      clearTimeout(timeoutHandle);
    }
    assert.equal(watchTriggered.skipped, true, 'a watch signal must not race the periodic cycle for the same host');

    releasePeriodic();
    await periodic;
    assert.equal(maxInflight, 1, 'the two paths never ran the transport for the same host concurrently');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});
