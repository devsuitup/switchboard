'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { setImmediate: yieldTurn } = require('node:timers/promises');
const { createWriterWorkerClient } = require('../session-index-writer-client');
const { createSessionIndexWriter } = require('../session-index-writer');

function writerHarness() {
  const filename = require.resolve('../workers/session-index-writer');
  const nativeRequire = createRequire(filename);
  const port = new EventEmitter(), timers = [], messages = [], waiters = new Map();
  const data = new Map(), pauses = [];
  let nextId = 0, changes = 0, remaining = 0, attempts = 0, failure;
  const store = {
    getSetting: key => data.get(key),
    listSettingKeys: prefix => [...data.keys()].filter(key => key.startsWith(prefix)),
    setSetting(key, value) { data.set(key, value); changes++; },
    deleteSetting(key) { data.delete(key); changes++; },
    changeCount: () => changes,
    nextChunkSize: () => 32,
    chunkUnit: fn => ({ result: fn() }),
    transact(fn) { attempts++; if (remaining-- > 0) throw failure; return fn(); },
    closeDb() {},
  };
  port.postMessage = message => {
    messages.push(message);
    if (message.id && !message.started) waiters.get(message.id)?.(message);
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require(name) {
      if (name === 'node:worker_threads') return { parentPort: port };
      if (name === '../session-index-store') return { openSessionIndexStore: () => store };
      if (name === 'node:timers/promises') return { setImmediate: yieldTurn, setTimeout: async ms => { pauses.push(ms); } };
      return nativeRequire(name);
    },
    setInterval(tick, ms) {
      const timer = { tick, ms, unrefed: false, stopped: false, unref() { this.unrefed = true; } };
      timers.push(timer);
      return timer;
    },
    clearInterval(timer) { timer.stopped = true; },
  }, { filename });
  return {
    data, pauses, timers,
    get attempts() { return attempts; },
    fail(count, code = 'SQLITE_BUSY') { remaining = count; failure = Object.assign(new Error('injected lock'), { code }); },
    request(command, ...args) {
      return new Promise(resolve => {
        const id = ++nextId;
        waiters.set(id, resolve);
        port.emit('message', { id, command, args });
      });
    },
    flush() { timers.find(timer => timer.ms === 60000)?.tick(); },
    counts: () => JSON.parse(JSON.stringify(messages.filter(message => message.busyCounts).map(message => message.busyCounts))),
  };
}

test('two BUSY retries commit and publish per-command counts once per minute, then reset', async () => {
  const writer = writerHarness();
  writer.fail(2);
  const reply = await writer.request('setSetting', 'saved', 42);
  assert.equal(reply.error, undefined);
  assert.equal(writer.data.get('saved'), 42);
  assert.deepEqual(writer.pauses, [20, 50]);
  assert.deepEqual(writer.counts(), [], 'no early publication');
  writer.flush();
  assert.deepEqual(writer.counts(), [{ setSetting: { retries: 2, exhaustions: 0 } }]);
  writer.flush();
  assert.equal(writer.counts().length, 1, 'reset makes the next idle minute silent');
});

test('five injected BUSY throws still reject on the fourth attempt with one exhaustion', async () => {
  const writer = writerHarness();
  writer.fail(5, 'SQLITE_BUSY_SNAPSHOT');
  const reply = await writer.request('setSetting', 'lost', 42);
  assert.equal(reply.error.code, 'SQLITE_BUSY_SNAPSHOT');
  assert.equal(writer.data.has('lost'), false);
  assert.equal(writer.attempts, 4);
  assert.deepEqual(writer.pauses, [20, 50, 100]);
  writer.fail(1);
  await writer.request('deleteSetting', 'missing');
  writer.flush();
  assert.deepEqual(writer.counts(), [{ setSetting: { retries: 3, exhaustions: 1 }, deleteSetting: { retries: 1, exhaustions: 0 } }]);
});

test('idle and non-BUSY commands emit no counts; the minute timer is unrefed and stopped on close', async () => {
  const writer = writerHarness();
  await writer.request('setSetting', 'ok', true);
  writer.fail(5, 'SQLITE_LOCKED');
  const reply = await writer.request('deleteSetting', 'ok');
  assert.equal(reply.error.code, 'SQLITE_LOCKED');
  writer.flush();
  assert.deepEqual(writer.counts(), []);
  const timer = writer.timers.find(timer => timer.ms === 60000);
  assert.ok(timer, 'minute timer exists');
  assert.equal(timer.unrefed, true);
  await writer.request('close');
  assert.equal(timer.stopped, true);
});

test('writer count messages produce one info line without settling an active command', async t => {
  const worker = new EventEmitter(), lines = [];
  worker.terminate = async () => {};
  worker.postMessage = () => {};
  const client = createWriterWorkerClient({ workerFactory: () => worker, log: { info: line => lines.push(line) } });
  t.after(() => client.terminate());
  worker.emit('message', { ready: true, settings: [] });
  await client.ready;
  let settled = false;
  const pending = client.request('setSetting', 'key', true).then(() => { settled = true; });
  pending.catch(() => {});
  worker.emit('message', { busyCounts: { setSetting: { retries: 2, exhaustions: 0 } } });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /SQLITE_BUSY/);
  assert.deepEqual(JSON.parse(lines[0].slice(lines[0].indexOf('{'))), { setSetting: { retries: 2, exhaustions: 0 } });
  await yieldTurn();
  assert.equal(settled, false);
  worker.emit('message', { id: 1, result: true });
  await pending;
});

test('the writer facade routes BUSY counts through the application logger', async t => {
  const worker = new EventEmitter(), lines = [];
  worker.terminate = async () => {};
  const writer = createSessionIndexWriter({
    workerFactory: () => worker,
    readonlyBackend: { applySettingsAcknowledgment() {} },
    log: { info: line => lines.push(line) },
  }, {});
  t.after(() => writer.terminate());
  worker.emit('message', { ready: true, settings: [] });
  await writer.ready;
  worker.emit('message', { busyCounts: { effects: { retries: 3, exhaustions: 1 } } });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /effects/);
});

function readonlyHarness() {
  const filename = require.resolve('../db');
  const warnings = [], module = { exports: {} };
  let failure, calls = 0;
  const store = {
    listSettingKeys: () => ['global'],
    getSetting() { if (failure) throw failure; return { mirrored: true }; },
    getCachedSession() { calls++; if (failure) throw failure; return { sessionId: 'saved' }; },
    DB_PATH: 'fixture.db',
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require(name) {
      if (name === './session-index-store') return { openSessionIndexStore: () => store };
      if (name === 'electron-log') return { warn: line => warnings.push(line) };
      throw new Error('unexpected require: ' + name);
    }, module, structuredClone,
  }, { filename });
  return { db: module.exports, warnings, fail(error) { failure = error; }, calls: () => calls };
}

test('readonly BUSY and extended BUSY warn with the calling function and rethrow the same error', () => {
  const { db, warnings, fail, calls } = readonlyHarness();
  for (const code of ['SQLITE_BUSY', 'SQLITE_BUSY_RECOVERY']) {
    const error = Object.assign(new Error('injected readonly lock'), { code });
    fail(error);
    assert.throws(() => db.getCachedSession('saved'), thrown => thrown === error);
    assert.equal(warnings.length, code === 'SQLITE_BUSY' ? 1 : 2);
    assert.match(warnings.at(-1), /getCachedSession/);
    assert.ok(warnings.at(-1).includes(code));
  }
  assert.equal(calls(), 2, 'no readonly retry');
  assert.equal(db.getSetting('global').mirrored, true, 'settings mirror stays in memory');
  assert.equal(warnings.length, 2);
  const error = Object.assign(new Error('fresh read locked'), { code: 'SQLITE_BUSY' });
  fail(error);
  assert.throws(() => db.getSetting('global', { fresh: true }), thrown => thrown === error);
  assert.match(warnings.at(-1), /getSetting/);
});

test('readonly successful reads and other errors stay silent and preserve results and errors', () => {
  const { db, warnings, fail } = readonlyHarness();
  assert.equal(db.getCachedSession('saved').sessionId, 'saved');
  assert.equal(db.DB_PATH, 'fixture.db');
  for (const error of [Object.assign(new Error('locked'), { code: 'SQLITE_LOCKED' }), null]) {
    fail(error);
    if (error) assert.throws(() => db.getCachedSession('saved'), thrown => thrown === error);
  }
  assert.deepEqual(warnings, []);
});
