'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createWriterWorkerClient } = require('../session-index-writer-client');

test('bootstrap observers run before dispatch on every generation and cannot break transport', async () => {
  const workers = [], observed = [], dispatched = [], timers = new Set(), warnings = [];
  const client = createWriterWorkerClient({
    workerFactory() {
      const worker = new EventEmitter();
      worker.terminate = async () => {};
      worker.postMessage = message => { dispatched.push(observed.length); worker.emit('message', { id: message.id, result: true }); };
      workers.push(worker); return worker;
    },
    setTimeout(fn, ms) { const timer = { fn, ms }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); }, now: () => 0,
    log: { warn(message) { warnings.push(message); }, info() {} },
    onBootstrap(message) { observed.push(message.recoveredProjectDeletions); throw new Error('observer failure'); },
  });
  const first = client.request('readProjectDeletionRevision');
  workers[0].emit('message', { ready: true, settings: [], recoveredProjectDeletions: ['first'] });
  assert.equal(await first, true);
  assert.deepEqual(observed, [['first']], 'initial bootstrap identities must reach the observer');
  assert.deepEqual(dispatched, [1], 'observer precedes first dispatch');
  workers[0].emit('exit', 1);
  await new Promise(resolve => setImmediate(resolve));
  const restart = [...timers].find(timer => timer.ms === 100);
  assert.ok(restart, 'replacement is scheduled'); timers.delete(restart); restart.fn();
  const second = client.request('readProjectDeletionRevision');
  workers[1].emit('message', { ready: true, settings: [], recoveredProjectDeletions: ['second'] });
  assert.equal(await second, true);
  assert.deepEqual(observed, [['first'], ['second']], 'replacement bootstrap must not disappear behind one-shot ready');
  assert.deepEqual(dispatched, [1, 2]);
  workers[0].emit('message', { ready: true, settings: [], recoveredProjectDeletions: ['stale'] });
  assert.equal(observed.length, 2);
  await client.terminate();
  assert.equal(warnings.filter(message => /bootstrap.*observer failure/i.test(message)).length, 1, 'bootstrap observer failure is logged once');
});
