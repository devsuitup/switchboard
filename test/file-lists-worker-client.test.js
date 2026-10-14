'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { createFileListsWorkerClient } = require('../file-lists-worker-client');

function rig(t, options = {}) {
  const workers = [];
  const writes = [];
  let version = 'v1';
  const client = createFileListsWorkerClient({
    workerFactory: () => {
      const worker = new EventEmitter();
      worker.messages = [];
      worker.terminated = false;
      worker.postMessage = message => worker.messages.push(message);
      worker.terminate = () => { worker.terminated = true; return Promise.resolve(); };
      workers.push(worker);
      return worker;
    },
    snapshot: () => ({ version }),
    apply: async result => { writes.push(result); return true; },
    ...options,
  });
  t.after(() => client.shutdown());
  const reply = (result = {}) => {
    const worker = workers.at(-1);
    worker.emit('message', { id: worker.messages.at(-1).id, result });
  };
  return { client, workers, writes, reply, change: () => { version += 'x'; } };
}

test('51 arriving callers own two coalesced jobs and the first valid reply is published', async t => {
  const r = rig(t);
  const first = r.client.request();
  const rest = Array.from({ length: 50 }, () => r.client.request());
  assert.equal(r.workers[0].messages.length, 1);
  const initial = { view: 'first' };
  r.reply(initial);
  assert.equal(await first, initial);
  await nextTurn();
  assert.equal(r.workers[0].messages.length, 2);
  const latest = { view: 'latest' };
  r.reply(latest);
  assert.ok((await Promise.all(rest)).every(value => value === latest));
});

test('stale policy retries without applying and rejects after bounded conflicts', async t => {
  const r = rig(t);
  const result = r.client.request();
  const rejected = assert.rejects(result, /snapshot changed/);
  for (let i = 0; i < 3; i++) {
    r.change();
    r.reply({ view: 'stale' });
    await nextTurn();
  }
  await rejected;
  assert.equal(r.writes.length, 0);
  assert.equal(r.workers[0].messages.length, 3);
});

test('a caller deadline includes queue and retries and later callers retain their own deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = rig(t, { timeoutMs: 100, hardTimeoutMs: 1000 });
  const first = r.client.request();
  const firstRejected = assert.rejects(first, /timed out/);
  t.mock.timers.tick(50);
  const queued = r.client.request();
  r.change();
  r.reply();
  await nextTurn();
  t.mock.timers.tick(50);
  await firstRejected;
  r.reply({ view: 'fresh' });
  assert.equal((await queued).view, 'fresh');
});

test('a queued caller expires at registration deadline rather than dispatch deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = rig(t, { timeoutMs: 100, hardTimeoutMs: 1000 });
  const first = r.client.request();
  t.mock.timers.tick(50);
  const queued = r.client.request();
  const rejected = assert.rejects(queued, /timed out/);
  t.mock.timers.tick(25);
  r.reply();
  await first;
  await nextTurn();
  t.mock.timers.tick(75);
  await rejected;
  assert.equal(r.workers[0].terminated, true);
});

test('a hard deadline rejects outstanding work, terminates the worker and permits a fresh worker', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = rig(t, { timeoutMs: 1000, hardTimeoutMs: 100 });
  const rejected = assert.rejects(r.client.request(), /hard deadline/);
  t.mock.timers.tick(100);
  await rejected;
  assert.equal(r.workers[0].terminated, true);
  const retry = r.client.request();
  assert.equal(r.workers.length, 2);
  r.reply({ view: 'recovered' });
  assert.equal((await retry).view, 'recovered');
});

for (const failure of ['error', 'exit', 'reply']) {
  test(`${failure} failure rejects active and pending callers and restarts`, async t => {
    const r = rig(t);
    const first = assert.rejects(r.client.request(), /broken|exited/);
    const pending = assert.rejects(r.client.request(), /broken|exited/);
    if (failure === 'error') r.workers[0].emit('error', new Error('broken'));
    else if (failure === 'exit') r.workers[0].emit('exit', 1);
    else r.workers[0].emit('message', { id: 1, error: 'broken' });
    await Promise.all([first, pending]);
    const retry = r.client.request();
    r.reply();
    await retry;
    assert.equal(r.workers.length, 2);
  });
}

test('shutdown rejects active and pending callers and refuses future requests', async t => {
  const r = rig(t);
  const first = assert.rejects(r.client.request(), /shut down/);
  const pending = assert.rejects(r.client.request(), /shut down/);
  r.client.shutdown();
  await Promise.all([first, pending]);
  await assert.rejects(r.client.request(), /shut down/);
  assert.equal(r.workers[0].terminated, true);
});

test('failure during background indexing is reported, preserves the published view and restarts', async t => {
  const errors = [];
  const r = rig(t, { apply: async () => { throw new Error('DB failed'); }, onError: error => errors.push(error) });
  const result = r.client.request();
  r.reply({ view: 'ready' });
  assert.equal((await result).view, 'ready');
  await nextTurn();
  assert.match(errors[0].message, /DB failed/);
  assert.equal(r.workers[0].terminated, true);
  const retry = r.client.request();
  r.reply({ view: 'retry' });
  assert.equal((await retry).view, 'retry');
  assert.equal(r.workers.length, 2);
});

test('a valid view resolves before indexing starts and pending jobs wait for that apply', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let applying = false;
  let completed = false;
  const r = rig(t, { apply: async () => { applying = true; await gate; completed = true; return true; } });
  let published;
  const first = r.client.request().then(value => { published = value; });
  const payload = { view: 'ready' };
  r.reply(payload);
  const pending = r.client.request();
  pending.catch(() => {});
  try {
    await Promise.resolve();
    assert.equal(published, payload, 'the view must publish without waiting for FTS');
    assert.equal(applying, false, 'the first write must yield to the IPC reply');
    await nextTurn();
    assert.equal(applying, true);
    assert.equal(completed, false);
    assert.equal(r.workers[0].messages.length, 1);
  } finally { release(); }
  await first;
  await nextTurn();
  assert.equal(r.workers[0].messages.length, 2);
  r.reply({ view: 'next' });
  assert.equal((await pending).view, 'next');
});

test('a policy change after publication retries the background delta before serving pending callers', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let writes = 0;
  const r = rig(t, { apply: async (_result, valid) => { await gate; if (valid()) writes++; return valid(); } });
  const first = r.client.request();
  r.reply({ view: 'first' });
  assert.equal((await first).view, 'first');
  await nextTurn();
  const pending = r.client.request();
  pending.catch(() => {});
  r.change();
  release();
  await nextTurn();
  assert.equal(writes, 0);
  assert.equal(r.workers[0].messages.length, 2);
  let published = false;
  pending.then(() => { published = true; });
  await Promise.resolve();
  assert.equal(published, false);
  r.reply({ view: 'fresh' });
  assert.equal((await pending).view, 'fresh');
  await nextTurn();
  assert.equal(writes, 1);
});

test('a pending caller timeout does not cancel an already published index apply', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const r = rig(t, { timeoutMs: 100, hardTimeoutMs: 1000, apply: async () => { await gate; return true; } });
  const first = r.client.request();
  r.reply({ view: 'first' });
  await first;
  await nextTurn();
  const rejected = assert.rejects(r.client.request(), /timed out/);
  try {
    t.mock.timers.tick(100);
    await rejected;
    assert.equal(r.workers[0].terminated, false);
  } finally { release(); }
  await nextTurn();
  const retry = r.client.request();
  r.reply({ view: 'next' });
  assert.equal((await retry).view, 'next');
  assert.equal(r.workers.length, 1);
});

test('a published index apply retries a changed policy even when there are no pending callers', async t => {
  let writes = 0;
  const r = rig(t, { apply: async (_result, valid) => { if (valid()) writes++; return valid(); } });
  const first = r.client.request();
  r.reply({ view: 'first' });
  await first;
  r.change();
  await nextTurn();
  assert.equal(r.workers[0].messages.length, 2);
  r.reply({ view: 'fresh' });
  await nextTurn();
  assert.equal(writes, 1);
});
