'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { AsyncResource } = require('node:async_hooks');
const { EventEmitter } = require('node:events');
const { Worker } = require('node:worker_threads');
const { createSessionIndexWriter } = require('../../session-index-writer');

async function run() {
  const mode = process.argv[2];
  let worker, started, terminationRequested = false;
  const nativeStarted = new Promise(resolve => { started = resolve; });
  const writer = createSessionIndexWriter({ workerFactory: () => {
    worker = new Worker(path.join(__dirname, 'shutdown-native.cjs'));
    const terminate = worker.terminate.bind(worker);
    worker.terminate = () => { terminationRequested = true; return terminate(); };
    worker.on('message', message => { if (message.nativeStarted) started(); });
    return worker;
  } });
  await writer.ready;
  const db = require('../../db');
  assert.equal(db.connection.readonly, true);
  assert.equal(db.connection.inTransaction, false);
  await writer.setSetting('committed', 'kept');
  if (mode === 'native') {
    worker.postMessage({ nativeBlock: true });
    await nativeStarted;
  }
  const external = new AsyncResource('shutdown-producer');
  const accepted = Array.from({ length: 64 }, (_, i) => writer.patchGlobal({ ['stream:' + i]: i }));
  accepted.forEach(job => job.catch(() => {}));
  let producer;
  let rejectObserved, streamStarted;
  const rejected = new Promise(resolve => { rejectObserved = resolve; });
  const streaming = new Promise(resolve => { streamStarted = resolve; });
  if (mode === 'stream') {
    let tick = 0;
    producer = setInterval(() => {
      const job = writer.patchGlobal({ streamTick: ++tick });
      accepted.push(job);
      job.then(() => { if (tick >= 16) streamStarted(); }, error => {
        clearInterval(producer);
        assert.match(error.message, /clos|shut/i);
        rejectObserved();
      });
    }, 1);
    await streaming;
  }
  const app = new EventEmitter();
  let exits = 0;
  app.exit = () => {
    console.log('app.exit reached');
    assert.equal(++exits, 1);
    assert.ok(terminationRequested, 'request writer termination even after a drain timeout');
    assert.ok(readersStopped >= 3, 'stop all reader workers even after a drain timeout');
    if (mode !== 'native') assert.equal(worker.threadId, -1, 'responsive writer terminated before app.exit');
    process.exit(0);
  };
  let readersStopped = 0;
  const reader = { shutdown: async () => { readersStopped++; } };
  const context = vm.createContext({
    require: name => name === './shutdown-exit' ? require('../../shutdown-exit') : require(name),
    console, process, Promise, setTimeout, clearTimeout, app, writer,
    log: { error: (...args) => console.log(...args), warn: (...args) => console.log(...args) },
    appQuitting: false, TRACE: { on: false }, trace() {},
    stopScheduler() {}, mainLoopMonitor: { stop() {} }, shutdownAllMcp() {},
    localTranscriptTracker: { dispose() {} }, unsubscribeTaskJobs() {}, taskRecords: { dispose() {} },
    projectsWatcher: null, cliSessionState: { stop() {} }, bgAgents: { stop() {} },
    remoteIndexer: { dispose() {} }, remoteWatcher: { stopAll() {} }, remoteActivityTracker: { dispose() {} },
    activityTrace: { close() {} }, activeSessions: new Map(), closedSessions: new Map(), killPty() {},
    flushProjectsBeforeExit: async () => {
      if (mode !== 'stream') return new Promise(() => {});
      await assert.rejects(external.runInAsyncScope(() => writer.setSetting('late', true)), /clos|shut/i);
      await rejected;
      await Promise.allSettled(accepted);
    },
    flushWindowBounds: () => writer.patchGlobal({ finalBounds: true }),
    sessionCache: { shutdownProducers: async () => {} },
    sessionTransitions: { drainMetadataWrites: async () => {} },
    activityReporter: { stop() {}, flush: async () => {}, hasPendingWork: false }, activityFlushedForQuit: false,
    projectsClient: reader, fileListsClient: reader, searchClient: reader,
    closeDb: () => writer.closeDb(), holdBootstrapQuit() {}, updateInstalling: false,
    mainWindow: null, unsavedGuard: { beforeQuit: () => false },
  });
  const source = fs.readFileSync(path.join(__dirname, '../../main.js'), 'utf8');
  const start = source.indexOf('let shutdownPromise;');
  const end = source.indexOf('\n});', source.indexOf("app.on('before-quit', event =>", start)) + 4;
  vm.runInContext(source.slice(start, end), context);
  app.emit('before-quit', { preventDefault() {} });
  app.emit('before-quit', { preventDefault() {} });
  if (mode === 'stream') {
    await context.shutdownForExit();
    assert.ok(readersStopped >= 3);
  }
}

run().catch(error => { console.error(error); process.exit(2); });
