'use strict';

// Issue #218: the indexer runs the tmux/inotifywait probe on first sync, then
// rarely, and a probe failure never turns into a refresh failure.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createRemoteIndexer, PROBE_INTERVAL_MS, PROBE_RETRY_MS } = require('../remote-index');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-idx-probe-'));
}

function fakeTimers() {
  return { setInterval: () => ({}), clearInterval: () => {} };
}

function harness({ probe, syncFails = () => false, hosts = [{ alias: 'box' }] } = {}) {
  const dataDir = tmp();
  let t = 1_000;
  const probes = [];
  const notifies = [];
  const warnings = [];
  const transport = probe ? { probeTools: (alias) => { probes.push(alias); return probe(probes.length); } } : {};
  const indexer = createRemoteIndexer({
    getHosts: () => hosts,
    getRefreshMs: () => 60_000,
    dataDir,
    transport,
    scanFolders: () => Promise.resolve({ ok: true }),
    listIndexedFolderKeys: () => [],
    dropFolder: () => {},
    timers: fakeTimers(),
    notify: () => notifies.push(t),
    log: { info() {}, warn: (m) => warnings.push(m), error() {} },
    now: () => t,
    sync: async () => {
      if (syncFails()) throw new Error('connect timed out');
      return { changedFolders: [], sessions: [] };
    },
  });
  return { indexer, probes, notifies, warnings, advance: (ms) => { t += ms; }, cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}

test('the first successful sync probes the host once and the profile carries the result', async () => {
  const h = harness({ probe: async () => ({ tmux: true, inotifywait: false }) });
  try {
    assert.deepEqual(h.indexer.getRemoteHostProfile('box').tools, { tmux: null, inotifywait: null });
    await h.indexer.refreshNow();
    assert.deepEqual(h.probes, ['box']);
    const profile = h.indexer.getRemoteHostProfile('box');
    assert.deepEqual(profile.tools, { tmux: true, inotifywait: false });
    assert.equal(profile.tiers.find(t => t.tier === 'attach').available, true, 'idle host with tmux offers attach');
  } finally { h.cleanup(); }
});

test('a changed probe answer notifies the renderer even when the sync changed nothing, an unchanged one does not', async () => {
  let answer = { tmux: true, inotifywait: true };
  const h = harness({ probe: async () => answer });
  try {
    await h.indexer.refreshNow();
    assert.equal(h.notifies.length, 1, 'the first answer changes the profile');
    h.advance(PROBE_INTERVAL_MS);
    await h.indexer.refreshNow();
    assert.equal(h.notifies.length, 1, 'the same answer changes nothing');
    answer = { tmux: false, inotifywait: true };
    h.advance(PROBE_INTERVAL_MS);
    await h.indexer.refreshNow();
    assert.equal(h.notifies.length, 2);
  } finally { h.cleanup(); }
});

test('a later cycle inside the probe interval does not probe again, one past it does', async () => {
  const h = harness({ probe: async () => ({ tmux: true, inotifywait: true }) });
  try {
    await h.indexer.refreshNow();
    h.advance(PROBE_INTERVAL_MS - 1);
    await h.indexer.refreshNow();
    await h.indexer.refreshHostNow('box');
    assert.equal(h.probes.length, 1);
    h.advance(1);
    await h.indexer.refreshNow();
    assert.equal(h.probes.length, 2);
  } finally { h.cleanup(); }
});

test('an answer with a missing tool is asked again after the retry delay, one with both present only after the interval', async () => {
  for (const [answer, delay] of [
    [{ tmux: false, inotifywait: true }, PROBE_RETRY_MS],
    [{ tmux: true, inotifywait: false }, PROBE_RETRY_MS],
    [{ tmux: true, inotifywait: true }, PROBE_INTERVAL_MS],
  ]) {
    const h = harness({ probe: async () => answer });
    try {
      await h.indexer.refreshNow();
      h.advance(delay - 1);
      await h.indexer.refreshNow();
      assert.equal(h.probes.length, 1, JSON.stringify(answer) + ' before the delay');
      h.advance(1);
      await h.indexer.refreshNow();
      assert.equal(h.probes.length, 2, JSON.stringify(answer) + ' at the delay');
    } finally { h.cleanup(); }
  }
});

test('a probe failure leaves the profile unknown, does not fail the refresh, and retries only after the retry delay', async () => {
  let fail = true;
  const h = harness({ probe: async () => { if (fail) throw new Error('ssh probe timed out after 15000 ms'); return { tmux: false, inotifywait: false }; } });
  try {
    const result = await h.indexer.refreshNow();
    assert.deepEqual(result.errors, []);
    assert.deepEqual(h.indexer.getRemoteHostState('box').consecutiveFailures, 0);
    assert.deepEqual(h.indexer.getRemoteHostProfile('box').tools, { tmux: null, inotifywait: null });
    assert.equal(h.indexer.getRemoteHostProfile('box').tier, 'observe');

    h.advance(PROBE_RETRY_MS - 1);
    await h.indexer.refreshNow();
    assert.equal(h.probes.length, 1, 'still inside the retry delay');
    await h.indexer.refreshNow({ force: true });
    assert.equal(h.probes.length, 2, 'a forced reconnect probes again');
    fail = false;
    h.advance(PROBE_RETRY_MS);
    await h.indexer.refreshHostNow('box');
    assert.equal(h.probes.length, 3);
    assert.deepEqual(h.indexer.getRemoteHostProfile('box').tools, { tmux: false, inotifywait: false });
  } finally { h.cleanup(); }
});

test('a failed probe keeps the previous answer rather than forgetting it', async () => {
  let n = 0;
  const h = harness({ probe: async () => { n++; if (n === 2) throw new Error('boom'); return { tmux: true, inotifywait: true }; } });
  try {
    await h.indexer.refreshNow();
    h.advance(PROBE_INTERVAL_MS);
    await h.indexer.refreshNow();
    assert.equal(h.probes.length, 2);
    assert.deepEqual(h.indexer.getRemoteHostProfile('box').tools, { tmux: true, inotifywait: true });
  } finally { h.cleanup(); }
});

test('no probe runs when the sync itself failed', async () => {
  const h = harness({ probe: async () => ({ tmux: true, inotifywait: true }), syncFails: () => true });
  try {
    await h.indexer.refreshNow();
    assert.deepEqual(h.probes, []);
  } finally { h.cleanup(); }
});

test('a transport with no probe is left alone', async () => {
  const h = harness({});
  try {
    const result = await h.indexer.refreshNow();
    assert.deepEqual(result.errors, []);
    assert.deepEqual(h.warnings, [], 'a transport that has no probe is not an error');
    assert.deepEqual(h.indexer.getRemoteHostProfile('box').tools, { tmux: null, inotifywait: null });
  } finally { h.cleanup(); }
});

test('a host removed from the settings forgets its probe result', async () => {
  let hosts = [{ alias: 'box' }];
  const h = harness({ probe: async () => ({ tmux: true, inotifywait: true }), hosts });
  try {
    await h.indexer.refreshNow();
    hosts.length = 0;
    hosts.push({ alias: 'other' });
    await h.indexer.refreshNow();
    hosts.length = 0;
    hosts.push({ alias: 'box' });
    assert.deepEqual(h.indexer.getRemoteHostProfile('box').tools, { tmux: null, inotifywait: null });
  } finally { h.cleanup(); }
});
