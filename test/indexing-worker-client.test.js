'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createIndexingWorkerClient } = require('../indexing-worker-client');

function fixture(options = {}) {
  const workers = [];
  let revision = 0;
  const writes = [];
  const client = createIndexingWorkerClient({
    workerFactory: () => {
      const worker = new EventEmitter();
      worker.messages = [];
      worker.postMessage = message => worker.messages.push(message);
      worker.terminate = () => { worker.terminated = true; return Promise.resolve(); };
      workers.push(worker);
      return worker;
    },
    snapshot: () => ({ version: revision }),
    apply: message => { writes.push(message); revision++; },
    ...options,
  });
  return { client, workers, writes, change: () => revision++ };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('effects yield, acknowledge own revision, and refuse an external write', async () => {
  const f = fixture();
  try {
    const promise = f.client.request({ kind: 'scan' });
    const worker = f.workers[0];
    worker.emit('message', { id: 1, type: 'batch', sequence: 1, version: 0, effects: [] });
    assert.equal(f.writes.length, 0);
    await tick();
    assert.equal(f.writes.length, 1);
    assert.equal(worker.messages.at(-1).version, 1);
    f.change();
    worker.emit('message', { id: 1, type: 'batch', sequence: 2, version: 1, effects: [] });
    await tick();
    assert.equal(f.writes.length, 1);
    assert.equal(worker.messages.at(-1).accepted, false);
    worker.emit('message', { id: 1, type: 'done', result: { sessions: 0 } });
    assert.deepEqual(await promise, { sessions: 0 });
  } finally { f.client.shutdown(); }
});

test('pending refreshes coalesce file paths and full folder scope wins', async () => {
  const f = fixture();
  try {
    const first = f.client.request({ kind: 'refresh', folders: ['folder'], fileSubsets: [['folder', ['a.jsonl']]] });
    const second = f.client.request({ kind: 'refresh', folders: ['folder'], fileSubsets: [['folder', ['b.jsonl']]] });
    const third = f.client.request({ kind: 'refresh', folders: ['folder'] });
    const worker = f.workers[0];
    worker.emit('message', { id: 1, type: 'done', result: {} });
    await first;
    assert.equal(worker.messages.length, 2);
    assert.equal(worker.messages[1].fileSubsets, undefined);
    worker.emit('message', { id: 2, type: 'done', result: {} });
    await second;
    await tick();
    assert.equal(worker.messages.length, 2, 'one active and one merged pending refresh');
    await third;
  } finally { f.client.shutdown(); }
});

test('caller deadline includes queue time and a new request survives apply failure', async () => {
  let throwApply = true;
  const f = fixture({ callerTimeoutMs: 30, apply: () => { if (throwApply) throw new Error('write failed'); } });
  try {
    const first = f.client.request({ kind: 'scan' });
    const queued = assert.rejects(f.client.request({ kind: 'refresh', folders: ['folder'] }), /timed out/);
    await queued;
    const failed = assert.rejects(first, /write failed/);
    f.workers[0].emit('message', { id: 1, type: 'batch', sequence: 1, version: 0, effects: [] });
    await failed;
    assert.equal(f.workers[0].terminated, true);
    assert.equal(f.workers.at(-1).messages[0].folders[0], 'folder');
    f.workers.at(-1).emit('message', { id: 2, type: 'done', result: {} });
    throwApply = false;
    const next = f.client.request({ kind: 'refresh', folders: ['other'] });
    f.workers.at(-1).emit('message', { id: 3, type: 'done', result: {} });
    await next;
  } finally { f.client.shutdown(); }
});

test('hard deadline terminates a hung worker and shutdown rejects queued jobs', async () => {
  const f = fixture({ timeoutMs: 20 });
  const timed = assert.rejects(f.client.request({ kind: 'scan' }), /timed out/);
  await timed;
  assert.equal(f.workers[0].terminated, true);
  const active = assert.rejects(f.client.request({ kind: 'scan' }), /shut down/);
  const queued = assert.rejects(f.client.request({ kind: 'refresh', folders: ['folder'] }), /shut down/);
  f.client.shutdown();
  await Promise.all([active, queued]);
});

test('a refresh remains queued after its caller deadline during a long scan', async () => {
  const f = fixture({ callerTimeoutMs: 20 });
  try {
    const first = f.client.request({ kind: 'scan' });
    const timed = assert.rejects(f.client.request({ kind: 'refresh', folders: ['folder'] }), /timed out/);
    await timed;
    f.workers[0].emit('message', { id: 1, type: 'done', result: {} });
    await first;
    assert.equal(f.workers[0].messages.length, 2, 'expired caller must not discard the pending filesystem mutation');
    f.workers[0].emit('message', { id: 2, type: 'done', result: {} });
  } finally { f.client.shutdown(); }
});

test('diagnostics bracket yielded indexing writes with a stable job identity', async () => {
  const events = [];
  const f = fixture({ trace: (event, data) => events.push([event, data]) });
  try {
    const promise = f.client.request({ kind: 'scan', coldStart: true });
    f.workers[0].emit('message', { id: 1, type: 'batch', sequence: 1, version: 0, effects: [], bytes: 0 });
    await tick();
    f.workers[0].emit('message', { id: 1, type: 'done', result: { sessions: 0, folders: 0 } });
    await promise;
    assert.deepEqual(events.map(([event]) => event), ['indexing.start', 'indexing.apply', 'indexing.job']);
    assert.ok(events.every(([, data]) => data.jobId === 1));
    assert.equal(events[0][1].coldStart, true);
    assert.ok(events[2][1].totalMs >= 0);
  } finally { f.client.shutdown(); }
});
