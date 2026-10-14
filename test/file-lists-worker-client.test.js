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

test('failure during indexing does not acknowledge a manifest and restarts', async t => {
  const r = rig(t, { apply: async () => { throw new Error('DB failed'); } });
  const rejected = assert.rejects(r.client.request(), /DB failed/);
  r.reply();
  await rejected;
  assert.equal(r.workers[0].terminated, true);
});
