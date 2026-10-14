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

test('failure during background indexing is reported and retries without callers or a worker restart', async t => {
  const errors = [];
  const applied = [];
  const r = rig(t, { apply: async result => {
    if (result.view === 'ready') throw new Error('DB failed');
    applied.push(result.view);
    return true;
  }, onError: error => errors.push(error) });
  const result = r.client.request();
  r.reply({ view: 'ready' });
  assert.equal((await result).view, 'ready');
  await nextTurn();
  assert.match(errors[0].message, /DB failed/);
  assert.equal(r.workers[0].terminated, false);
  assert.equal(r.workers[0].messages.length, 2);
  r.reply({ view: 'retry' });
  await nextTurn();
  assert.deepEqual(applied, ['retry']);
  assert.equal(r.workers.length, 1);
});

test('an apply failure preserves active and queued scan callers and retries through the healthy scan', async t => {
  const errors = [];
  const applied = [];
  const r = rig(t, { apply: async result => {
    if (result.view === 'first') throw new Error('DB failed');
    applied.push(result.view);
    return true;
  }, onError: error => errors.push(error) });
  const first = r.client.request();
  r.reply({ view: 'first' });
  await first;
  const healthy = r.client.request().then(value => ({ value }), error => ({ error }));
  const queued = r.client.request().then(value => ({ value }), error => ({ error }));
  await nextTurn();
  assert.match(errors[0].message, /DB failed/);
  assert.equal(r.workers[0].terminated, false, 'an apply failure must not terminate a healthy scan');
  assert.equal(r.workers[0].messages.length, 2);
  r.reply({ view: 'healthy' });
  assert.equal((await healthy).value.view, 'healthy');
  r.reply({ view: 'queued' });
  assert.equal((await queued).value.view, 'queued');
  await nextTurn();
  await nextTurn();
  assert.ok(applied.includes('queued'));
  assert.equal(r.workers.length, 1);
});

test('repeated apply failures stop retrying at the discard limit and leave navigation available', async t => {
  const errors = [];
  const r = rig(t, { apply: async result => {
    if (result.view !== 'recovered') throw new Error('DB failed');
    return true;
  }, onError: error => errors.push(error) });
  const first = r.client.request();
  r.reply({ view: 'first' });
  await first;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await nextTurn();
    assert.equal(errors.filter(error => /DB failed/.test(error.message)).length, attempt);
    assert.equal(r.workers[0].messages.length, Math.min(attempt + 1, 3));
    if (attempt < 3) r.reply({ view: 'retry' });
  }
  const recovered = r.client.request();
  r.reply({ view: 'recovered' });
  assert.equal((await recovered).view, 'recovered');
  assert.equal(r.workers.length, 1);
});

test('a published apply hard deadline cancels only that apply and preserves a newer healthy scan', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const errors = [];
  const applied = [];
  let firstValid;
  const r = rig(t, { timeoutMs: 1000, hardTimeoutMs: 100, apply: async (result, valid) => {
    if (result.view === 'first') {
      firstValid = valid;
      await gate;
    }
    if (valid()) applied.push(result.view);
    return valid();
  }, onError: error => errors.push(error) });
  try {
    const first = r.client.request();
    r.reply({ view: 'first' });
    await first;
    await nextTurn();
    t.mock.timers.tick(50);
    const healthy = r.client.request().then(value => ({ value }), error => ({ error }));
    t.mock.timers.tick(50);
    assert.equal(firstValid(), false, 'the expired apply must stop writing');
    assert.match(errors[0].message, /hard deadline/);
    assert.equal(r.workers[0].terminated, false, 'the newer scan still has 50ms left');
    r.reply({ view: 'healthy' });
    assert.equal((await healthy).value.view, 'healthy');
    assert.deepEqual(applied, []);
  } finally { release(); }
  await nextTurn();
  await nextTurn();
  assert.deepEqual(applied, ['healthy']);
  assert.equal(r.workers.length, 1);
});

test('a request during a slow index apply resolves without waiting for that apply', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let applying = false;
  let completed = false;
  const r = rig(t, { apply: async () => { applying = true; await gate; completed = true; return true; } });
  let published;
  const first = r.client.request().then(value => { published = value; });
  const payload = { view: 'ready' };
  r.reply(payload);
  try {
    await Promise.resolve();
    assert.equal(published, payload, 'the view must publish without waiting for FTS');
    assert.equal(applying, false, 'the first write must yield to the IPC reply');
    await nextTurn();
    assert.equal(applying, true);
    assert.equal(completed, false);
    let second;
    const pending = r.client.request().then(value => { second = value; });
    pending.catch(() => {});
    assert.equal(r.workers[0].messages.length, 2, 'navigation must dispatch during the first apply');
    r.reply({ view: 'next' });
    await Promise.resolve();
    assert.equal(second.view, 'next', 'navigation must resolve while the apply gate is still closed');
    assert.equal(completed, false);
    await pending;
  } finally { release(); }
  await first;
  await nextTurn();
});

test('two published index applies never overlap while scans continue', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const started = [];
  let running = 0;
  let peak = 0;
  const r = rig(t, { apply: async result => {
    started.push(result.view);
    peak = Math.max(peak, ++running);
    if (result.view === 'first') await gate;
    running--;
    return true;
  } });
  const first = r.client.request();
  r.reply({ view: 'first' });
  await first;
  await nextTurn();
  const second = r.client.request();
  second.catch(() => {});
  try {
    assert.equal(r.workers[0].messages.length, 2);
    r.reply({ view: 'second' });
    await second;
    await nextTurn();
    assert.deepEqual(started, ['first']);
  } finally { release(); }
  await nextTurn();
  await nextTurn();
  assert.deepEqual(started, ['first', 'second']);
  assert.equal(peak, 1);
});

test('published deltas coalesce to the latest scan while one apply owns the slot', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const applied = [];
  const r = rig(t, { apply: async result => {
    applied.push(result.view);
    if (result.view === 'first') await gate;
    return true;
  } });
  try {
    const first = r.client.request();
    r.reply({ view: 'first' });
    await first;
    await nextTurn();
    for (const view of ['second', 'latest']) {
      const pending = r.client.request();
      r.reply({ view });
      assert.equal((await pending).view, view);
    }
    assert.deepEqual(applied, ['first']);
  } finally { release(); }
  await nextTurn();
  await nextTurn();
  assert.deepEqual(applied, ['first', 'latest']);
});

test('a worker restart cannot overlap a cancelled apply with the next published delta', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const applied = [];
  const errors = [];
  let running = 0;
  let peak = 0;
  const r = rig(t, { apply: async (result, valid) => {
    peak = Math.max(peak, ++running);
    if (result.view === 'first') await gate;
    if (valid()) applied.push(result.view);
    running--;
    return valid();
  }, onError: error => errors.push(error) });
  try {
    const first = r.client.request();
    r.reply({ view: 'first' });
    await first;
    await nextTurn();
    r.workers[0].emit('error', new Error('broken worker'));
    const recovered = r.client.request();
    r.reply({ view: 'recovered' });
    assert.equal((await recovered).view, 'recovered');
    await nextTurn();
    assert.deepEqual(applied, []);
    assert.equal(running, 1);
    assert.equal(r.workers.length, 2);
    assert.equal(errors.length, 1);
  } finally { release(); }
  await nextTurn();
  await nextTurn();
  assert.deepEqual(applied, ['recovered']);
  assert.equal(peak, 1);
});

test('shutdown invalidates the active apply and drops the queued published delta', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const started = [];
  const applied = [];
  const r = rig(t, { apply: async (result, valid) => {
    started.push(result.view);
    await gate;
    if (valid()) applied.push(result.view);
    return valid();
  } });
  try {
    const first = r.client.request();
    r.reply({ view: 'first' });
    await first;
    await nextTurn();
    const second = r.client.request();
    r.reply({ view: 'second' });
    await second;
    r.client.shutdown();
  } finally { release(); }
  await nextTurn();
  await nextTurn();
  assert.deepEqual(started, ['first']);
  assert.deepEqual(applied, []);
});

test('a policy change invalidates both an ongoing apply and a concurrent scan before publication', async t => {
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
  r.reply({ view: 'stale concurrent scan' });
  assert.equal(r.workers[0].messages.length, 3);
  await Promise.resolve();
  assert.equal(published, false);
  r.reply({ view: 'fresh' });
  assert.equal((await pending).view, 'fresh');
  await nextTurn();
  assert.equal(writes, 1);
});

test('a concurrent scan caller timeout does not cancel an already published index apply', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let applied = false;
  const r = rig(t, { timeoutMs: 100, hardTimeoutMs: 1000, apply: async (_result, valid) => { await gate; applied = valid(); return applied; } });
  const first = r.client.request();
  r.reply({ view: 'first' });
  await first;
  await nextTurn();
  const rejected = assert.rejects(r.client.request(), /timed out/);
  try {
    t.mock.timers.tick(100);
    await rejected;
    assert.equal(r.workers[0].terminated, true);
    assert.equal(applied, false);
  } finally { release(); }
  await nextTurn();
  assert.equal(applied, true, 'terminating an expired scan must preserve the published apply');
  const retry = r.client.request();
  r.reply({ view: 'next' });
  assert.equal((await retry).view, 'next');
  assert.equal(r.workers.length, 2);
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

test('an incomplete concurrent delta retries in the background without retracting its view', async t => {
  const attempted = [];
  const r = rig(t, { apply: async result => {
    attempted.push(result.view);
    return result.view === 'refreshed';
  } });
  const first = r.client.request();
  r.reply({ view: 'ready' });
  assert.equal((await first).view, 'ready');
  await nextTurn();
  assert.equal(r.workers[0].messages.length, 2);
  r.reply({ view: 'refreshed' });
  await nextTurn();
  assert.deepEqual(attempted, ['ready', 'refreshed']);
});
