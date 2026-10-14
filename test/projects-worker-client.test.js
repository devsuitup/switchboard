'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

function fixture() {
  const { createProjectsWorkerClient } = require('../projects-worker-client');
  const worker = new EventEmitter();
  const messages = [];
  let version = 0;
  const applied = [];
  worker.postMessage = message => messages.push(message);
  worker.terminate = () => Promise.resolve();
  const client = createProjectsWorkerClient({
    workerFactory: () => worker,
    snapshot: () => ({ version, state: version }),
    apply: result => applied.push(result),
  });
  const reply = (index, value) => worker.emit('message', { id: messages[index].id, result: value });
  return { client, worker, messages, applied, reply, change: () => { version++; } };
}

test('overlapping callers coalesce into one latest pending request and never publish older work', async () => {
  const f = fixture();
  try {
    const first = f.client.request({ reconcile: true });
    const second = f.client.request({ reconcile: false });
    const third = f.client.request({ reconcile: true });
    assert.equal(f.messages.length, 1);
    f.reply(0, { value: 'old' });
    assert.equal(f.messages.length, 2);
    assert.deepEqual(f.applied, []);
    f.reply(1, { value: 'latest' });
    assert.deepEqual(await Promise.all([first, second, third]), Array(3).fill({ value: 'latest' }));
    assert.deepEqual(f.applied, [{ value: 'latest' }]);
  } finally { f.client.shutdown(); }
});

test('a watcher write discards stale effects and retries against current state', async () => {
  const f = fixture();
  try {
    const pending = f.client.request();
    f.change();
    f.reply(0, { value: 'stale' });
    assert.deepEqual(f.applied, []);
    assert.equal(f.messages[1].version, 1);
    f.reply(1, { value: 'fresh' });
    assert.deepEqual(await pending, { value: 'fresh' });
  } finally { f.client.shutdown(); }
});

test('worker failure rejects all waiters and a later request can restart', async () => {
  const f = fixture();
  const failed = f.client.request();
  const rejection = assert.rejects(failed, /broken/);
  f.worker.emit('error', new Error('broken'));
  await rejection;
  const retry = f.client.request();
  f.reply(1, { value: 'recovered' });
  assert.deepEqual(await retry, { value: 'recovered' });
  f.client.shutdown();
});

test('shutdown rejects a pending request and refuses later requests', async () => {
  const f = fixture();
  const pending = f.client.request();
  const rejected = assert.rejects(pending, /shut down/);
  f.client.shutdown();
  await rejected;
  await assert.rejects(f.client.request(), /shut down/);
});

test('cold-start scan writes do not postpone a read-only partial projects reply', async () => {
  const f = fixture();
  try {
    const pending = f.client.request({ reconcile: false });
    pending.catch(() => {});
    f.change();
    const result = { effects: [], keptLiveRows: [], reconciled: false, value: 'partial' };
    f.reply(0, result);
    assert.equal(f.messages.length, 1);
    assert.deepEqual(await pending, result);
  } finally { f.client.shutdown(); }
});
