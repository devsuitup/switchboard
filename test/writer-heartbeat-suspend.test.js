'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createWriterWorkerClient } = require('../session-index-writer-client');

function virtualTimers() {
  let time = 0, id = 0;
  const timers = new Map();
  return {
    time: () => time,
    setTimeout(fn, ms) { const key = ++id; timers.set(key, { fn, at: time + ms }); return key; },
    clearTimeout: key => timers.delete(key),
    advance(ms) {
      time += ms;
      for (const [key, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= time && timers.has(key)) { timers.delete(key); timer.fn(); }
      }
    },
  };
}

const turn = () => new Promise(resolve => setImmediate(resolve));

function fixture({ clocks = 'both' } = {}) {
  const timers = virtualTimers(), workers = [], warnings = [];
  const frozen = () => 0;
  const client = createWriterWorkerClient({
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    now: clocks === 'monotonic' ? frozen : timers.time,
    clock: clocks === 'wall' ? frozen : timers.time,
    timeoutMs: 5000, heartbeatMs: 500,
    log: { info() {}, warn: message => warnings.push(message) },
    workerFactory() {
      const worker = new EventEmitter();
      worker.terminate = async () => {};
      worker.postMessage = message => {
        worker.last = message;
        if (message.command === 'close') queueMicrotask(() => worker.emit('message', { id: message.id }));
      };
      workers.push(worker);
      queueMicrotask(() => worker.emit('message', { ready: true, settings: [] }));
      return worker;
    },
  });
  return { client, timers, workers, warnings };
}

for (const clocks of ['both', 'wall', 'monotonic']) {
  test(`a heartbeat deadline reached late after a system sleep keeps the writer (${clocks} clock)`, async () => {
    const f = fixture({ clocks });
    await f.client.ready;
    try {
      let outcome = 'pending';
      const job = f.client.request('setSetting', 'k', 1);
      job.then(() => { outcome = 'resolved'; }, error => { outcome = error.message; });
      f.timers.advance(9 * 60 * 60 * 1000);
      await turn();
      assert.equal(outcome, 'pending', 'the in-flight request is not failed by the sleep');
      assert.equal(f.workers.length, 1, 'the writer is not restarted');
      assert.equal(f.warnings.length, 1);
      assert.match(f.warnings[0], /\[session-index-writer\] heartbeat deadline reached \d+ ms late/);
      const worker = f.workers[0];
      worker.emit('message', { heartbeat: true });
      worker.emit('message', { id: worker.last.id, result: 'ok' });
      await turn();
      assert.equal(outcome, 'resolved');
    } finally { await f.client.terminate(); }
  });
}

test('a writer still silent one interval after a late deadline is failed as unresponsive', async () => {
  const f = fixture();
  await f.client.ready;
  try {
    let settled = false;
    const job = f.client.request('setSetting', 'k', 1);
    job.catch(() => {}).finally(() => { settled = true; });
    const failed = assert.rejects(job, /outcome unknown.*heartbeat timed out; unresponsive/);
    f.timers.advance(60 * 1000);
    await turn();
    assert.equal(settled, false, 'the late deadline grants one more interval');
    f.timers.advance(499);
    await turn();
    assert.equal(settled, false);
    f.timers.advance(1);
    await failed;
    await turn();
    f.timers.advance(100);
    await turn();
    assert.equal(f.workers.length, 2, 'the stalled writer is replaced');
  } finally { await f.client.terminate(); }
});

test('a deadline that fires on time still fails a silent writer, with no sleep warning', async () => {
  const f = fixture();
  await f.client.ready;
  try {
    const job = f.client.request('setSetting', 'k', 1);
    const failed = assert.rejects(job, /heartbeat timed out; unresponsive/);
    f.timers.advance(500);
    await failed;
    assert.deepEqual(f.warnings, []);
  } finally { await f.client.terminate(); }
});

test('a deadline under one second late is not treated as a sleep', async () => {
  const f = fixture();
  await f.client.ready;
  try {
    const job = f.client.request('setSetting', 'k', 1);
    const failed = assert.rejects(job, /heartbeat timed out; unresponsive/);
    f.timers.advance(1499);
    await failed;
    assert.deepEqual(f.warnings, []);
  } finally { await f.client.terminate(); }
});
