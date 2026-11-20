'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const openStore = require('./fixtures/conversation-store.cjs');
const { createWriterWorkerClient } = require('../session-index-writer-client');

const supported = { skip: !openStore.supported && 'native SQLite ABI differs; node:sqlite requires Node 22' };
const fixture = path.join(__dirname, 'fixtures', 'writer-slow-units.cjs');
const sha = char => char.repeat(64);

function slowWriter(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-wall-time-'));
  const previous = process.env.SWITCHBOARD_DATA_DIR;
  process.env.SWITCHBOARD_DATA_DIR = dir;
  const client = createWriterWorkerClient({ workerFactory: () => new Worker(fixture), log: { info() {}, warn() {} } });
  t.after(async () => {
    await client.close();
    if (previous === undefined) delete process.env.SWITCHBOARD_DATA_DIR;
    else process.env.SWITCHBOARD_DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return client;
}
const slowRows = () => Array.from({ length: 32 }, (_, i) => ({ sessionId: 'slow-' + i, folder: 'fixture', projectPath: '/fixture', modified: 1 }));
const query = client => client.request('querySessionRequestOutcome', { stemKey: 'abc', suppliedHash: sha('a') });

test('a background chunk stops admitting units once 10 ms of wall time have been spent', supported, async t => {
  const client = slowWriter(t);
  await client.ready;
  const before = (await client.request('measurements')).length;
  await client.request('upsertCachedSessions', slowRows());
  const after = (await client.request('measurements')).length;
  assert.equal(after - before, 32, 'every 15 ms unit occupies its own transaction');
});

test('a journal query posted behind 32 slow units is answered in under 200 ms', supported, async t => {
  const client = slowWriter(t);
  await client.ready;
  const upsert = client.request('upsertCachedSessions', slowRows());
  const started = performance.now();
  await query(client);
  const waited = performance.now() - started;
  await upsert;
  assert.ok(waited < 200, `journal query waited ${Math.round(waited)} ms, expected < 200`);
});

test('a journal command is served before queued interactive commands and the burst rule', supported, async t => {
  const client = slowWriter(t);
  await client.ready;
  const order = [];
  const upsert = client.request('upsertCachedSessions', slowRows());
  const settings = Array.from({ length: 5 }, (_, i) => client.request('setSetting', 'burst-' + i, i).then(() => order.push('setSetting-' + i)));
  const journal = query(client).then(() => order.push('query'));
  await Promise.all([upsert, ...settings, journal]);
  assert.equal(order[0], 'query', 'resolution order: ' + order.join(', '));
});
