'use strict';

// Issue #218: the indexer runs the tmux/inotifywait probe on first sync, then
// rarely, and a probe failure never turns into a refresh failure.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createSshTransport, LIST_COMMAND } = require('../src/main/remote/remote-transport');
const { mirrorProjectsDirFor, manifestPathFor } = require('../src/main/remote/remote-hosts');

const { createRemoteIndexer, PROBE_INTERVAL_MS, PROBE_RETRY_MS } = require('../src/main/remote/remote-index');

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
      if (syncFails()) throw Object.assign(new Error('connect timed out'), { remoteTransport: true });
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

test('an offline host pays no probe, including forced reconnects and post-launch refreshes', async () => {
  const h = harness({ probe: async () => ({ tmux: true, inotifywait: true }), syncFails: () => true });
  try {
    for (const refresh of [() => h.indexer.refreshNow(), () => h.indexer.refreshNow({ force: true }),
      () => h.indexer.refreshHostNow('box', { force: true })]) {
      await refresh();
      assert.deepEqual(h.probes, [], 'a failed sync must not spend another SSH attempt on a probe');
    }
  } finally { h.cleanup(); }
});

test('a fresh host with a missing directory preserves its mirror, probes, notifies once and can launch', async () => {
  const dataDir = tmp();
  const remoteDir = tmp();
  const calls = [];
  const transport = createSshTransport({ spawn: (_cmd, args, options) => {
    const inventory = args.at(-1) === LIST_COMMAND;
    calls.push(inventory ? 'inventory' : 'probe');
    return spawn('sh', ['-c', inventory ? LIST_COMMAND : "printf 'tmux=1\\ninotifywait=1\\n'"], { ...options, cwd: remoteDir });
  } });
  let notifications = 0;
  const indexer = createRemoteIndexer({ getHosts: () => [{ alias: 'box' }], dataDir, transport,
    timers: fakeTimers(), listIndexedFolderKeys: () => [], notify: () => { notifications++; } });
  const h = { indexer };
  try {
    const result = await indexer.refreshNow();
    assert.equal(result.errors.length, 1, 'a missing transcript directory must fail the mirror');
    assert.match(result.errors[0].error, /find/);
    assert.deepEqual(calls, ['inventory', 'probe'], 'one inventory round trip precedes the probe');
    assert.deepEqual(indexer.getRemoteSessions('box').sessions, []);
    assert.equal(indexer.getRemoteHostState('box').consecutiveFailures, 1);
    assert.equal(indexer.getRemoteHostState('box').lastErrorTransport, false);
    assert.equal(fs.existsSync(manifestPathFor(dataDir, 'box')), false, 'no inventory is written');
    assert.deepEqual(fs.readdirSync(mirrorProjectsDirFor(dataDir, 'box')), []);
    assert.equal(notifications, 1, 'the newly available launch tier reaches the renderer');
    assert.equal(h.indexer.getRemoteHostProfile('box').tiers.find(t => t.tier === 'launch').available, true,
      'a reachable tmux host can launch its first session with no transcripts');
    const { handleLaunchRequest, createRemoteLaunchAdapter } = require('../src/main/remote/remote-launch');
    const { launchBlockReason } = require('../src/main/remote/remote-host-profile');
    const commands = [];
    const adapter = createRemoteLaunchAdapter({ runRemoteCommand: async (alias, command) => {
      commands.push({ alias, command });
      return { code: 0, stdout: 'switchboard-3f2a9c10:@1.%2 1234' };
    } });
    const deps = { hasHost: alias => alias === 'box', launchBlockReason: alias => launchBlockReason(h.indexer.getRemoteHostProfile(alias)),
      adapter, attach: async () => ({ ok: true }) };
    const payload = { alias: 'box', sessionId: '3f2a9c10-7b1d-4e55-9a60-0123456789ab', cwd: '/sandbox/work/first', options: {} };
    for (const cwd of ['relative', '/srv/../etc', '/srv/$(id)', '/' + 'a'.repeat(4096)]) {
      assert.equal((await handleLaunchRequest({ ...payload, cwd }, deps)).ok, false);
    }
    assert.equal(commands.length, 0, 'invalid paths never reach SSH');
    assert.equal((await handleLaunchRequest(payload, deps)).ok, true);
    assert.equal(commands[0].alias, 'box');
    assert.match(commands[0].command, /tmux new-session/);
  } finally {
    indexer.dispose();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(remoteDir, { recursive: true, force: true });
  }
});

for (const method of ['refreshNow', 'refreshHostNow']) {
  test(`${method}: missing remote directory preserves existing mirror, manifest and indexed folders`, async t => {
    const dataDir = tmp();
    const remoteDir = tmp();
    t.after(() => {
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(remoteDir, { recursive: true, force: true });
    });
    const projectsDir = mirrorProjectsDirFor(dataDir, 'box');
    const manifestPath = manifestPathFor(dataDir, 'box');
    const file = path.join(projectsDir, '-srv-app', 'aaaa.jsonl');
    const content = '{"type":"user"}\n';
    const manifest = JSON.stringify({ version: 1, files: { '-srv-app/aaaa.jsonl': { size: content.length, mtimeMs: 1 } } });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    fs.writeFileSync(manifestPath, manifest);
    const drops = [];
    const scans = [];
    const transport = createSshTransport({ spawn: (_cmd, args, options) =>
      spawn('sh', ['-c', args.at(-1) === LIST_COMMAND ? LIST_COMMAND : "printf 'tmux=1\\ninotifywait=1\\n'"],
        { ...options, cwd: remoteDir }) });
    const indexer = createRemoteIndexer({ getHosts: () => [{ alias: 'box' }], dataDir, transport,
      listIndexedFolderKeys: () => ['box::-srv-app'], dropFolder: key => drops.push(key),
      scanFolders: options => scans.push(options), timers: fakeTimers() });
    t.after(() => indexer.dispose());
    const result = await indexer[method](...(method === 'refreshNow' ? [] : ['box']));
    assert.equal(fs.existsSync(file), true, 'a missing remote directory must never delete an existing mirrored file');
    assert.equal(fs.readFileSync(file, 'utf8'), content);
    assert.equal(fs.readFileSync(manifestPath, 'utf8'), manifest, 'the manifest remains byte-for-byte unchanged');
    assert.deepEqual(drops, []);
    assert.deepEqual(scans, []);
    assert.match(method === 'refreshNow' ? result.errors[0]?.error : result.error, /find/);
  });

  test(`${method}: failed inventory probes and only changed tools or errors notify`, async t => {
    const dataDir = tmp();
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    let answer = { tmux: true, inotifywait: true };
    let probeFails = false;
    let probes = 0;
    let notifications = 0;
    const originalError = new Error('find: .claude/projects: No such file or directory');
    const indexer = createRemoteIndexer({ getHosts: () => [{ alias: 'box' }], dataDir,
      sync: async () => { throw originalError; }, timers: fakeTimers(),
      transport: { probeTools: async () => {
        probes++;
        if (probeFails) throw new Error('probe failed');
        return answer;
      } }, notify: () => notifications++ });
    t.after(() => indexer.dispose());
    const refresh = () => indexer[method](...(method === 'refreshNow' ? [{ force: true }] : ['box', { force: true }]));
    await refresh();
    assert.equal(probes, 1, 'a non-transport inventory error must still probe tools');
    assert.equal(notifications, 1, 'tools and error changes share one notification');
    await refresh();
    assert.equal(notifications, 1, 'unchanged tools and error do not notify');
    answer = { tmux: false, inotifywait: true };
    await refresh();
    assert.equal(notifications, 2, 'changed tools notify even with an unchanged inventory error');
    assert.deepEqual(indexer.getRemoteHostProfile('box').tools, answer);
    probeFails = true;
    const result = await refresh();
    assert.equal(method === 'refreshNow' ? result.errors[0]?.error : result.error, originalError.message,
      'probe failure must not replace the original inventory error');
    assert.equal(notifications, 2);
    assert.deepEqual(indexer.getRemoteHostProfile('box').tools, answer);
    assert.equal(fs.existsSync(manifestPathFor(dataDir, 'box')), false);
  });
}

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
