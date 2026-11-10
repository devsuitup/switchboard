'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { createWriterCommands } = require('../session-index-commands');
const { createSessionIndexWriter } = require('../session-index-writer');

test('all journal producers reject transport failure without reconstructing or retrying their candidate', async () => {
  const commands = createWriterCommands({}), calls = [];
  const writer = createSessionIndexWriter({ readonlyBackend: {}, client: { ready: Promise.resolve(),
    request: async name => { calls.push(name); throw Object.assign(new Error('unknown commit outcome'), { code: 'WRITER_TIMEOUT' }); } } }, {});
  await writer.ready;
  for (const name of ['querySessionRequestOutcome', 'recordConsumedSessionStatusRequest', 'recordSessionRequestConflict',
    'claimSessionResultNamespace', 'recordSessionResultPublication']) {
    assert.equal(typeof commands[name], 'function', `${name} is registered in the production command registry`);
    assert.equal(typeof writer[name], 'function', `${name} is forwarded by the production facade`);
    await assert.rejects(writer[name]({ stemKey: 'a' }), { code: 'WRITER_TIMEOUT' });
    assert.equal(calls.filter(value => value === name).length, 1, 'unknown outcomes require an explicit ordered query');
  }
});

function fixture(writer) {
  let worker;
  const errors = [], sent = [];
  let terminated = false;
  class ScanWorker extends EventEmitter {
    constructor() { super(); worker = this; }
    terminate() { terminated = true; return Promise.resolve(); }
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
  cache.init({ PROJECTS_DIR: 'fixture', activeSessions: new Map(), getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (...args) => sent.push(args) } }),
    log: { warn() {}, info() {}, error: (...args) => errors.push(args.join(' ')) },
    db: { getSetting: () => null, isInitialScanComplete: () => false, setInitialScanComplete() {} }, writer });
  return { cache, worker: () => worker, errors, sent, terminated: () => terminated };
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

test('a failed folder write prevents scan completeness while later folders still persist', async () => {
  let completed = false;
  const processed = [];
  const f = fixture({
    async writeScannedFolder(result) {
      processed.push(result.folder);
      if (result.folder === 'broken') throw new Error('write failed');
      return 2;
    },
    async setInitialScanComplete() { completed = true; },
  });
  const populated = f.cache.populateCacheViaWorker();
  f.worker().emit('message', { type: 'folder', result: { folder: 'broken' }, current: 1, total: 2 });
  f.worker().emit('message', { type: 'folder', result: { folder: 'healthy' }, current: 2, total: 2 });
  f.worker().emit('message', { type: 'done', ok: true });
  f.worker().emit('exit', 0);
  await populated;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  assert.deepEqual(processed, ['broken', 'healthy']);
  assert.equal(f.terminated(), false);
  assert.ok(f.errors.some(error => error.includes('write failed')));
  assert.equal(f.sent.some(([channel, status]) => channel === 'status-update' && String(status).includes('Scan failed')), true);
});
