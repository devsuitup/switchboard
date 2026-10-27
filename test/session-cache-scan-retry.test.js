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
  const timers = new Map(), workers = [], statuses = [], written = [];
  const failing = new Set(['broken']);
  const reasons = new Map();
  class ScanWorker extends EventEmitter {
    constructor(_filename, { workerData }) {
      super();
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
    log: { error() {}, warn() {}, info() {} },
    db: { getSetting: () => null, isInitialScanComplete: () => complete, setInitialScanComplete() {} },
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
  return { cache, failing, reasons, workers, statuses, written, advance, complete: () => complete };
}

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
