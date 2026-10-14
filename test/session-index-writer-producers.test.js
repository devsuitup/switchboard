'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

function fixture(writer) {
  let worker;
  class ScanWorker extends EventEmitter {
    constructor() { super(); worker = this; }
    terminate() { return Promise.resolve(); }
  }
  const filename = path.join(__dirname, '../session-cache.js');
  const localRequire = createRequire(filename);
  const context = {
    module: { exports: {} }, __dirname: path.dirname(filename), console, Buffer,
    require: name => name === 'worker_threads' ? { Worker: ScanWorker } : localRequire(name),
    setTimeout: () => 1, clearTimeout() {}, setImmediate,
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const cache = context.module.exports;
  cache.init({ PROJECTS_DIR: 'fixture', activeSessions: new Map(), getMainWindow: () => null,
    log: { warn() {}, info() {}, error() {} },
    db: { getSetting: () => null, isInitialScanComplete: () => false, setInitialScanComplete() {} }, writer });
  return { cache, worker: () => worker };
}

test('population drains folder acknowledgments before done and exit can complete the scan', async () => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const calls = [];
  const f = fixture({
    async writeScannedFolder() { calls.push('folder'); started(); await gate; calls.push('ack'); return 2; },
    async setInitialScanComplete() { calls.push('complete'); },
  });
  const populated = f.cache.populateCacheViaWorker();
  f.worker().emit('message', { type: 'folder', result: {}, current: 1, total: 1 });
  f.worker().emit('message', { type: 'done', ok: true });
  f.worker().emit('exit', 0);
  await entered;
  assert.deepEqual(calls, ['folder']);
  release();
  await populated;
  assert.deepEqual(calls, ['folder', 'ack', 'complete']);
});

test('a failed folder acknowledgment cannot be followed by a successful completeness marker', async () => {
  let completed = false;
  const f = fixture({
    async writeScannedFolder() { throw new Error('write failed'); },
    async setInitialScanComplete() { completed = true; },
  });
  const populated = f.cache.populateCacheViaWorker();
  f.worker().emit('message', { type: 'folder', result: {}, current: 1, total: 1 });
  f.worker().emit('message', { type: 'done', ok: true });
  f.worker().emit('exit', 0);
  await populated;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
});
