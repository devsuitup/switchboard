'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

function fixture(options = {}) {
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
    ...options,
  });
  const reply = (index, value) => worker.emit('message', { id: messages[index].id, result: value });
  return { client, worker, messages, applied, reply, change: () => { version++; } };
}

for (const progress of [false, true]) {
  for (const code of ['WRITER_STALE', 'WRITE_FAILED']) {
    test(`an abandoned ${progress ? 'progress' : 'final'} ${code} apply cannot reject the next worker request`, async t => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      let rejectApply;
      const applying = new Promise((_resolve, reject) => { rejectApply = reject; });
      const workers = [];
      const messages = [];
      const f = fixture({
        timeoutMs: 30,
        workerFactory: () => {
          const worker = new EventEmitter();
          worker.postMessage = message => messages.push(message);
          worker.terminate = async () => { worker.terminated = true; };
          workers.push(worker);
          return worker;
        },
        apply: result => result.effects.length ? applying : undefined,
      });
      try {
        const first = f.client.request();
        const timedOut = assert.rejects(first, /projects worker timed out/);
        workers[0].emit('message', { id: messages[0].id,
          [progress ? 'progress' : 'result']: { effects: [{ name: 'setFolderMeta' }], keptLiveRows: [] } });
        t.mock.timers.tick(30);
        await timedOut;
        const second = f.client.request();
        second.catch(() => {});
        assert.equal(workers.length, 2);
        const result = { effects: [], keptLiveRows: [], reconciled: false, value: 'cached B' };
        workers[1].emit('message', { id: messages[1].id, result });
        rejectApply(Object.assign(new Error('Projects effect snapshot changed while queued'), { code }));
        assert.deepEqual(await second, result);
        assert.equal(workers[1].terminated, undefined);
      } finally {
        rejectApply(new Error('cleanup'));
        await f.client.shutdown();
      }
    });
  }
}

test('async effect acknowledgments complete before publication and cannot absorb a later external write', async () => {
  let release;
  const pendingApply = new Promise(resolve => { release = resolve; });
  let version = 0;
  const f = fixture({
    snapshot: () => ({ version }),
    apply: async result => {
      if (!result.progressApply) return;
      const committed = ++version;
      await pendingApply;
      return { version: committed };
    },
  });
  try {
    const request = f.client.request({ reconcile: true });
    let published = false;
    request.then(() => { published = true; });
    f.worker.emit('message', { id: f.messages[0].id, progress: { progressApply: true, effects: [] } });
    version++;
    f.reply(0, { effects: [{ name: 'stale' }], reconciled: true });
    assert.equal(published, false);
    release();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.messages.length, 2);
    f.reply(1, { effects: [], keptLiveRows: [], reconciled: true });
    await request;
  } finally { release(); f.client.shutdown(); }
});

test('a rejected async effect acknowledgment rejects the original request', async () => {
  const f = fixture({ apply: async () => { throw new Error('write rejected'); } });
  try {
    const request = f.client.request();
    f.reply(0, { effects: [] });
    await assert.rejects(request, /write rejected/);
  } finally { f.client.shutdown(); }
});

for (const progress of [false, true]) {
  test(`a stale ${progress ? 'progress' : 'final'} effect ACK rebuilds instead of rejecting the project view`, async () => {
    let calls = 0;
    const f = fixture({ apply: async () => {
      if (++calls === 1) throw Object.assign(new Error('snapshot changed'), { code: 'WRITER_STALE' });
    } });
    try {
      const request = f.client.request();
      request.catch(() => {});
      if (progress) f.worker.emit('message', { id: f.messages[0].id, progress: { effects: [{ name: 'setName' }] } });
      else f.reply(0, { effects: [{ name: 'setName' }], keptLiveRows: [], value: 'old' });
      await new Promise(resolve => setImmediate(resolve));
      if (progress) {
        f.reply(0, { effects: [], keptLiveRows: [], value: 'old' });
        await new Promise(resolve => setImmediate(resolve));
      }
      assert.equal(f.messages.length, 2, 'a stale ACK must cause a fresh worker snapshot');
      f.reply(1, { effects: [], keptLiveRows: [], value: 'current' });
      assert.equal((await request).value, 'current');
    } finally { await f.client.shutdown(); }
  });
}

test('repeated stale effect ACKs reject within the existing conflict budget', async () => {
  const f = fixture({ apply: async () => { throw Object.assign(new Error('snapshot changed'), { code: 'WRITER_STALE' }); } });
  try {
    const request = f.client.request();
    request.catch(() => {});
    const refused = assert.rejects(request, { code: 'PROJECTS_SNAPSHOT_CONFLICT' });
    for (let i = 0; i < 3; i++) {
      assert.equal(f.messages.length, i + 1);
      f.reply(i, { effects: [{ name: 'setName' }], keptLiveRows: [], value: 'cached' });
      await new Promise(resolve => setImmediate(resolve));
    }
    await refused;
  } finally { await f.client.shutdown(); }
});

test('a dispatch resolves its own callers while later callers coalesce into the pending job', async () => {
  const f = fixture();
  try {
    const first = f.client.request({ reconcile: true });
    const second = f.client.request({ reconcile: false });
    const third = f.client.request({ reconcile: true });
    assert.equal(f.messages.length, 1);
    f.reply(0, { value: 'old' });
    assert.equal(f.messages.length, 2);
    assert.deepEqual(await first, { value: 'old' });
    f.reply(1, { value: 'latest' });
    assert.deepEqual(await Promise.all([second, third]), Array(2).fill({ value: 'latest' }));
    assert.deepEqual(f.applied, [{ value: 'old' }, { value: 'latest' }]);
  } finally { f.client.shutdown(); }
});

test('one reload per job still resolves every caller within one subsequent dispatch', async () => {
  const f = fixture();
  let resolved = 0;
  const waiters = [f.client.request().then(() => resolved++)];
  try {
    for (let i = 0; i < 50; i++) {
      waiters.push(f.client.request().then(() => resolved++));
      f.reply(i, { effects: [], keptLiveRows: [], reconciled: false });
      await Promise.resolve();
      assert.equal(resolved, i + 1);
    }
    f.reply(50, { effects: [], keptLiveRows: [], reconciled: false });
    await Promise.all(waiters);
    assert.equal(resolved, 51);
  } finally { f.client.shutdown(); await Promise.allSettled(waiters); }
});

test('pending non-reconcile requests cannot cancel requested reconciliation', async () => {
  const f = fixture();
  const waiters = [f.client.request({ reconcile: true }), f.client.request({ reconcile: false })];
  waiters.forEach(p => p.catch(() => {}));
  try {
    f.change();
    f.reply(0, { effects: [{ name: 'write' }] });
    assert.equal(f.messages[1].reconcile, true);
    f.reply(1, { value: 'fresh' });
    await Promise.all(waiters);
  } finally { f.client.shutdown(); }
});

test('three version conflicts reject without stale writes or arrays', async () => {
  const f = fixture();
  const waiter = f.client.request();
  waiter.catch(() => {});
  const refused = assert.rejects(waiter, { code: 'PROJECTS_SNAPSHOT_CONFLICT' });
  try {
    for (let i = 0; i < 3; i++) {
      f.change();
      f.reply(i, { value: i, effects: [{ name: 'write' }], keptLiveRows: [['live', 'folder']], reconciled: true });
    }
    assert.equal(f.messages.length, 3);
    await refused;
    assert.deepEqual(f.applied, []);
  } finally { f.client.shutdown(); }
});

test('version retries cannot extend an individual caller deadline', async () => {
  const f = fixture({ timeoutMs: 30, maxDiscards: 100 });
  const waiter = f.client.request();
  const rejected = assert.rejects(waiter, /timed out/);
  const interval = setInterval(() => {
    f.change();
    f.reply(f.messages.length - 1, { effects: [{ name: 'write' }] });
  }, 5);
  const guard = setTimeout(() => f.client.shutdown(), 150);
  try { await rejected; } finally { clearInterval(interval); clearTimeout(guard); f.client.shutdown(); }
});

test('completed folder writes survive a caller timeout and a slow reconcile advances on completion', async () => {
  const f = fixture({ timeoutMs: 20 });
  const waiter = f.client.request({ reconcile: true });
  const rejected = assert.rejects(waiter, /timed out/);
  try {
    f.worker.emit('message', { id: f.messages[0].id, progress: { effects: [{ name: 'folder' }], keptLiveRows: [] } });
    assert.equal(f.applied.length, 1);
    await rejected;
    f.reply(0, { value: 'complete', effects: [], keptLiveRows: [], reconciled: true });
    assert.equal(f.applied.at(-1).reconciled, true);
    const next = f.client.request({ reconcile: false });
    f.reply(1, { value: 'built' });
    assert.deepEqual(await next, { value: 'built' });
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

test('a background-state change retries a read-only reply against the current live snapshot', async () => {
  let liveVersion = 'working';
  const f = fixture({ snapshot: () => ({ version: 'db-' + liveVersion, liveVersion }) });
  const pending = f.client.request({ reconcile: false });
  pending.catch(() => {});
  try {
    liveVersion = 'completed';
    f.reply(0, { effects: [], keptLiveRows: [], reconciled: false, value: 'old badge' });
    assert.equal(f.messages.length, 2);
    assert.equal(f.messages[1].liveVersion, 'completed');
    assert.deepEqual(f.applied, []);
    const result = { effects: [], keptLiveRows: [], reconciled: false, value: 'no badge' };
    f.reply(1, result);
    assert.deepEqual(await pending, result);
  } finally { f.client.shutdown(); }
});

test('a DB-only change preserves first paint when the live snapshot is unchanged', async () => {
  let version = 0;
  const f = fixture({ snapshot: () => ({ version, liveVersion: 'working' }) });
  try {
    const pending = f.client.request({ reconcile: false });
    pending.catch(() => {});
    version++;
    const result = { effects: [], keptLiveRows: [], reconciled: false, value: 'partial' };
    f.reply(0, result);
    assert.equal(f.messages.length, 1);
    assert.deepEqual(await pending, result);
  } finally { f.client.shutdown(); }
});
