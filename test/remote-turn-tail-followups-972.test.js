'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createSshTransport, SESSIONS_MARKER, ALIVE_MARKER_PREFIX } = require('../src/main/remote/remote-transport');
const { createRemoteIndexer } = require('../src/main/remote/remote-index');
const { syncTurnTails } = require('../src/main/remote/remote-turn-tails');

const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const rel = id => `-srv-a/${id}.jsonl`;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function within(promise) {
  let timer;
  try {
    return await Promise.race([promise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 10000); })]);
  } finally { clearTimeout(timer); }
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-972-'));
  const state = { ids: [...ids], mtime: 1000, status: 'busy', fail: false, hold: false, held: [], tails: [], inventories: 0 };
  const entered = deferred();
  const logs = [];
  const notices = [];
  const batches = [];
  const transport = createSshTransport({ resolveSshPath: () => 'fixture-ssh', spawn(_command, args) {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { state.held.push(() => child.emit('close', -1)); };
    const command = args.at(-1);
    setImmediate(() => {
      if (command.startsWith('find ')) {
        state.inventories++;
        state.onInventory?.();
        const inventory = state.ids.map(id => `${state.mtime / 1000}\t${209 * 1024 * 1024}\t${rel(id)}\n`).join('');
        const sessions = state.ids.map((sessionId, i) => JSON.stringify({ pid: i + 1, sessionId, cwd: '/srv/a', status: state.status, statusUpdatedAt: state.mtime }) + '\n' + ALIVE_MARKER_PREFIX + '1\n').join('');
        child.stdout.end(inventory + SESSIONS_MARKER + '\n' + sessions);
      } else if (command.startsWith('if command')) child.stdout.end('tmux=1\ninotifywait=0\n');
      else if (command.startsWith('tail -c ')) {
        state.tails.push(command);
        if (state.hold) { state.held.push(() => child.emit('close', -1)); entered.resolve(); return; }
        if (state.fail) { child.stderr.end('fixture tail failure'); child.emit('close', 255); return; }
        child.stdout.end('\n' + JSON.stringify({ type: 'user', message: { role: 'user', content: 'work' } }) + '\n');
      } else throw new Error(`unexpected SSH command: ${command}`);
      child.emit('close', 0);
    });
    return child;
  } });
  const indexer = createRemoteIndexer({ dataDir: dir, getHosts: () => [{ alias: 'vps' }], transport,
    timers: { setInterval: () => 1, clearInterval() {} },
    notify: () => notices.push(indexer.getRemoteSessions('vps')),
    refreshHeadTurns: async () => { batches.push(indexer.getRemoteHeadTurnFiles('vps')); state.onBatch?.(); },
    log: { info: line => logs.push(line), warn: line => logs.push(line) },
  });
  t.after(() => { indexer.dispose(); state.held.splice(0).forEach(release => release()); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, state, entered, logs, notices, batches, indexer };
}

test('fresh descriptors and notification precede a blocked tail; head turns still refresh afterwards', async t => {
  const f = fixture(t);
  f.state.hold = true;
  const pending = f.indexer.refreshNow();
  await f.entered.promise;
  try {
    assert.equal(f.indexer.getRemoteSessions('vps').sessions[0]?.status, 'busy', 'descriptors publish before tail SSH finishes');
    assert.ok(f.indexer.getRemoteSessions('vps').at, 'descriptor freshness publishes with the descriptors');
    assert.equal(f.notices.at(-1)?.sessions[0]?.status, 'busy', 'sidebar is notified while tail is blocked');
  } finally {
    f.state.hold = false;
    f.state.held.splice(0).forEach(release => release());
    await pending;
  }
  await f.indexer.refreshNow();
  assert.equal(f.batches.at(-1).length, 2, 'head-turn refresh runs after tails have been registered');
});

for (const lane of ['refreshNow', 'refreshHostNow']) {
  test(`stop/restart cancels the old ${lane} tail loop without blocking the next refresh`, async t => {
    const f = fixture(t);
    f.state.hold = true;
    const old = lane === 'refreshNow' ? f.indexer.refreshNow() : f.indexer.refreshHostNow('vps');
    await f.entered.promise;
    f.state.hold = false;
    f.state.status = 'waiting';
    const nextInventory = deferred();
    const finished = deferred();
    f.state.onBatch = finished.resolve;
    f.state.onInventory = nextInventory.resolve;
    f.indexer.restart();
    try {
      assert.equal(await within(nextInventory.promise), true, 'restart starts a new inventory before the old SSH settles');
    } finally {
      f.state.held.splice(0).forEach(release => release());
      await old;
    }
    f.state.onInventory = null;
    assert.equal(await within(finished.promise), true, 'new refresh finishes');
    assert.equal(f.state.tails.length, 3, 'old loop never spawns the second head SSH');
    assert.equal(f.indexer.getRemoteSessions('vps').sessions[0].status, 'waiting');
  });
}

test('tail success and failure logs emit only on state changes and recoveries', async t => {
  const f = fixture(t);
  const pulls = async count => {
    for (let i = 0; i < count; i++) { f.state.mtime += 1000; await f.indexer.refreshNow(); }
  };
  await pulls(4);
  const lines = () => f.logs.filter(line => /turn-state tail (refreshed|failed)/.test(line));
  assert.equal(lines().length, 2, 'repeated successful refreshes log once per head');
  f.state.fail = true;
  await pulls(4);
  assert.equal(lines().length, 4, 'repeated failures log once per head');
  f.state.fail = false;
  await pulls(2);
  assert.equal(lines().length, 6, 'recovery logs once per head');
  f.state.ids = [];
  await f.indexer.refreshNow();
  f.state.ids = [...ids];
  await pulls(1);
  assert.equal(lines().length, 8, 'inactive heads release their log state');
});

test('tail manifest write failure warns without failing the host cycle', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.dir, 'remote/vps/turn-state/inventory.json'), { recursive: true });
  const result = await f.indexer.refreshNow();
  assert.deepEqual(result.errors, [], 'tail manifest failure is not a host failure');
  assert.equal(f.indexer.getRemoteHostState('vps').consecutiveFailures, 0);
  assert.equal(f.indexer.getRemoteHeadTurnFiles('vps').length, 2);
  assert.equal(f.batches.at(-1).length, 2);
  assert.ok(f.logs.some(line => /manifest/i.test(line) && /could not|failed/i.test(line)), 'manifest error is reported');
});

test('tail removal failure warns, retains cleanup debt, and does not fail the host cycle', async t => {
  const f = fixture(t);
  await f.indexer.refreshNow();
  const file = f.indexer.getRemoteHeadTurnFiles('vps')[0].file;
  fs.rmSync(file);
  fs.mkdirSync(file);
  fs.writeFileSync(path.join(file, 'locked'), 'fixture');
  f.state.ids = [ids[1]];
  const result = await f.indexer.refreshNow();
  assert.deepEqual(result.errors, [], 'tail removal failure is not a host failure');
  assert.equal(f.indexer.getRemoteHostState('vps').consecutiveFailures, 0);
  assert.deepEqual(f.indexer.getRemoteHeadTurnFiles('vps').map(row => row.parentSessionId), [ids[1]]);
  assert.ok(f.logs.some(line => line.includes('could not remove') && line.includes(ids[0])), 'removal error is reported');
  fs.rmSync(file, { recursive: true });
  fs.writeFileSync(file, 'cleanup retry');
  await f.indexer.refreshNow();
  assert.equal(fs.existsSync(file), false, 'failed deletion is retried on the next pull');
});

function scripted(t, {
  gates = {}, folders = [], sessions = [], oversized = () => [], onTail,
  indexed = [], cached = () => [], onScan, changedFolders = n => n === 1 ? folders : [],
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-972s-'));
  const state = { hosts: [{ alias: 'vps' }] };
  const calls = { sync: 0, tails: [], scans: [], batches: [], drops: [], ghostChecks: [] };
  const notices = [];
  const transport = {
    cancelInFlight() {},
    readTurnTail: async (_alias, spec, file) => {
      calls.tails.push(spec.rel);
      await onTail?.(calls.tails.length);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '\n');
    },
  };
  const indexer = createRemoteIndexer({
    dataDir: dir,
    getHosts: () => state.hosts,
    transport,
    scanFolders: async opts => {
      calls.scans.push(...opts.folders);
      calls.batches.push(opts);
      await onScan?.(calls.batches.length);
      await gates.scan?.promise;
      return { ok: true };
    },
    listIndexedFolderKeys: () => indexed.filter(key => !calls.drops.includes(key)),
    dropFolder: async key => { calls.drops.push(key); },
    getCachedByFolder: key => { calls.ghostChecks.push(key); return cached(key); },
    timers: { setInterval: () => 1, clearInterval() {} },
    notify: () => notices.push(1),
    log: { info() {}, warn() {} },
    sync: async () => {
      const n = ++calls.sync;
      await gates[n]?.promise;
      return {
        fetched: 0, unchanged: 0, removed: 0, failed: 0, total: 0,
        changedFolders: new Set(changedFolders(n)),
        sessions, oversizedFiles: oversized(),
      };
    },
  });
  t.after(() => {
    indexer.dispose();
    for (const g of Object.values(gates)) g.resolve();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { indexer, calls, notices, dir, state };
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const until = async predicate => {
  for (let i = 0; i < 200 && !predicate(); i++) await tick();
  assert.ok(predicate(), 'expected asynchronous checkpoint was reached');
};

test('until rejects when its asynchronous checkpoint never arrives', async () => {
  await assert.rejects(until(() => false), /expected asynchronous checkpoint was reached/);
});

test('a refreshHostNow cancelled by restart never reports the indexer as stopped', async t => {
  const gates = { 1: deferred() };
  const f = scripted(t, { gates });
  const old = f.indexer.refreshHostNow('vps', { force: true });
  await until(() => f.calls.sync === 1);
  f.indexer.restart();
  gates[1].resolve();
  assert.deepEqual(await old, { skipped: true, reason: 'in-flight' });
});

test('a refreshHostNow cancelled by a real stop still reports stopped', async t => {
  const gates = { 1: deferred() };
  const f = scripted(t, { gates });
  const old = f.indexer.refreshHostNow('vps', { force: true });
  await until(() => f.calls.sync === 1);
  f.indexer.stop();
  gates[1].resolve();
  assert.deepEqual(await old, { skipped: true, reason: 'stopped' });
});

for (const lane of ['refreshNow', 'refreshHostNow']) {
  test(`a ${lane} cancelled after its rows were scanned still notifies`, async t => {
    const gates = { scan: deferred() };
    const f = scripted(t, { gates, folders: ['-srv-a'] });
    const old = lane === 'refreshNow' ? f.indexer.refreshNow() : f.indexer.refreshHostNow('vps', { force: true });
    await until(() => f.calls.sync === 1);
    await tick();
    await tick();
    f.indexer.restart();
    await until(() => f.calls.sync === 2);
    await tick();
    const before = f.notices.length;
    gates.scan.resolve();
    await old;
    assert.ok(f.notices.length > before, 'the new generation sees an up-to-date mirror, so the old pass must notify');
  });
}

test('an old refreshNow unwinding after restart cannot release the new generation guard', async t => {
  const gates = { 1: deferred(), 2: deferred() };
  const f = scripted(t, { gates });
  const old = f.indexer.refreshNow();
  await until(() => f.calls.sync === 1);
  f.indexer.restart();
  await until(() => f.calls.sync === 2);
  gates[1].resolve();
  await old;
  assert.deepEqual(await f.indexer.refreshHostNow('vps'), { skipped: true, reason: 'in-flight' });
  gates[2].resolve();
});

test('an old refreshHostNow unwinding after restart cannot release the new host guard', async t => {
  const gates = { 1: deferred(), 3: deferred() };
  const f = scripted(t, { gates });
  const old = f.indexer.refreshHostNow('vps', { force: true });
  await until(() => f.calls.sync === 1);
  f.indexer.restart();
  await until(() => f.calls.sync === 2);
  await tick();
  await tick();
  const current = f.indexer.refreshHostNow('vps', { force: true });
  await until(() => f.calls.sync === 3);
  gates[1].resolve();
  await old;
  assert.deepEqual(await f.indexer.refreshHostNow('vps', { force: true }), { skipped: true, reason: 'in-flight' });
  gates[3].resolve();
  await current;
});

test('a cancelled pass does not empty the published head-turn files while it unwinds', async t => {
  const id = ids[0];
  const tailGate = deferred();
  const gates = { 3: deferred() };
  let mtimeMs = 1000;
  const f = scripted(t, {
    gates,
    sessions: [{ sessionId: id }],
    oversized: () => [{ rel: rel(id), size: 209 * 1024 * 1024, mtimeMs }],
    onTail: n => (n === 2 ? tailGate.promise : undefined),
  });
  await f.indexer.refreshNow();
  assert.equal(f.indexer.getRemoteHeadTurnFiles('vps').length, 1);
  mtimeMs = 2000;
  const old = f.indexer.refreshNow();
  await until(() => f.calls.tails.length === 2);
  f.indexer.restart();
  await until(() => f.calls.sync === 3);
  tailGate.resolve();
  await old;
  assert.equal(f.indexer.getRemoteHeadTurnFiles('vps').length, 1, 'rows survive the unwinding pass');
  gates[3].resolve();
});

function tailFixture(t, read) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-972t-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const projectsDir = path.join(dir, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });
  const logs = [];
  const state = { cancelled: false };
  const run = () => syncTurnTails({
    alias: 'vps',
    transport: { readTurnTail: () => read(state) },
    projectsDir,
    oversizedFiles: [{ rel: rel(ids[0]), size: 1, mtimeMs: 1 }],
    sessions: [{ sessionId: ids[0] }],
    log: { info: line => logs.push(line), warn: line => logs.push(line) },
    cancelled: () => state.cancelled,
  });
  return { logs, run, manifest: path.join(dir, 'turn-state/inventory.json') };
}

test('a tail read that settles after cancellation publishes nothing and leaves no manifest', async t => {
  const f = tailFixture(t, async state => { state.cancelled = true; });
  assert.deepEqual(await f.run(), []);
  assert.deepEqual(f.logs, []);
  assert.equal(fs.existsSync(f.manifest), false);
});

test('a tail read that fails after cancellation logs nothing and leaves no manifest', async t => {
  const f = tailFixture(t, async state => { state.cancelled = true; throw new Error('killed'); });
  assert.deepEqual(await f.run(), []);
  assert.deepEqual(f.logs, []);
  assert.equal(fs.existsSync(f.manifest), false);
});

test('a persistent tail removal failure warns once across pulls and again after a recovery', async t => {
  const f = fixture(t);
  await f.indexer.refreshNow();
  const file = f.indexer.getRemoteHeadTurnFiles('vps')[0].file;
  const lock = () => {
    fs.rmSync(file, { recursive: true, force: true });
    fs.mkdirSync(file);
    fs.writeFileSync(path.join(file, 'locked'), 'fixture');
  };
  const warns = () => f.logs.filter(line => line.includes('could not remove')).length;
  lock();
  f.state.ids = [ids[1]];
  for (let i = 0; i < 3; i++) await f.indexer.refreshNow();
  assert.equal(warns(), 1, 'the same removal failure is reported once');
  fs.rmSync(file, { recursive: true });
  fs.writeFileSync(file, 'unlocked');
  await f.indexer.refreshNow();
  assert.equal(fs.existsSync(file), false, 'the retried removal succeeds');
  f.state.ids = [...ids];
  await f.indexer.refreshNow();
  lock();
  f.state.ids = [ids[1]];
  await f.indexer.refreshNow();
  assert.equal(warns(), 2, 'a new failure after a recovery is reported again');
});

test('a persistent tail manifest write failure warns once across pulls', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.dir, 'remote/vps/turn-state/inventory.json'), { recursive: true });
  for (let i = 0; i < 3; i++) await f.indexer.refreshNow();
  assert.equal(f.logs.filter(line => line.includes('could not write turn-state tail manifest')).length, 1);
});

test('a pass whose restart landed during its sync still indexes the folders that sync fetched', async t => {
  const gates = { 1: deferred() };
  const f = scripted(t, { gates, folders: ['-srv-a'] });
  const old = f.indexer.refreshNow();
  await until(() => f.calls.sync === 1);
  f.indexer.restart();
  await until(() => f.calls.sync === 2);
  assert.equal(f.calls.sync, 2);
  gates[1].resolve();
  await old;
  await tick();
  assert.ok(f.calls.scans.includes('-srv-a'), 'the fetched folder is scanned, since the next pass sees it unchanged');
});

for (const change of ['removed', 'disabled']) {
  test(`a cancelled sync does not scan an alias ${change} by restart after pruning`, async t => {
    const gates = { 1: deferred(), 2: deferred() };
    const f = scripted(t, { gates, folders: ['-srv-a'], indexed: ['vps::-srv-a'] });
    fs.mkdirSync(path.join(f.dir, 'remote/vps/projects/-srv-a'), { recursive: true });
    const old = f.indexer.refreshNow();
    await until(() => f.calls.sync === 1);
    f.state.hosts = [{ alias: 'other' }, ...(change === 'disabled' ? [{ alias: 'vps', enabled: false }] : [])];
    f.indexer.restart();
    await until(() => f.calls.sync === 2);
    assert.deepEqual(f.calls.drops, ['vps::-srv-a'], 'new generation pruned the undeclared alias');
    gates[1].resolve();
    await old;
    assert.deepEqual(f.calls.batches, [], 'cancelled pass cannot re-index the pruned alias');
    gates[2].resolve();
  });
}

test('a cancelled sync scans only fetched folders and leaves repairs to the new pass', async t => {
  const gates = { 1: deferred(), 2: deferred() };
  const f = scripted(t, {
    gates, folders: ['-srv-a'], indexed: ['vps::-srv-ghost', 'vps::-srv-gone'],
    cached: () => [{ sessionId: 'agent-ghost' }],
  });
  for (const folder of ['-srv-unindexed', '-srv-ghost']) {
    fs.mkdirSync(path.join(f.dir, 'remote/vps/projects', folder), { recursive: true });
  }
  const old = f.indexer.refreshNow();
  await until(() => f.calls.sync === 1);
  f.indexer.restart();
  await until(() => f.calls.sync === 2);
  gates[1].resolve();
  await old;
  assert.deepEqual(f.calls.scans, ['-srv-a'], 'cancelled pass scans only changedFolders');
  assert.deepEqual(f.calls.ghostChecks, [], 'cancelled pass does not inspect ghosts');
  assert.deepEqual(f.calls.drops, [], 'cancelled pass does not drop missing folders');
  gates[2].resolve();
  await until(() => f.calls.batches.length === 2);
  assert.deepEqual(new Set(f.calls.batches[1].folders), new Set(['-srv-unindexed', '-srv-ghost']));
  assert.deepEqual(f.calls.drops, ['vps::-srv-gone'], 'new pass handles missing folders');
  assert.ok(f.calls.ghostChecks.includes('vps::-srv-ghost'), 'new pass checks ghosts');
});

for (const rejects of [false, true]) {
  test(`a new pass waits for the previous alias scan to ${rejects ? 'reject' : 'resolve'}`, async t => {
    const gates = { 2: deferred(), scan: deferred() };
    const events = [];
    const f = scripted(t, {
      gates: { 2: gates[2] }, changedFolders: () => ['-srv-a'],
      onScan: async n => {
        events.push(`start:${n}`);
        if (n === 1) {
          await gates.scan.promise;
          events.push('settled:1');
          if (rejects) throw new Error('old worker failed');
        }
      },
    });
    t.after(() => gates.scan.resolve());
    const old = f.indexer.refreshNow();
    await until(() => f.calls.batches.length === 1);
    f.indexer.restart();
    await until(() => f.calls.sync === 2);
    gates[2].resolve();
    for (let i = 0; i < 10; i++) await tick();
    try {
      assert.deepEqual(events, ['start:1'], 'new scan must not start while the old worker is running');
    } finally {
      gates.scan.resolve();
      await old;
    }
    await until(() => f.calls.batches.length === 2);
    assert.deepEqual(events, ['start:1', 'settled:1', 'start:2']);
  });
}

test('a pass disposed during its sync does not scan the folders that sync fetched', async t => {
  const gates = { 1: deferred() };
  const f = scripted(t, { gates, folders: ['-srv-a'] });
  const old = f.indexer.refreshNow();
  await until(() => f.calls.sync === 1);
  f.indexer.dispose();
  gates[1].resolve();
  await old;
  assert.deepEqual(f.calls.scans, [], 'disposed indexer must not scan into a potentially closed database');
});

for (const fetched of [[], ['-srv-b']]) {
  test(`a queued pass cancelled by another restart scans only its ${fetched.length ? 'fetched folders' : 'empty fetched set'}`, async t => {
    const oldScan = deferred();
    const gates = { 3: deferred() };
    const f = scripted(t, {
      gates,
      changedFolders: n => n === 1 ? ['-srv-a'] : n === 2 ? fetched : [],
      onScan: n => n === 1 ? oldScan.promise : undefined,
    });
    t.after(() => oldScan.resolve());
    fs.mkdirSync(path.join(f.dir, 'remote/vps/projects/-srv-unindexed'), { recursive: true });
    const old = f.indexer.refreshNow();
    await until(() => f.calls.batches.length === 1);
    f.indexer.restart();
    await until(() => f.calls.sync === 2);
    for (let i = 0; i < 10; i++) await tick();
    assert.equal(f.calls.batches.length, 1, 'second generation is queued behind the old scan');
    f.indexer.restart();
    await until(() => f.calls.sync === 3);
    oldScan.resolve();
    await old;
    for (let i = 0; i < 10; i++) await tick();
    assert.deepEqual(f.calls.batches.slice(1).map(batch => batch.folders), fetched.length ? [fetched] : [],
      'a queued pass must discard prepared repairs when it becomes cancelled');
    const before = f.calls.batches.length;
    gates[3].resolve();
    await until(() => f.calls.batches.length === before + 1);
    assert.deepEqual(f.calls.batches.at(-1).folders, ['-srv-unindexed'], 'current generation owns the repair');
  });
}
