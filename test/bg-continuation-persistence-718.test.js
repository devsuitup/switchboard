'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { helper, OLD, tick, barrier } = require('./fixtures/continuation-718.cjs');
const { fixture, HEAD, OTHER } = require('./fixtures/continuation-718.cjs');

for (const mode of ['normal', 'contended', 'absent']) test('A1/A5 typed legacy handoff through shipped main wiring survives cold rebuild, mode=' + mode, { timeout: 9000 }, async t => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const cache = require('../session-cache'), transitions = require('../session-transitions');
  const h = fixture(t); h.write(OLD, h.padding); h.write(OTHER); cache.refreshFolder(h.folder);
  const index = JSON.parse(h.rows.get(OLD).continuationIndex); delete index.head; h.rows.get(OLD).continuationIndex = JSON.stringify(index); h.init();
  const entry = { projectFolder: h.folder, pty: { pid: 7, write() {} }, composerState: require('../composer-state').createComposerState(),
    knownJsonlFiles: new Set([OLD + '.jsonl', OTHER + '.jsonl']), continuationSnapshot: transitions.snapshotContinuations(h.file(OLD), OLD) };
  h.activeSessions.set(OLD, entry);
  const writer = { rekeySessionMeta: async (from, to) => h.meta.set(to, { ...h.meta.get(from), ...h.meta.get(to) }),
    setCachedContinuationIndex: async (...args) => h.db.setCachedContinuationIndex(...args),
    refreshFolder: async (folder, opts) => cache.refreshFolder(folder, { ...opts, preparedContinuations: await cache.prepareContinuationRefresh(folder, opts) }) };
  h.init(writer); const requested = [], notified = [], liveness = [];
  if (mode === 'absent') h.rows.delete(OLD);
  const ctx = vm.createContext({ path, fs, require: require('node:module').createRequire(path.join(__dirname, '../main.js')), PROJECTS_DIR: h.root,
    activeSessions: h.activeSessions, sessionCache: cache, writer, sessionTransitions: transitions, sessionHasPty: () => false, ptyPids: () => [],
    mainWindow: null, log: h.log, rekeyMcpServer() {}, activityReporter: { rekey() {} }, taskRecords: { rekey() {}, hasRecord: () => false },
    isHostedJob: require('../bg-agents-roster').isHostedJob, bgAgents: { getCachedJobs: () => new Map([['1234abcd', { sessionId: HEAD, state: 'working' }]]) },
    cliSessionState: { readAllDescriptors: () => h.descriptors, getSidebarDescriptors: () => h.descriptors,
      clearOwner: () => 'other', getDescriptorIdentity: () => 'fixture', liveElsewhereChecked: async id => { liveness.push(id); return { known: true, live: id === HEAD ? h.descriptors[0] : null }; } },
    notifyRendererProjectsChanged: () => { assert.equal(h.views().length, 1); notified.push('coherent'); } });
  const { persistBackgroundHandoff } = require('./app-source').loadAppFunctions(ctx, { sourcePath: path.join(__dirname, '../main.js'), declarations: ['backgroundHandoffs'],
    functions: ['readBackgroundHandoffStamp', 'persistBackgroundHandoff'] });
  ctx.persistBackgroundHandoff = context => { const pending = persistBackgroundHandoff(context); requested.push(pending); return pending; };
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('sessionTransitions.init({');
  vm.runInContext(source.slice(start, source.indexOf('\n});', start) + 4), ctx, { filename: 'main.js' });
  const input = require('../terminal-input').handleTerminalInput;
  input(h.activeSessions, OLD, '/bg', Date.now()); input(h.activeSessions, OLD, '\r', Date.now());
  h.append(OLD, h.link());
  if (mode === 'contended') { h.append(OTHER); cache.refreshFolder(h.folder, { files: new Set([OTHER + '.jsonl', OLD + '.jsonl']) }); }
  transitions.detectSessionTransitions(h.folder); await transitions.drainMetadataWrites(); await Promise.all(requested);
  assert.equal(requested.length, 1); assert.equal(notified.length, 1); assert.equal(h.logs.filter(x => x[0] === 'error' || x[0] === 'warn').length, 0);
  assert.ok(liveness.includes(mode === 'absent' ? OLD : HEAD));
  assert.deepEqual(JSON.parse(h.rows.get(OLD).continuationIndex).ids, [HEAD]);
  h.init(); assert.equal(h.views().length, 1); assert.equal(h.views()[0].name, 'JB rename');
  t.after(() => transitions.init({ activeSessions: new Map() }));
});

test('A2 resolve then refresh ACK then notification', { timeout: 9000 }, async () => {
  const ack = barrier(), calls = [];
  const h = helper({ writer: { refreshFolder: async () => { calls.push('refresh'); await ack.promise; } } });
  const pending = h.persistBackgroundHandoff(h.request);
  await tick();
  assert.deepEqual(calls, ['refresh']);
  assert.deepEqual(h.events, ['resolve:' + OLD]);
  ack.resolve(); await pending;
  assert.deepEqual(h.events, ['resolve:' + OLD, 'notify:background-handoff']);
});

test('A3 captured exit runs once with old identity even after source changes/removal', { timeout: 9000 }, async () => {
  const h = helper();
  await h.persistBackgroundHandoff(h.request);
  h.request.session.realSessionId = 'changed'; h.request.session.projectFolder = 'changed';
  await h.persistBackgroundHandoff(h.request);
  h.drain.resolve(); await tick();
  assert.deepEqual(h.events, [0, 1].flatMap(() => ['resolve:' + OLD, 'refresh:folder:' + OLD + '.jsonl', 'notify:background-handoff']));
});

for (const stage of ['stat', 'resolve', 'refresh', 'exit-drain']) {
  test('A4 failure at ' + stage + ' warns once and never notifies a failed pass', { timeout: 9000 }, async () => {
    const h = helper(stage === 'resolve' ? { sessionCache: { resolveSessionContinuations: () => { throw Error('disk gone'); } } }
      : stage === 'refresh' ? { writer: { refreshFolder: async () => { throw Error('disk gone'); } } } : {});
    if (stage === 'stat') require('node:vm').runInContext('readBackgroundHandoffStamp = () => { throw Error("disk gone"); };', h.ctx, { filename: 'stat-failure-718.js' });
    await h.persistBackgroundHandoff(h.request);
    if (stage === 'exit-drain') { h.events.length = 0; h.drain.reject(Error('disk gone')); await tick(); }
    assert.equal(h.warned.length, 1);
    assert.match(h.warned[0][0], new RegExp(OLD + '.*' + stage + '.*disk gone'));
    assert.equal(h.events.some(x => x.startsWith('notify:')), false);
  });
}

test('A6 exact pending/success coalescing and colliding Number stamps', { timeout: 9000 }, async () => {
  const gate = barrier(); let scans = 0;
  const h = helper({ sessionCache: { resolveSessionContinuations: async () => { if (++scans === 1) await gate.promise; } } });
  const first = h.persistBackgroundHandoff(h.request);
  const duplicate = h.persistBackgroundHandoff(h.request);
  await tick(); assert.equal(scans, 1);
  h.stamp.mtimeNs = '9007199254740993';
  const changed = h.persistBackgroundHandoff(h.request);
  h.persistBackgroundHandoff(h.request);
  gate.resolve(); await Promise.all([first, duplicate, changed]);
  assert.equal(scans, 2);
  await h.persistBackgroundHandoff(h.request); assert.equal(scans, 2);
  h.stamp.size = '5'; await h.persistBackgroundHandoff(h.request); assert.equal(scans, 3);
});

test('A6 same-stamp explicit request retries a failed pass', { timeout: 9000 }, async () => {
  let scans = 0;
  const h = helper({ sessionCache: { resolveSessionContinuations: async () => { if (++scans === 1) throw Error('once'); } } });
  await h.persistBackgroundHandoff(h.request); await h.persistBackgroundHandoff(h.request);
  assert.equal(scans, 2); assert.equal(h.warned.length, 1);
});

test('A6 shipped button onConfirmed request joins transition work and one captured exit', { timeout: 9000 }, async () => {
  const h = helper();
  Object.assign(h.request.session, { realSessionId: OLD, projectFolder: 'folder', exitDrain: h.drain.promise });
  Object.assign(h.ctx, { activeSessions: new Map([['tab', h.request.session]]),
    createContinuationReader: () => async () => null,
    detectSessionTransitions: () => h.persistBackgroundHandoff(h.request),
    sendToBackground: async (_id, options) => { options.onConfirmed(); return { ok: true, sessionId: h.request.targetId, jobId: h.request.jobId }; },
    writePty() {}, killPty() {}, mainWindow: null, setTimeout, clearTimeout });
  const { handleSendToBackground } = require('./app-source').loadAppFunctions(h.ctx, { sourcePath: require('node:path').join(__dirname, '../main.js'), functions: ['handleSendToBackground'] });
  assert.equal((await handleSendToBackground({}, 'tab')).ok, true); await tick();
  assert.equal(h.events.filter(x => x.startsWith('resolve:')).length, 1);
  h.drain.resolve(); await tick(); assert.equal(h.events.filter(x => x.startsWith('resolve:')).length, 2);
});

test('A2 real committed row and cold rebuild are coherent only after refresh ACK', { timeout: 9000 }, async t => {
  const cache = require('../session-cache'), h = fixture(t), ack = barrier(), entered = barrier();
  h.write(OLD, h.padding); cache.refreshFolder(h.folder); h.init(); h.append(OLD, h.link());
  const events = [];
  const real = helper({ sessionCache: cache, writer: { refreshFolder: async (folder, opts) => { entered.resolve(); await ack.promise;
    cache.refreshFolder(folder, { ...opts, preparedContinuations: await cache.prepareContinuationRefresh(folder, opts) }); } },
    notifyRendererProjectsChanged: () => { assert.equal(h.views().length, 1); events.push('coherent'); } });
  real.request.projectFolder = h.folder;
  const pending = real.persistBackgroundHandoff(real.request); await entered.promise;
  assert.deepEqual(events, []); ack.resolve(); await pending; assert.deepEqual(events, ['coherent']);
  h.init(); assert.equal(h.views().length, 1);
});

test('A3 real four-record suffix persists after re-key/removal and again after exit', { timeout: 9000 }, async t => {
  const cache = require('../session-cache'), h = fixture(t), exited = barrier();
  h.write(OLD, h.link()); h.write(OTHER); cache.refreshFolder(h.folder);
  let notifications = 0;
  const real = helper({ sessionCache: cache, writer: { refreshFolder: async (folder, opts) => {
    cache.refreshFolder(folder, { ...opts, preparedContinuations: await cache.prepareContinuationRefresh(folder, opts) }); } },
    notifyRendererProjectsChanged: () => { if (++notifications === 2) exited.resolve(); } });
  real.request.projectFolder = h.folder; await real.persistBackgroundHandoff(real.request);
  real.request.session.realSessionId = HEAD; real.request.session.projectFolder = 'wrong'; h.activeSessions.clear();
  h.append(OLD, ['cost-state', 'last-prompt', 'cost-state', 'file-history-snapshot'].map(type => JSON.stringify({ type, padding: 'x'.repeat(300) }) + '\n').join(''));
  real.drain.resolve(); await exited.promise;
  assert.equal(JSON.parse(h.rows.get(OLD).continuationIndex).bytes, require('node:fs').statSync(h.file(OLD)).size);
  h.append(OLD, h.padding); h.append(OTHER); const opts = { files: new Set([OTHER + '.jsonl', OLD + '.jsonl']) };
  cache.refreshFolder(h.folder, { ...opts, preparedContinuations: await cache.prepareContinuationRefresh(h.folder, opts) });
  assert.equal(h.views().length, 1);
});

test('A3 already settled drain forces one serialized exit pass', { timeout: 9000 }, async () => {
  const h = helper(); h.request.exitDrain = Promise.resolve();
  await h.persistBackgroundHandoff(h.request); await tick();
  assert.equal(h.events.filter(x => x.startsWith('resolve:')).length, 2);
});
