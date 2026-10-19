'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const cache = require('../session-cache');
const { memoryWriter } = require('./fixtures/writer-memory.cjs');
const { fixture, OLD, HEAD, OTHER } = require('./fixtures/continuation-718.cjs');
const { barrier, tick } = require('./fixtures/continuation-718.cjs');
const { projectsWorker } = require('./fixtures/projects-worker-718.cjs');
const { createSessionIndexWriter } = require('../session-index-writer');
const { createProjectsWorkerClient } = require('../projects-worker-client');
const { EventEmitter } = require('node:events');

for (const release of [false, true]) test('D1 writer prepares linked source outside recorder, release=' + release, { timeout: 9000 }, async t => {
  const h = fixture(t); h.write(OLD, h.padding + h.link()); h.write(OTHER); cache.refreshFolder(h.folder); h.init();
  h.append(OLD, h.padding); h.append(OTHER);
  const writer = memoryWriter(h.db, cache); await writer.ready;
  writer.initializeCache({ PROJECTS_DIR: h.root, activeSessions: h.activeSessions, getMainWindow: () => null, log: h.log,
    getLocalDescriptors: () => h.descriptors });
  if (release) {
    h.activeSessions.set(OLD, { projectFolder: h.folder });
    require('node:fs').renameSync(h.file(OLD), h.file(OLD) + '.saved');
    await writer.refreshFolder(h.folder);
    require('node:fs').renameSync(h.file(OLD) + '.saved', h.file(OLD)); h.activeSessions.delete(OLD);
    await writer.releaseLiveSession(OLD);
  } else await writer.refreshFolder(h.folder, { files: new Set([OTHER + '.jsonl', OLD + '.jsonl']) });
  assert.deepEqual(JSON.parse(h.rows.get(OLD).continuationIndex).ids, [HEAD]);
  assert.equal(JSON.parse(h.rows.get(OLD).continuationIndex).bytes, require('node:fs').statSync(h.file(OLD)).size);
});

test('D1 deferred scope survives held/rejected effects ACK and stale recomputation', { timeout: 9000 }, async t => {
  const h = fixture(t); h.write(OLD, h.padding + h.link()); h.write(OTHER); cache.refreshFolder(h.folder); h.init();
  h.append(OLD, h.padding); h.append(OTHER);
  cache.refreshFolder(h.folder, { files: new Set([OTHER + '.jsonl', OLD + '.jsonl']) });
  const ack = barrier(), entered = barrier(); let attempts = 0, hold = false;
  const client = { ready: Promise.resolve(), async request(name, effects) {
    assert.equal(name, 'effects');
    if (hold && ++attempts === 1) { entered.resolve(); await ack.promise; h.append(OLD, h.padding); throw Object.assign(Error('stale'), { code: 'WRITER_STALE' }); }
    if (hold) assert.ok(effects.some(e => e.name === 'upsertCachedSessions' && e.args[0].some(row => row.sessionId === OLD)), 'recomputed request still includes deferred source');
    for (const effect of effects) h.db[effect.name](...effect.args);
  } };
  const writer = createSessionIndexWriter({ client, readonlyBackend: h.db }, cache); await writer.ready;
  h.append(OLD, h.padding); h.append(OTHER);
  cache.refreshFolder(h.folder, { files: new Set([OTHER + '.jsonl', OLD + '.jsonl']) });
  writer.initializeCache({ PROJECTS_DIR: h.root, activeSessions: h.activeSessions, getMainWindow: () => null, log: h.log });
  const preparation = t.mock.method(cache, 'prepareContinuationRefresh', async () => new Map());
  await writer.refreshFolder(h.folder, { files: new Set([OTHER + '.jsonl', OLD + '.jsonl']) });
  preparation.mock.restore(); hold = true;
  const pending = writer.refreshFolder(h.folder, { files: new Set([OTHER + '.jsonl']) });
  await entered.promise;
  assert.ok(cache.continuationRefreshScope(h.folder, { files: new Set([OTHER + '.jsonl']) }).files.has(OLD + '.jsonl'));
  ack.resolve(); await pending;
  assert.equal(attempts, 2);
  assert.equal(JSON.parse(h.rows.get(OLD).continuationIndex).bytes, require('node:fs').statSync(h.file(OLD)).size);
  assert.equal(cache.continuationRefreshScope(h.folder, { files: new Set([OTHER + '.jsonl']) }).files.has(OLD + '.jsonl'), false);
});

test('D1 no recorder scope spans any yielded preparation', { timeout: 9000 }, async t => {
  const h = fixture(t); h.write(OLD, h.link()); cache.refreshFolder(h.folder); h.append(OLD, h.padding);
  let adapter, checked = 0;
  const proxy = { ...cache, init(context) { adapter = context.db; cache.init(context); },
    async prepareContinuationRefresh(...args) {
      assert.throws(() => adapter.setFolderMeta(h.folder, h.root, 0), /cache mutation outside writer command/);
      checked++; return cache.prepareContinuationRefresh(...args);
    } };
  const writer = memoryWriter(h.db, proxy); await writer.ready;
  writer.initializeCache({ PROJECTS_DIR: h.root, activeSessions: h.activeSessions, getMainWindow: () => null, log: h.log });
  await writer.refreshFolder(h.folder); assert.equal(checked, 1);
});

for (const zero of [false, true]) test('D2 shipped readonly worker awaits cold preparation and progress, zero marker=' + zero, { timeout: 9000 }, async t => {
  const h = fixture(t); h.write(OLD, h.padding + h.link()); h.write(OTHER); cache.refreshFolder(h.folder); h.init();
  h.append(OLD, h.padding); h.append(OTHER);
  if (zero) h.folders.get(h.folder).indexMtimeMs = 0;
  else {
    const changedAt = new Date(h.folders.get(h.folder).indexMtimeMs + 1000);
    fs.utimesSync(h.file(OLD), changedAt, changedAt);
  }
  const worker = projectsWorker(h);
  await worker.handle({ id: 71, reconcile: true, localDescriptors: h.descriptors });
  const final = worker.replies.find(r => r.result);
  assert.equal(final.id, 71); assert.ok(worker.replies.some(r => r.progress));
  for (const view of [final.result.defaultProjects, final.result.allProjects]) {
    const rows = view.flatMap(p => p.sessions).filter(row => row.sessionId !== OTHER);
    assert.equal(rows.length, 1); assert.equal(rows[0].name, 'JB rename');
  }
  const effects = worker.replies.flatMap(r => (r.progress || r.result).effects);
  const source = effects.flatMap(e => e.name === 'upsertCachedSessions' ? e.args[0] : []).find(row => row.sessionId === OLD);
  assert.equal(JSON.parse(source.continuationIndex).bytes, require('node:fs').statSync(h.file(OLD)).size);
});

test('D2 asynchronous build error keeps request id and next request succeeds', { timeout: 9000 }, async t => {
  const h = fixture(t); h.write(OLD, h.link()); cache.refreshFolder(h.folder);
  let fail = true;
  const worker = projectsWorker(h, { beforeSnapshot: () => { if (fail) throw Error('snapshot gone'); } });
  await worker.handle({ id: 72, reconcile: true });
  assert.deepEqual(worker.replies, [{ id: 72, error: 'snapshot gone' }]); fail = false;
  await worker.handle({ id: 73, reconcile: true });
  assert.ok(worker.replies.some(r => r.id === 73 && r.result));
});

test('D3 actual client serializes VM worker requests paused at scan yield and resets after error', { timeout: 9000 }, async t => {
  const h = fixture(t); h.write(OLD, h.padding + h.link()); cache.refreshFolder(h.folder); h.append(OLD, h.padding);
  const changedAt = new Date(h.folders.get(h.folder).indexMtimeMs + 1000);
  fs.utimesSync(h.file(OLD), changedAt, changedAt);
  const entered = barrier(), gate = barrier(), workers = [], dispatched = [];
  let paused = false, fail = false;
  const client = createProjectsWorkerClient({ snapshot: () => ({ version: 0, liveVersion: 0, localDescriptors: h.descriptors }), apply() {},
    workerFactory: () => {
      const emitter = new EventEmitter(); workers.push(emitter);
      const worker = projectsWorker(h, { beforeSnapshot: () => { if (fail) throw Error('snapshot gone'); }, onMessage: message => emitter.emit('message', message),
        onYield: callback => { if (!paused) { paused = true; entered.resolve(); gate.promise.then(callback); } else setImmediate(callback); } });
      emitter.postMessage = message => { dispatched.push(message.id); worker.handle(message); };
      emitter.terminate = async () => { emitter.terminated = true; };
      return emitter;
    } });
  t.after(() => { gate.resolve(); return client.shutdown(); });
  const first = client.request({ reconcile: true }); first.catch(() => {}); await entered.promise;
  const second = client.request({ reconcile: true }); second.catch(() => {}); assert.equal(dispatched.length, 1);
  gate.resolve(); const [a, b] = await Promise.all([first, second]);
  assert.equal(dispatched.length, 2); assert.ok(a.defaultProjects.length); assert.ok(b.defaultProjects.length);
  fail = true; await assert.rejects(client.request(), /snapshot gone/); await tick();
  assert.equal(workers[0].terminated, true); fail = false;
  assert.ok((await client.request()).defaultProjects.length); assert.equal(workers.length, 2);
});

for (const liveChange of [false, true]) test('D4 actual relay rejects stale VM effects after main ' + (liveChange ? 'liveVersion' : 'metadata revision') + ' advances', { timeout: 9000 }, async t => {
  const h = fixture(t); h.write(OLD, h.link()); cache.refreshFolder(h.folder); h.append(OLD, h.padding);
  const writer = memoryWriter(h.db, cache); await writer.ready;
  writer.initializeCache({ PROJECTS_DIR: h.root, activeSessions: h.activeSessions, getMainWindow: () => null, log: h.log });
  const built = barrier(), output = [], emitted = new EventEmitter(); let first = true, version = 0, liveVersion = 0, applied = 0;
  const worker = projectsWorker(h, { onMessage: message => { if (first) { output.push(message); if (message.error) built.reject(Error(message.error)); if (message.result) built.resolve(); } else emitted.emit('message', message); } });
  emitted.postMessage = message => worker.handle(message); emitted.terminate = async () => {};
  const client = createProjectsWorkerClient({ workerFactory: () => emitted, snapshot: () => ({ version, liveVersion, localDescriptors: h.descriptors }),
    apply: async result => { applied++; await writer.applyProjectsWorkerEffects(result); } });
  t.after(() => client.shutdown()); const pending = client.request({ reconcile: true }); pending.catch(() => {}); await built.promise;
  h.meta.set(OLD, { name: 'new main name' }); if (liveChange) liveVersion++; else version++;
  first = false; for (const message of output) emitted.emit('message', message);
  const result = await pending;
  assert.ok(applied > 0); assert.equal(result.defaultProjects.flatMap(p => p.sessions)[0].name, 'new main name');
  assert.equal(h.meta.get(OLD).name, 'new main name');
});

test('D4 writer admission refuses a queued obsolete worker effect snapshot', { timeout: 9000 }, async t => {
  const h = fixture(t); h.write(OLD, h.link()); cache.refreshFolder(h.folder); h.append(OLD, h.padding);
  let revision = 0; h.db.getProjectsRevision = () => revision;
  const writer = memoryWriter(h.db, cache); await writer.ready;
  writer.initializeCache({ PROJECTS_DIR: h.root, activeSessions: h.activeSessions, getMainWindow: () => null, log: h.log });
  const entered = barrier(), gate = barrier(); const original = cache.prepareContinuationRefresh;
  t.mock.method(cache, 'prepareContinuationRefresh', async (...args) => { entered.resolve(); await gate.promise; return original(...args); });
  const refreshing = writer.refreshFolder(h.folder); await entered.promise;
  const stale = writer.applyProjectsWorkerEffects({ effects: [{ name: 'setName', args: [OLD, 'old worker name'] }], keptLiveRows: [] });
  const refused = assert.rejects(stale, error => error.code === 'WRITER_STALE'); await Promise.resolve(); revision++; gate.resolve(); await refreshing; await refused;
  assert.equal(h.meta.get(OLD).name, 'JB rename');
});

test('D1 retained release recomputes after a stale effects ACK using the captured folder', async t => {
  const fs = require('node:fs');
  const h = fixture(t); h.write(OLD, h.link()); cache.refreshFolder(h.folder);
  let stale = false, releases = 0;
  const client = { ready: Promise.resolve(), async request(name, effects) {
    assert.equal(name, 'effects');
    if (stale && ++releases === 1) { h.append(OLD, h.padding); throw Object.assign(Error('stale release'), { code: 'WRITER_STALE' }); }
    for (const effect of effects) h.db[effect.name](...effect.args);
  } };
  const writer = createSessionIndexWriter({ client, readonlyBackend: h.db }, cache); await writer.ready;
  writer.initializeCache({ PROJECTS_DIR: h.root, activeSessions: h.activeSessions, getMainWindow: () => null, log: h.log });
  h.activeSessions.set(OLD, { projectFolder: h.folder }); fs.renameSync(h.file(OLD), h.file(OLD) + '.saved');
  await writer.refreshFolder(h.folder); assert.equal(cache.getRetainedFolder(OLD), h.folder);
  fs.renameSync(h.file(OLD) + '.saved', h.file(OLD)); h.activeSessions.delete(OLD); h.append(OLD, h.padding); stale = true;
  await writer.releaseLiveSession(OLD);
  assert.equal(releases, 2, 'the stale release is recomputed and committed');
  assert.equal(JSON.parse(h.rows.get(OLD).continuationIndex).bytes, fs.statSync(h.file(OLD)).size);
  assert.equal(cache.getRetainedFolder(OLD), undefined);
});

test('B5/D2 cold worker retries an identity race before publishing its source row', async t => {
  const fs = require('node:fs');
  const h = fixture(t); h.write(OLD, h.link()); cache.refreshFolder(h.folder); h.init(); h.append(OLD, h.padding);
  const changedAt = new Date(h.folders.get(h.folder).indexMtimeMs + 1000);
  fs.utimesSync(h.file(OLD), changedAt, changedAt);
  let raced = false;
  const worker = projectsWorker(h, { onYield: callback => {
    if (!raced) { raced = true; fs.renameSync(h.file(OLD), h.file(OLD) + '.old'); h.write(OLD, h.padding + h.link(OTHER)); }
    setImmediate(callback);
  } });
  await worker.handle({ id: 74, reconcile: true });
  assert.equal(raced, true);
  assert.equal(worker.replies.some(reply => reply.error), false);
  const effects = worker.replies.flatMap(reply => (reply.progress || reply.result).effects);
  const sources = effects.flatMap(effect => effect.name === 'upsertCachedSessions' ? effect.args[0] : []).filter(row => row.sessionId === OLD);
  assert.equal(sources.length, 1, 'only the successful retry publishes a source row');
  const [source] = sources;
  assert.ok(source, 'one retry publishes the replacement source rather than its stale row');
  const index = JSON.parse(source.continuationIndex);
  assert.deepEqual(index.ids, [OTHER]); assert.equal(index.bytes, fs.statSync(h.file(OLD)).size);
  assert.equal(index.complete, true);
});
