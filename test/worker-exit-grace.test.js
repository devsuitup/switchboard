'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSearchWorkerClient } = require('../search-worker-client');
const { createWriterWorkerClient } = require('../session-index-writer-client');
const { createProjectsWorkerClient } = require('../projects-worker-client');
const { createFileListsWorkerClient } = require('../file-lists-worker-client');

test('repeated search shutdown waits for the same worker exit confirmation', async () => {
  let release;
  const worker = new EventEmitter();
  worker.terminate = () => new Promise(resolve => { release = resolve; });
  const client = createSearchWorkerClient({ workerFactory: () => worker, searchByType: () => [], log: { error() {}, warn() {} } });
  client.startWorker();
  const first = client.shutdown();
  let confirmed = false;
  const second = client.shutdown().then(() => { confirmed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(confirmed, false, 'a second stop cannot report exit while termination is pending');
  release();
  await Promise.all([first, second]);
  assert.equal(confirmed, true);
});

for (const kind of ['writer', 'projects', 'files']) {
  test(`${kind} cannot confirm exit when worker termination rejects`, async () => {
    const worker = new EventEmitter();
    worker.postMessage = () => {};
    worker.terminate = () => Promise.reject(new Error('exit not confirmed'));
    const options = { workerFactory: () => worker, snapshot: () => ({ version: 'v1' }), getVersion: () => 'v1', apply() {} };
    let client;
    if (kind === 'writer') {
      client = createWriterWorkerClient(options);
      worker.emit('message', { ready: true, settings: [] });
      await client.ready;
    } else {
      client = kind === 'projects' ? createProjectsWorkerClient(options) : createFileListsWorkerClient(options);
      client.request().catch(() => {});
    }
    const stop = kind === 'writer' ? () => client.terminate() : () => client.shutdown();
    await assert.rejects(stop(), /exit not confirmed/);
    await assert.rejects(stop(), /exit not confirmed/, 'later callers must retain the failed confirmation');
  });
}
