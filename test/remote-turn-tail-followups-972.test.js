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

const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const rel = id => `-srv-a/${id}.jsonl`;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function within(promise) {
  let timer;
  try {
    return await Promise.race([promise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 2000); })]);
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
