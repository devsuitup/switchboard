'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

function fixture({ complete = true, folders = ['broken', 'healthy'] } = {}) {
  let now = 0, nextTimer = 0;
  const timers = new Map(), workers = [], workerAttempts = [], statuses = [], written = [], errors = [];
  const faults = {};
  const failing = new Set(['broken']);
  const reasons = new Map();
  class ScanWorker extends EventEmitter {
    constructor(_filename, { workerData }) {
      super();
      workerAttempts.push(workerData);
      if (faults.worker) throw faults.worker;
      workers.push(workerData);
      setImmediate(() => {
        const scope = workerData.folders || folders;
        scope.forEach((folder, index) => this.emit('message', {
          type: 'folder', result: { folder }, current: index + 1, total: scope.length,
        }));
        this.emit('message', { type: 'done', ok: true });
        this.emit('exit', 0);
      });
    }
    terminate() { this.emit('exit', 0); return Promise.resolve(); }
  }
  const filename = path.join(__dirname, '../session-cache.js');
  const localRequire = createRequire(filename);
  const context = {
    module: { exports: {} }, __dirname: path.dirname(filename), Buffer, console: { error() {} },
    require: name => name === 'worker_threads' ? { Worker: ScanWorker } : localRequire(name),
    setTimeout(callback, delay) {
      const timer = { id: ++nextTimer, unref() {} };
      timers.set(timer, { at: now + delay, callback });
      return timer;
    },
    clearTimeout: timer => timers.delete(timer), setImmediate,
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const cache = context.module.exports;
  cache.init({ PROJECTS_DIR: 'fixture', activeSessions: new Map(), now: () => now,
    getMainWindow: () => ({ isDestroyed: () => false, webContents: {
      send(channel, message, level) { if (channel === 'status-update') statuses.push({ message, level }); },
    } }),
    log: { error(...args) { errors.push(args); }, warn() {}, info() {} },
    db: { getSetting() {
      if (faults.remaps) throw faults.remaps;
      return null;
    }, isInitialScanComplete() {
      if (faults.initialScan) throw faults.initialScan;
      return complete;
    }, setInitialScanComplete() {} },
    writer: {
      async writeScannedFolder({ folder }) {
        written.push(folder);
        if (failing.has(folder)) throw new Error(reasons.get(folder) || 'snapshot changed');
        return 1;
      },
      async setInitialScanComplete() { complete = true; },
    },
  });
  async function advance(ms) {
    const end = now + ms;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      timers.delete(id);
      now = timer.at;
      await timer.callback();
      await new Promise(resolve => setImmediate(resolve));
    }
    now = end;
  }
  async function fireRetryEarly(by = 1) {
    const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
    assert.ok(next, 'a retry timer must be armed');
    const [id, timer] = next;
    timers.delete(id);
    now = timer.at - by;
    assert.doesNotThrow(() => timer.callback(), 'the timer must contain synchronous errors');
    await new Promise(resolve => setImmediate(resolve));
  }
  return { cache, failing, reasons, workers, workerAttempts, statuses, written, advance, fireRetryEarly,
    errors, faults, complete: () => complete };
}

for (const earlyBy of [1, 60000]) {
  test(`a retry timer waking ${earlyBy} ms before its deadline runs and clears the error`, async () => {
    const f = fixture();
    await f.cache.populateCacheViaWorker();
    await f.advance(29999);
    await f.cache.populateCacheViaWorker();
    assert.equal(f.workers.length, 1, 'ordinary callers must respect backoff');
    f.failing.clear();
    await f.fireRetryEarly(earlyBy);
    assert.equal(f.workers.length, 2, 'an early timer must not lose the retry');
    assert.equal(f.statuses.at(-1).level, 'done');
    await f.advance(5000);
    assert.equal(f.statuses.at(-1).message, '');
  });
}

for (const fault of ['initialScan']) {
  test(`a retry timer logs a ${fault} error without an uncaught exception or rejection`, async () => {
    const f = fixture();
    await f.cache.populateCacheViaWorker();
    const error = new Error(`${fault} failed during retry`);
    f.faults[fault] = error;
    f.errors.length = 0;
    await assert.doesNotReject(f.advance(30000), 'timer errors must not escape');
    assert.equal(f.errors.length, 1, 'the timer failure must reach the existing logger');
    assert.equal(f.errors[0][1], error);
    assert.equal(f.workers.length, 1);
  });
}

for (const fault of ['worker', 'remaps']) {
  test(`a synchronous ${fault} failure resolves and permits a successful forced scan`, async () => {
    const f = fixture({ complete: false });
    f.failing.clear();
    f.faults[fault] = new Error(`${fault} unavailable`);
    await assert.doesNotReject(f.cache.populateCacheViaWorker());
    assert.equal(f.statuses.at(-1).message, `Scan failed: ${fault} unavailable`);
    assert.equal(f.statuses.at(-1).level, 'error');
    assert.equal(f.cache.isIndexingFinished(), true);
    assert.equal(f.complete(), false);
    assert.equal(f.workers.length, 0);
    delete f.faults[fault];
    await f.cache.populateCacheViaWorker({ force: true });
    assert.equal(f.workers.length, 1, 'the failed promise must be released');
    assert.equal(f.complete(), true);
    assert.equal(f.statuses.at(-1).level, 'done');
    await f.advance(5000);
    assert.equal(f.statuses.at(-1).message, '');
    await f.advance(1000000);
    assert.equal(f.workers.length, 1, 'forced success must cancel the retry');
  });

  test(`a synchronous ${fault} failure recovers on the scheduled retry`, async () => {
    const f = fixture();
    f.failing.clear();
    f.faults[fault] = new Error(`${fault} unavailable`);
    await assert.doesNotReject(f.cache.populateCacheViaWorker());
    assert.equal(f.statuses.at(-1).message, `Scan failed: ${fault} unavailable`);
    delete f.faults[fault];
    await f.advance(29999);
    await f.cache.populateCacheViaWorker();
    assert.equal(f.workers.length, 0, 'ordinary callers must respect the backoff');
    await f.advance(1);
    assert.equal(f.workers.length, 1, 'the retry must recover without a caller');
    assert.equal(f.workers[0].folders, undefined, 'an unknown failure retries the full scan');
    assert.equal(f.statuses.at(-1).level, 'done');
    await f.advance(5000);
    assert.equal(f.statuses.at(-1).message, '');
    await f.advance(1000000);
    assert.equal(f.workers.length, 1);
  });
}

test('persistent worker construction failure uses only the existing three delayed retries', async () => {
  const f = fixture();
  f.faults.worker = new Error('worker unavailable');
  await assert.doesNotReject(f.cache.populateCacheViaWorker());
  assert.equal(f.workerAttempts.length, 1);
  for (const [index, delay] of [30000, 120000, 600000].entries()) {
    await f.advance(delay - 1);
    await f.cache.populateCacheViaWorker();
    assert.equal(f.workerAttempts.length, index + 1);
    await f.advance(1);
    assert.equal(f.workerAttempts.length, index + 2);
    assert.equal(f.statuses.at(-1).message, 'Scan failed: worker unavailable');
  }
  await f.advance(10000000);
  await f.cache.populateCacheViaWorker();
  assert.equal(f.workerAttempts.length, 4, 'exhausted backoff must not restart');
  assert.equal(f.workers.length, 0);
  assert.equal(f.statuses.some(status => status.message === '' || status.level === 'done'), false);
});

test('a named folder failure supplies its own reason after an unknown-folder failure', async () => {
  const f = fixture({ folders: [undefined, 'broken', 'healthy'] });
  f.failing.add(undefined);
  f.failing.add('healthy');
  f.reasons.set(undefined, 'unknown failure');
  f.reasons.set('broken', 'named failure');
  f.reasons.set('healthy', 'later named failure');
  await f.cache.populateCacheViaWorker();
  assert.equal(f.statuses.at(-1).message, 'Scan failed for broken (+1): named failure');
});

for (const complete of [true, false]) {
  test(`a failed startup scan (initial marker ${complete}) retries only failed folders and clears its status`, async () => {
    const f = fixture({ complete });
    await f.cache.populateCacheViaWorker();
    assert.equal(f.statuses.at(-1).level, 'error');
    assert.deepEqual(f.written, ['broken', 'healthy']);
    await f.advance(29999);
    assert.equal(f.workers.length, 1);
    f.failing.clear();
    await f.advance(1);
    assert.equal(f.workers.length, 2, 'startup failure must retry without get-projects or another trigger');
    assert.deepEqual(Array.from(f.workers[1].folders), ['broken']);
    assert.deepEqual(f.written, ['broken', 'healthy', 'broken']);
    assert.equal(f.complete(), true);
    assert.equal(f.statuses.at(-1).level, 'done');
    await f.advance(5000);
    assert.equal(f.statuses.at(-1).message, '');
    await f.advance(1000000);
    assert.equal(f.workers.length, 2);
  });
}

test('persistent scan failure uses only three delayed retries and keeps the error visible', async () => {
  const f = fixture();
  await f.cache.populateCacheViaWorker();
  for (const [index, delay] of [30000, 120000, 600000].entries()) {
    await f.advance(delay - 1);
    assert.equal(f.workers.length, index + 1);
    await f.advance(1);
    assert.equal(f.workers.length, index + 2, 'each existing backoff tier must run once');
    assert.equal(f.statuses.at(-1).level, 'error');
  }
  await f.advance(10000000);
  await f.cache.populateCacheViaWorker();
  assert.equal(f.workers.length, 4);
  assert.equal(f.statuses.at(-1).level, 'error');
  assert.equal(f.statuses.some(status => status.message === '' || status.level === 'done'), false);
});

test('a failed scan names the project folder and reason', async () => {
  const f = fixture();
  await f.cache.populateCacheViaWorker();
  assert.equal(f.statuses.at(-1).message, 'Scan failed for broken: snapshot changed');
});

test('several failed folders name the first plus the remaining count', async () => {
  const f = fixture();
  f.failing.add('healthy');
  await f.cache.populateCacheViaWorker();
  assert.equal(f.statuses.at(-1).message, 'Scan failed for broken (+1): snapshot changed');
});

test('several different folder failures report the reason for the first named folder', async () => {
  const f = fixture();
  f.failing.add('healthy');
  f.reasons.set('broken', 'first failure');
  f.reasons.set('healthy', 'second failure');
  await f.cache.populateCacheViaWorker();
  assert.equal(f.statuses.at(-1).message, 'Scan failed for broken (+1): first failure');
});

test('a later successful forced scan clears the existing failure status', async () => {
  const f = fixture();
  await f.cache.populateCacheViaWorker();
  assert.equal(f.statuses.at(-1).level, 'error');
  f.failing.clear();
  await f.cache.populateCacheViaWorker({ force: true });
  assert.equal(f.statuses.at(-1).level, 'done');
  await f.advance(5000);
  assert.equal(f.statuses.at(-1).message, '');
  await f.advance(1000000);
  assert.equal(f.workers.length, 2, 'forced success cancels the pending retry');
});

test('shutdown cancels a pending scan retry', async () => {
  const f = fixture();
  await f.cache.populateCacheViaWorker();
  await f.cache.shutdownProducers();
  await f.advance(1000000);
  assert.equal(f.workers.length, 1);
  assert.equal(f.statuses.at(-1).level, 'error');
});
