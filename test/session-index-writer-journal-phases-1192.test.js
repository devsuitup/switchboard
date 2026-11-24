'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Worker } = require('node:worker_threads');
const openStore = require('./fixtures/conversation-store.cjs');
const { createWriterWorkerClient } = require('../session-index-writer-client');

const supported = { skip: !openStore.supported && 'native SQLite ABI differs; node:sqlite requires Node 22' };

function fakeClient() {
  const f = { time: 1000, warnings: [], posted: [] };
  f.worker = Object.assign(new EventEmitter(), {
    postMessage: message => f.posted.push(message),
    terminate: async () => {},
  });
  f.client = createWriterWorkerClient({ workerFactory: () => f.worker, clock: () => f.time,
    setTimeout: () => ({}), clearTimeout() {}, log: { info() {}, warn: line => f.warnings.push(line) } });
  f.ready = () => f.worker.emit('message', { ready: true, settings: [] });
  f.answer = (message, extra = {}) => {
    f.worker.emit('message', { id: message.id, started: true });
    f.worker.emit('message', { id: message.id, result: true, ...extra });
  };
  return f;
}

test('a slow journal command splits its wait into main queue, transit, worker queue, worker run and ACK delivery', async () => {
  const f = fakeClient();
  const pending = f.client.request('recordSessionResultPublication', { stemKey: 'abc' });
  f.time = 1300;
  f.ready();
  assert.equal(f.posted.length, 1);
  f.time = 109400;
  f.answer(f.posted[0], { timing: { receivedAt: 1310, startedAt: 1360, finishedAt: 1400 } });
  await pending;
  assert.deepEqual(f.warnings, ['[session-index-writer] journal command recordSessionResultPublication waited 108400 ms'
    + ' (main queue 300 ms, to worker 10 ms, worker queue 50 ms, worker run 40 ms, ack 108000 ms)']);
});

test('a fast journal command and a slow non-journal command log nothing', async () => {
  const f = fakeClient();
  f.ready();
  const fast = f.client.request('querySessionRequestOutcome', { stemKey: 'abc' });
  f.time += 150;
  f.answer(f.posted[0], { timing: { receivedAt: 1001, startedAt: 1002, finishedAt: 1003 } });
  await fast;
  const slow = f.client.request('setSetting', 'key', 1);
  f.time += 5000;
  f.answer(f.posted[1]);
  await slow;
  assert.deepEqual(f.warnings, []);
});

test('a slow journal command whose answer carries no worker timing reports the missing phases as n/a', async () => {
  const f = fakeClient();
  f.ready();
  const pending = f.client.request('claimSessionResultNamespace', { stemKey: 'abc' });
  f.time += 450;
  f.answer(f.posted[0]);
  await pending;
  assert.deepEqual(f.warnings, ['[session-index-writer] journal command claimSessionResultNamespace waited 450 ms'
    + ' (main queue 0 ms, to worker n/a ms, worker queue n/a ms, worker run n/a ms, ack n/a ms)']);
});

test('a slow journal command that fails still logs its wait', async () => {
  const f = fakeClient();
  f.ready();
  const pending = f.client.request('recordSessionRequestConflict', { stemKey: 'abc' });
  f.time += 900;
  f.worker.emit('message', { id: f.posted[0].id, error: { message: 'refused' }, timing: { receivedAt: 1000, startedAt: 1000, finishedAt: 1100 } });
  await assert.rejects(pending, /refused/);
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /journal command recordSessionRequestConflict waited 900 ms \(main queue 0 ms, to worker 0 ms, worker queue 0 ms, worker run 100 ms, ack 800 ms\)$/);
});

test('the writer worker stamps receive, start and finish on journal answers only', supported, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-journal-phases-'));
  const previous = process.env.SWITCHBOARD_DATA_DIR;
  process.env.SWITCHBOARD_DATA_DIR = dir;
  const answers = [];
  const client = createWriterWorkerClient({ log: { info() {}, warn() {} }, workerFactory: () => {
    const worker = new Worker(path.join(__dirname, 'fixtures', 'writer-slow-units.cjs'));
    worker.on('message', message => { if (message.id && !message.started) answers.push(message); });
    return worker;
  } });
  t.after(async () => {
    await client.close();
    if (previous === undefined) delete process.env.SWITCHBOARD_DATA_DIR;
    else process.env.SWITCHBOARD_DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await client.ready;
  await client.request('setSetting', 'plain', 1);
  await client.request('querySessionRequestOutcome', { stemKey: 'abc', suppliedHash: 'a'.repeat(64) });
  assert.equal(answers[0].timing, undefined, 'a non-journal answer carries no timing');
  const { receivedAt, startedAt, finishedAt } = answers[1].timing;
  for (const value of [receivedAt, startedAt, finishedAt]) assert.equal(typeof value, 'number');
  assert.ok(receivedAt <= startedAt && startedAt <= finishedAt, JSON.stringify(answers[1].timing));
});
