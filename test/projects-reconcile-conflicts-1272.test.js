'use strict';

const test = require('node:test');
require('./fixtures/isolated-codex-home.cjs')(test);
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createProjectsWorkerClient } = require('../projects-worker-client');
const loadHandler = require('./get-projects-handler.cjs');

const flush = () => new Promise(resolve => setImmediate(resolve));
function clock() {
  let now = 100000;
  const timers = new Map();
  return {
    Date: { now: () => now }, timers,
    setTimeout(fn, ms) { const timer = { unref() {} }; timers.set(timer, { fn, at: now + ms }); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); await timer.fn(); }
      await flush();
    },
  };
}

function projects(t) {
  const time = clock(), notifications = [], logs = [], messages = [];
  let client, writing = true, revision = 0;
  const rows = [{ projectPath: '/consistent', sessions: [{ sessionId: 'old' }] }];
  const worker = new EventEmitter();
  worker.terminate = async () => {};
  worker.postMessage = message => {
    messages.push(message);
    const reconciled = !message.readOnly && !!message.reconcile;
    if (reconciled && writing) revision++;
    queueMicrotask(() => worker.emit('message', { id: message.id, result: {
      defaultProjects: structuredClone(rows), allProjects: structuredClone(rows),
      effects: reconciled ? [{ name: 'setCachedFileSize', args: [] }] : [], keptLiveRows: [], reconciled,
    } }));
  };
  const context = {
    ...time, TRACE: { on: false }, projectsReconciledAt: 0,
    isInitialScanComplete: () => true, isCachePopulated: () => true, isSearchIndexPopulated: () => true,
    getSetting: () => null, backfillEntrypoints() {}, backfillCustomTitles() {},
    writer: { applyAndPersistArchived: async list => list },
    mergePlaceholderSessions: list => list, annotateRemoteAttachable: list => list,
    notifyRendererProjectsChanged: cause => notifications.push(cause),
    log: { info: line => logs.push(line), warn: line => logs.push(line), error: line => logs.push(line) },
    createProjectsWorkerClient(options) {
      client = createProjectsWorkerClient({ ...options, workerFactory: () => worker,
        snapshot: () => ({ version: revision, liveVersion: 'stable' }), apply: async () => ({}) });
      return client;
    },
  };
  const handler = loadHandler(context);
  t.after(() => client.shutdown());
  return { time, handler, invoke: () => handler(null, 'both'), messages, notifications, logs, rows,
    writes: value => { writing = value; } };
}

test('a renderer reload is not failed by a reconcile that loses to a DB write on every dispatch (#1272)', async t => {
  const f = projects(t);
  const first = f.invoke();
  f.rows.push({ projectPath: '/new', sessions: [] });
  const second = f.invoke();
  for (const reply of await Promise.all([first, second])) {
    assert.equal(reply.projectsError, undefined, 'a reconcile the reload did not ask for must not fail it');
    assert.ok(reply.allProjects.some(project => project.projectPath === '/new'), 'the reload carries the current lists');
    assert.ok(reply.defaultProjects.some(project => project.projectPath === '/consistent'));
  }
  assert.equal(f.messages.filter(m => m.reconcile && !m.readOnly).length, 1, 'one reconcile attempt');
  assert.equal(f.handler.reconciledAt(), 0, 'a rejected reconcile does not count as accepted');
  assert.equal(f.time.timers.size, 1, 'the reconcile is retried apart');
});

test('a reconcile losing consecutive races backs off, logs once per streak and is accepted once writes pause (#1272)', async t => {
  const f = projects(t);
  await f.invoke();
  const reconciles = () => f.messages.filter(m => m.reconcile && !m.readOnly).length;
  const due = () => [...f.time.timers.values()][0].at - f.time.Date.now();
  const intervals = [];
  for (let i = 0; i < 5; i++) {
    intervals.push(due());
    const before = reconciles();
    await f.time.advance(due());
    assert.equal(reconciles() - before, 1, 'each retry runs one reconcile');
    const reload = await f.invoke();
    assert.equal(reload.projectsError, undefined, 'reloads keep resolving during the streak');
    assert.equal(reconciles() - before, 1, 'a reload during the backoff does not attempt the reconcile again');
  }
  assert.deepEqual(intervals, [5000, 10000, 20000, 30000, 30000], 'retry interval doubles up to thirty seconds');
  assert.equal(f.handler.reconciledAt(), 0);
  assert.deepEqual(f.notifications, [], 'a losing retry does not notify the renderer');
  assert.equal(f.logs.filter(line => line.includes('conflict')).length, 1, 'one conflict line per streak');
  assert.match(f.logs[0], /^\[projects\] reconcile conflict after 1 dispatches: reason=db/);

  f.writes(false);
  const acceptedAt = f.time.Date.now() + due();
  await f.time.advance(due());
  assert.equal(f.handler.reconciledAt(), acceptedAt, 'an accepted reconcile advances projectsReconciledAt');
  assert.deepEqual(f.notifications, ['reconcile']);
  assert.equal(f.time.timers.size, 0, 'acceptance ends the retries');
  assert.deepEqual(f.logs.slice(1), [`[projects] reconcile accepted after 6 conflicts over ${(acceptedAt - 100000) / 1000} s`]);

  const before = reconciles();
  await f.time.advance(5000);
  await f.invoke();
  assert.equal(reconciles() - before, 1, 'after acceptance the usual five-second interval applies again');
  assert.equal(f.logs.at(-1), '[projects] reconcile accepted');
});
