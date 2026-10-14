'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { createFileListsWorkerClient } = require('../file-lists-worker-client');

for (const [channel, kind] of [['get-memories', 'memory'], ['get-work-files', 'work-file']]) {
  function handler(on, request, events) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const start = source.indexOf(`ipcMain.handle('${channel}'`);
    const end = source.indexOf('\n});', start) + 4;
    let invoke;
    const fail = () => assert.fail('synchronous filesystem work on main');
    vm.runInNewContext(source.slice(start, end), {
      ipcMain: { handle: (_name, fn) => { invoke = fn; } },
      fs: new Proxy({}, { get: () => fail }),
      getKnownProjectPaths: fail, scanMdFiles: fail, deriveProjectPath: fail,
      getSetting: () => ({}), TRACE: { on }, performance,
      fileListsClient: { request }, trace: (...args) => events.push(args),
    }, { filename: path.join(__dirname, '..', 'main.js') });
    return invoke;
  }

  test(`${channel} relays without synchronous filesystem access and preserves its payload`, async () => {
    const payload = { projects: [] };
    let calls = 0;
    const invoke = handler(false, async options => {
      calls++;
      assert.equal(options.kind, kind);
      return { view: payload, entries: 7 };
    }, []);
    assert.equal(await invoke(), payload);
    assert.equal(calls, 1);
  });

  test(`${channel} traces duration and entries only when enabled`, async () => {
    const events = [];
    await handler(false, async () => ({ view: {}, entries: 7 }), events)();
    assert.equal(events.length, 0);
    await handler(true, async () => ({ view: {}, entries: 7 }), events)();
    assert.equal(events[0][0], `ipc.${channel}`);
    assert.equal(events[0][2].entries, 7);
    assert.ok(events[0][2].totalMs >= 0);
  });

  test(`${channel} rejects worker failure without a synchronous fallback`, async () => {
    await assert.rejects(handler(false, async () => { throw new Error('worker failed'); }, [])(), /worker failed/);
  });

  test(`${channel} returns both consecutive views and traces during a slow background index apply`, async t => {
    const worker = new EventEmitter();
    let job;
    worker.postMessage = message => { job = message; };
    worker.terminate = () => Promise.resolve();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let applied = false;
    const client = createFileListsWorkerClient({
      workerFactory: () => worker,
      snapshot: () => ({ version: 'v1' }),
      apply: async () => { await gate; applied = true; return true; },
    });
    t.after(() => client.shutdown());
    const events = [];
    let published;
    const payload = { projects: [] };
    const invokeHandler = handler(true, () => client.request(), events);
    const invoke = invokeHandler().then(view => { published = view; });
    worker.emit('message', { id: job.id, result: { view: payload, entries: 7 } });
    try {
      await nextTurn();
      assert.equal(published, payload);
      assert.equal(applied, false);
      assert.equal(events[0][2].entries, 7);
      const firstId = job.id;
      let secondView;
      const second = invokeHandler().then(view => { secondView = view; });
      second.catch(() => {});
      assert.notEqual(job.id, firstId, 'the second IPC must dispatch before indexing completes');
      const nextPayload = { projects: ['next'] };
      worker.emit('message', { id: job.id, result: { view: nextPayload, entries: 8 } });
      await nextTurn();
      assert.equal(secondView, nextPayload);
      assert.equal(events.length, 2);
      assert.equal(events[1][2].entries, 8);
      assert.equal(applied, false);
      await second;
    } finally { release(); }
    await invoke;
    await nextTurn();
    assert.equal(applied, true);
  });
}
