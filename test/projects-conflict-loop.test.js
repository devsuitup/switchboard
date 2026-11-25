'use strict';

const test = require('node:test');
require('./fixtures/isolated-codex-home.cjs')(test);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
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
  let client, race = false, revision = 0;
  const rows = [{ projectPath: '/consistent', sessions: [{ sessionId: 'old' }] }];
  const worker = new EventEmitter();
  worker.terminate = async () => {};
  worker.postMessage = message => {
    messages.push(message);
    queueMicrotask(() => worker.emit('message', { id: message.id, result: {
      defaultProjects: rows, allProjects: rows, effects: message.readOnly ? [] : [{}], keptLiveRows: [],
      reconciled: !message.readOnly && !!message.reconcile,
    } }));
  };
  const context = {
    ...time, TRACE: { on: false }, projectsReconciledAt: 0,
    isInitialScanComplete: () => true, isCachePopulated: () => true, isSearchIndexPopulated: () => true,
    getSetting: () => null, backfillEntrypoints() {}, backfillCustomTitles() {},
    writer: { applyAndPersistArchived: async rows => rows },
    mergePlaceholderSessions: rows => rows, annotateRemoteAttachable: rows => rows,
    notifyRendererProjectsChanged: cause => notifications.push(cause),
    log: { info: line => logs.push(['info', line]), warn: line => logs.push(['warn', line]), error: line => logs.push(['error', line]) },
    createProjectsWorkerClient(options) {
      client = createProjectsWorkerClient({ ...options, workerFactory: () => worker,
        snapshot: () => ({ version: revision, liveVersion: 'stable' }),
        apply: async result => {
          if (race && result.effects.length) { revision++; throw Object.assign(new Error('cache snapshot changed before writer admission'), { code: 'WRITER_STALE' }); }
        },
      });
      return client;
    },
  };
  const invoke = loadHandler(context);
  t.after(() => client.shutdown());
  return { time, invoke: () => invoke(null, 'both'), messages, notifications, logs, rows, race: value => { race = value; } };
}

test('writer racing every snapshot has one build per request plus a read-only build for the lost reconcile, one reconcile per interval and no immediate re-notification', async t => {
  const f = projects(t);
  await f.invoke();
  await f.time.advance(5000);
  f.messages.length = 0;
  f.race(true);
  const replies = [];
  for (let i = 0; i < 10; i++) replies.push(await f.invoke());
  const counts = { rounds: 10, builds: f.messages.length, reconciles: f.messages.filter(m => m.reconcile).length,
    notifications: f.notifications.length, pending: f.time.timers.size };
  t.diagnostic(JSON.stringify(counts));
  assert.equal(counts.builds, 11, 'one build per request plus one read-only build for the lost reconcile');
  assert.equal(counts.reconciles, 1, 'failed reconcile attempts must respect the five-second admission interval');
  assert.equal(counts.notifications, 0, 'conflicts must not immediately re-notify the renderer');
  assert.equal(counts.pending, 1, 'one coalesced delayed refresh');
  assert.equal(replies[0].projectsError, undefined, 'the lost reconcile does not fail its reload');
  assert.ok(replies[0].allProjects.some(p => p.projectPath === '/consistent'));
  for (const reply of replies.slice(1)) {
    assert.equal(reply.projectsError?.code, 'PROJECTS_SNAPSHOT_CONFLICT');
    assert.equal(reply.allProjects, undefined);
  }
  for (const interval of [5000, 10000, 20000]) {
    const before = f.messages.length;
    await f.time.advance(interval - 1);
    assert.equal(f.messages.length, before, 'the retry respects its backoff');
    await f.time.advance(1);
    assert.equal(f.messages.length - before, 1, 'a persistent race costs one pass per retry interval');
    assert.equal(f.time.timers.size, 1);
    assert.equal(f.notifications.length, 0);
  }
  f.race(false);
  f.rows.push({ projectPath: '/new', sessions: [] });
  await f.time.advance(30000);
  assert.equal(f.time.timers.size, 0, 'successful retry drains the pending refresh');
  assert.deepEqual(f.notifications, ['reconcile']);
  const fresh = await f.invoke();
  assert.equal(fresh.projectsStale, undefined);
  assert.ok(fresh.allProjects.some(p => p.projectPath === '/new'), 'the lost snapshot is eventually refreshed without a source event');
  assert.equal(f.logs.filter(([level]) => level !== 'info').length, 0, 'expected races log at info');
});

test('a failed post-populate reconcile is throttled without forgetting the deferred reconcile', async t => {
  const time = clock(), requests = [];
  let finished = false;
  const invoke = loadHandler({ ...time, TRACE: { on: false }, projectsReconciledAt: 99999,
    isIndexingFinished: () => finished, isInitialScanComplete: () => true,
    isCachePopulated: () => true, isSearchIndexPopulated: () => true,
    getSetting: () => null, populateCacheViaWorker: async () => ({ ok: false }),
    backfillEntrypoints() {}, backfillCustomTitles() {},
    writer: { applyAndPersistArchived: async rows => rows },
    mergePlaceholderSessions: rows => rows, annotateRemoteAttachable: rows => rows,
    projectsClient: { request: async options => {
      requests.push(options);
      if (options.reconcile) throw Object.assign(new Error('race'), { code: 'PROJECTS_SNAPSHOT_CONFLICT' });
      return { defaultProjects: [], allProjects: [] };
    } },
  });
  await invoke(null, 'both');
  finished = true;
  for (let i = 0; i < 10; i++) await invoke(null, 'both');
  assert.equal(requests.filter(r => r.reconcile).length, 1, 'post-populate debt must not bypass the attempt throttle repeatedly');
  await time.advance(5000);
  assert.equal(requests.filter(r => r.reconcile).length, 2, 'deferred reconciliation survives its failed attempt');
  t.diagnostic('post-populate reconcile attempts: 1 immediately, 2 after the retry interval');
});

function watcherFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conflict-1194-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const time = clock(), published = new Map(), calls = [], logs = [], notifications = [];
  let changed, fail = true, failureCode = 'WRITER_STALE';
  for (const folder of ['one', 'two']) { fs.mkdirSync(path.join(root, folder)); fs.writeFileSync(path.join(root, folder, 'a.jsonl'), folder); }
  const filename = path.join(__dirname, '../main.js'), source = fs.readFileSync(filename, 'utf8');
  const context = { ...time, path, Set, Map, console, require: createRequire(filename), PROJECTS_DIR: root,
    projectsWatcher: null, flushProjectsBeforeExit: null, getSetting: () => ({}),
    fs: { ...fs, watch: (_root, _opts, callback) => { changed = callback; return { on() {}, close() {} }; } },
    detectSessionTransitions() {}, localTranscriptTracker: { record() {} }, coldScanInFlight: () => null,
    notifyRendererProjectsChanged: cause => notifications.push(cause),
    log: { info: (...args) => logs.push(['info', ...args]), error: (...args) => logs.push(['error', ...args]) },
    writer: { refreshFolder: async (folder, options) => {
      calls.push([folder, options?.files ? [...options.files].sort() : null]);
      if (fail && folder === 'one') throw Object.assign(new Error('cache snapshot changed before writer admission'), { code: failureCode });
      for (const file of options?.files || fs.readdirSync(path.join(root, folder))) published.set(folder + '/' + file, fs.readFileSync(path.join(root, folder, file), 'utf8'));
      return true;
    } },
  };
  const start = source.indexOf('function startProjectsWatcher()');
  const end = source.indexOf('// see .ai/contexts/session-cache.md ("Harness folders")', start);
  vm.runInNewContext(source.slice(start, end), context, { filename });
  context.startProjectsWatcher();
  return { root, time, published, calls, logs, notifications, context,
    event: (folder, file = 'a.jsonl') => changed('change', file === null ? folder : path.join(folder, file)),
    fail: value => { fail = value; }, error: code => { failureCode = code; } };
}

test('watcher retains raced refreshes and untouched tail folders, merging new targeted and full-folder events', async t => {
  const f = watcherFixture(t);
  f.event('one'); f.event('two');
  await f.time.advance(500);
  assert.equal(f.published.has('one/a.jsonl'), false);
  assert.equal(f.time.timers.size, 1, 'a drained refresh that lost admission must be queued again without another filesystem event');
  assert.equal(f.logs.filter(([level]) => level === 'error').length, 0, 'WRITER_STALE is expected contention');
  fs.writeFileSync(path.join(f.root, 'one', 'b.jsonl'), 'new');
  f.event('one', 'b.jsonl'); f.event('one', null);
  f.fail(false);
  await f.time.advance(5000);
  assert.equal(f.published.get('one/a.jsonl'), 'one');
  assert.equal(f.published.get('one/b.jsonl'), 'new');
  assert.equal(f.published.get('two/a.jsonl'), 'two', 'a failure must not drop later folders in the drained batch');
  assert.equal(f.calls.filter(([folder]) => folder === 'one').at(-1)[1], null, 'full-folder scope dominates targeted retries');
  assert.equal(f.time.timers.size, 0);
});

test('watcher logs a real failure as an error', async t => {
  const f = watcherFixture(t); f.error('EIO'); f.event('one');
  await f.time.advance(500);
  assert.equal(f.logs.filter(([level]) => level === 'error').length, 1);
});

test('watcher retries without any new event and does not postpone the retry for a busy folder', async t => {
  const f = watcherFixture(t);
  f.event('one'); f.event('two');
  await f.time.advance(500);
  f.fail(false);
  await f.time.advance(5000);
  assert.equal(f.published.get('one/a.jsonl'), 'one', 'raced source bytes must eventually publish without another source event');
  assert.equal(f.published.get('two/a.jsonl'), 'two');
  f.fail(true); f.event('one');
  await f.time.advance(500);
  const due = [...f.time.timers.values()][0].at;
  await f.time.advance(4900);
  f.event('one', 'a.jsonl');
  assert.equal([...f.time.timers.values()][0].at, due, 'streaming events must not postpone the bounded retry');
});

test('watcher backs off per failed folder while healthy folders retain the 500ms debounce', async t => {
  const f = watcherFixture(t); f.error('EIO'); f.event('one');
  await f.time.advance(500);
  f.event('two'); await f.time.advance(500);
  assert.equal(f.published.get('two/a.jsonl'), 'two', 'healthy folders must not wait for the failed folder retry');
  await f.time.advance(4500);
  assert.equal(f.calls.filter(([folder]) => folder === 'one').length, 2);
  await f.time.advance(5000);
  assert.equal(f.calls.filter(([folder]) => folder === 'one').length, 2, 'second failure backs off to 30 seconds');
  await f.time.advance(25000);
  assert.equal(f.calls.filter(([folder]) => folder === 'one').length, 3);
  await f.time.advance(120000);
  assert.equal(f.calls.filter(([folder]) => folder === 'one').length, 4);
  await f.time.advance(120000);
  assert.equal(f.calls.filter(([folder]) => folder === 'one').length, 5);
  assert.equal(f.logs.filter(([level]) => level === 'error').length, 3, 'log the first failure and backoff steps, not every capped retry');
  f.fail(false); await f.time.advance(120000);
  assert.equal(f.published.get('one/a.jsonl'), 'one');
  assert.equal(f.time.timers.size, 0);
});

for (const code of ['PROJECTS_WORKER_TIMEOUT', 'PROJECTS_WORKER_EXIT']) test(`rejected retry backs off, caps logging and resets on success: ${code}`, async () => {
  const time = clock(), errors = [], notifications = [];
  let phase = 'conflict';
  const invoke = loadHandler({ ...time, TRACE: { on: false }, projectsReconciledAt: 0,
    isInitialScanComplete: () => true, isCachePopulated: () => true, isSearchIndexPopulated: () => true,
    getSetting: () => null, backfillEntrypoints() {}, backfillCustomTitles() {},
    console: { error: (...args) => errors.push(args) }, log: { info() {}, warn: (...args) => errors.push(args), error: (...args) => errors.push(args) },
    writer: { applyAndPersistArchived: async rows => rows }, mergePlaceholderSessions: rows => rows, annotateRemoteAttachable: rows => rows,
    notifyRendererProjectsChanged: cause => notifications.push(cause),
    projectsClient: { request: async options => {
      if (phase !== 'fresh') throw Object.assign(new Error(phase), { code: phase === 'conflict' ? 'PROJECTS_SNAPSHOT_CONFLICT' : code });
      if (options.reconcile) invoke.accepted({ reconciled: true });
      return { defaultProjects: [], allProjects: [], reconciled: !!options.reconcile };
    } },
  });
  await invoke(null, 'both'); phase = 'failure'; errors.length = 0;
  await time.advance(5000);
  assert.equal(time.timers.size, 1, 'a rejected delayed retry must re-arm without a filesystem event');
  assert.equal(errors.length, 1, 'a failed delayed retry is logged only once');
  assert.deepEqual(notifications, []);
  const remaining = () => [...time.timers.values()][0].at - time.Date.now();
  assert.equal(remaining(), 5000, 'first non-conflict failure retries after 5 seconds');
  await time.advance(5000);
  assert.equal(remaining(), 30000, 'second non-conflict failure backs off to 30 seconds');
  assert.equal(errors.length, 2);
  await time.advance(30000);
  assert.equal(remaining(), 120000, 'third non-conflict failure backs off to two minutes');
  assert.equal(errors.length, 3);
  await time.advance(120000);
  assert.equal(remaining(), 120000, 'permanent failure stays capped at two minutes');
  assert.equal(errors.length, 3, 'capped retries must not repeat the error log');
  assert.equal(time.timers.size, 1);
  assert.deepEqual(notifications, []);
  phase = 'fresh'; await time.advance(120000);
  assert.equal(time.timers.size, 0); assert.deepEqual(notifications, ['reconcile']);
  phase = 'conflict'; await invoke(null, 'both');
  assert.equal(remaining(), 5000, 'success resets the retry delay');
  phase = 'failure'; await time.advance(5000);
  assert.equal(remaining(), 5000, 'success resets the failure count');
  assert.equal(errors.length, 4, 'success resets the per-step log suppression');
  phase = 'fresh'; await invoke(null, 'both');
  phase = 'failure'; await time.advance(5000);
  assert.equal(remaining(), 5000, 'a successful foreground load also resets retry backoff');
  assert.equal(errors.length, 5);
});
