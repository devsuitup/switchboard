'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { createSessionIndexWriter } = require('../session-index-writer');
const { createWriterWorkerClient } = require('../session-index-writer-client');
const { createWriterCommands } = require('../session-index-commands');
const { createProjectDeleteProgress, operationId, commitTransaction } = require('../src/main/projects/project-delete-progress');
const archive = require('../archived-projects');
const openStore = require('./fixtures/conversation-store.cjs');
const supported = { skip: !openStore.supported && 'native SQLite ABI differs; node:sqlite requires Node 22' };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const reserve = (writer, projects) => writer.reserveProjectDeletion ? writer.reserveProjectDeletion(projects) : { ready: Promise.resolve(), release() {} };

function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'archive-race-')));
  const previous = process.env.SWITCHBOARD_DATA_DIR;
  process.env.SWITCHBOARD_DATA_DIR = path.join(root, 'db');
  const db = openStore(), commands = createWriterCommands(db);
  const project = { alias: null, projectPath: root }, entry = archive.archivedEntry(null, root);
  const file = path.join(root, '.claude', 'commands', 'schedule-race.md'), stateDir = path.join(root, 'claims');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '---\nname: race\nenabled: false\ncron: * * * * *\ncatch-up: true\n---\nfixture\n');
  const reenable = files => archive.reenableScheduleFiles(files, root, { stateDir });
  const offer = () => db.setSetting('scheduleReenableOffers', { [entry]: { disabledSchedules: [file], archivedAt: 'then' } });
  const client = { ready: Promise.resolve(), async request(name, ...args) {
    if (name === 'effects') { for (const effect of args[0]) db[effect.name](...effect.args); return; }
    return commitTransaction(db, () => (commands[name] || db[name])(...args)).result;
  }, async requestForWorkflow(id, name, ...args) { return this.request(name, ...args); }, async fenceWorkflow() {}, retireWorkflow() {} };
  const writer = createSessionIndexWriter({ client, readonlyBackend: db }, { buildProjectsFromCache: () => [], resolveFolderDir: () => null });
  t.after(() => { db.closeDb(); if (previous === undefined) delete process.env.SWITCHBOARD_DATA_DIR; else process.env.SWITCHBOARD_DATA_DIR = previous; fs.rmSync(root, { recursive: true, force: true }); });
  const bytes = () => ({ schedule: fs.readFileSync(file, 'utf8'), claims: fs.existsSync(stateDir) ? fs.readdirSync(stateDir).sort().map(name => [name, fs.readFileSync(path.join(stateDir, name), 'utf8')]) : [] });
  const fence = () => createProjectDeleteProgress(db).fence({ project, operationId: operationId(project, commands.readProjectArchiveEpochs ? commands.readProjectArchiveEpochs([project], true)[0].epoch : 0) });
  return { root, db, commands, project, entry, file, stateDir, writer, client, offer, reenable, bytes, fence };
}

test('reservation waits for fetched offer through async callback and completion ACK', supported, async t => {
  const h = setup(t); h.offer(); await h.writer.ready;
  const fetched = deferred(), proceed = deferred(), callback = deferred(), callbackRelease = deferred(), completing = deferred(), ack = deferred();
  const request = h.client.request.bind(h.client);
  h.client.request = async (name, ...args) => {
    const result = await request(name, ...args);
    if (name === 'beginOffer') { fetched.resolve(); await proceed.promise; }
    if (name === 'completeOffer') { completing.resolve(); await ack.promise; }
    return result;
  };
  const enabling = h.writer.reenableOfferedSchedules(h.root, null, { notify() {}, async reenable(files) { callback.resolve(); await callbackRelease.promise; return h.reenable(files); } });
  await fetched.promise;
  const hold = reserve(h.writer, [h.project]);
  let ready = false; hold.ready.then(() => { ready = true; });
  await turn();
  assert.equal(ready, false, 'deletion must wait for the already fetched offer');
  proceed.resolve(); await callback.promise;
  await turn(); assert.equal(ready, false, 'async filesystem callback holds lease');
  callbackRelease.resolve(); await completing.promise;
  await turn(); assert.equal(ready, false, 'completion ACK still holds the lease');
  ack.resolve();
  assert.equal((await enabling).ok, true);
  await hold.ready;
  assert.match(h.bytes().schedule, /enabled: true/);
  assert.ok(h.bytes().claims.length > 0, 'actual catch-up claim written before deletion');
  const before = h.bytes(); h.fence();
  assert.deepEqual(h.bytes(), before, 'deletion linearization leaves retained schedule and claim bytes');
  hold.release();
});

test('reserved deletion refuses new offer and Undo with unchanged schedule and claim bytes', supported, async t => {
  const h = setup(t); h.offer(); await h.writer.ready;
  h.db.setSetting('archivedProjects', { [h.entry]: { archivedAt: 'then', disabledByArchive: [h.file], disabledSchedules: [h.file] } });
  const hold = reserve(h.writer, [h.project]); await hold.ready;
  const before = h.bytes();
  const result = await h.writer.reenableOfferedSchedules(h.root, null, { notify() {}, reenable: h.reenable }).catch(error => ({ error: error.code }));
  assert.deepEqual(h.bytes(), before, 'reserved identity must not rewrite schedule or catch-up claims');
  assert.ok(result.error, 'offer after reservation must refuse');
  const undo = await h.writer.undoArchiveProjectFolders([{ projectPath: h.root }], 'then', { notify() {}, reenable: h.reenable }).catch(error => ({ error: error.code }));
  assert.ok(undo.error);
  assert.deepEqual(h.bytes(), before, 'valid Undo after reservation cannot rewrite retained bytes');
  hold.release();
});

test('withCache siblings share exclusion while other host and child worktree remain available', supported, async t => {
  const h = setup(t); h.offer(); await h.writer.ready;
  const dbPath = require.resolve('../db'), previousDb = require.cache[dbPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: h.db };
  t.after(() => { if (previousDb) require.cache[dbPath] = previousDb; else delete require.cache[dbPath]; });
  const sibling = h.writer.withCache({}); await sibling.ready;
  const hold = reserve(h.writer, [h.project]); await hold.ready;
  const before = h.bytes();
  const result = await sibling.reenableOfferedSchedules(h.root, null, { notify() {}, reenable: h.reenable }).catch(error => ({ error: error.code }));
  assert.deepEqual(h.bytes(), before, 'sibling facade must preserve retained bytes');
  assert.ok(result.error, 'sibling facade cannot escape deletion reservation');
  for (const project of [{ alias: 'remote', projectPath: '/workspace' }, { alias: null, projectPath: path.join(h.root, 'child') }]) {
    const other = reserve(sibling, [project]); await other.ready; other.release();
  }
  hold.release();
});

test('durable epochs refuse stale archive offer retirement and Undo after deletion and re-add', supported, t => {
  const h = setup(t), proof = [{ project: h.project, epoch: 0 }];
  h.offer(); const original = h.commands.beginOffer(h.entry, proof);
  h.fence();
  const archived = { [h.entry]: { archivedAt: 'then', disabledSchedules: [h.file], disabledByArchive: [h.file], knownSessionIds: [] } };
  h.db.setSetting('archivedProjects', archived);
  const snapshot = { archivedProjects: archived, hiddenProjects: [], hiddenProjectScopes: {}, scheduleReenableOffers: h.db.getSetting('scheduleReenableOffers') };
  const operations = [
    () => h.commands.beginOffer(h.entry, proof),
    () => h.commands.completeOffer(h.entry, original, { enabled: [], failed: [] }, proof),
    () => h.commands.beginArchive([{ entry: h.entry, record: archived[h.entry], disabledFiles: [] }], proof),
    () => h.commands.completeArchive([{ entry: h.entry, record: archived[h.entry] }], {}, proof),
    () => h.commands.retireArchivedEntries([h.entry], snapshot, proof),
    () => h.commands.undoArchiveProjectFolders([{ projectPath: h.root }], 'then', proof),
    () => h.commands.clearArchivedEntry(null, h.root, proof),
    () => h.commands.dismissReenableOffer(h.root, null, proof),
    () => h.commands.hideProject(h.root, 'archive', undefined, proof),
    () => h.commands.unhideProject(h.root, null, h.root, proof),
    () => h.commands.revealAddedProject(h.root, proof),
  ];
  const before = h.bytes();
  for (const operation of operations) assert.throws(operation, { code: 'PROJECT_EPOCH_STALE' }, 'old epoch cannot mutate a blocked identity');
  const fresh = h.commands.readProjectArchiveEpochs([h.project], true);
  const revision = h.db.getSetting('_writer_revision');
  commitTransaction(h.db, () => h.commands.revealAddedProject(h.root, fresh));
  assert.equal(h.db.getSetting('_writer_revision'), revision + 1, 'explicit reopen advances exactly one writer revision');
  assert.ok(h.commands.beginOffer(h.entry, h.commands.readProjectArchiveEpochs([h.project])), 'fresh admitted work remains usable after explicit re-add');
  h.db.setSetting('archivedProjects', archived);
  for (const operation of operations) assert.throws(operation, { code: 'PROJECT_EPOCH_STALE' }, 'old epoch stays stale after explicit reopen');
  assert.deepEqual(h.bytes(), before);
});

test('supplied epoch proofs cannot authorize an omitted identity even at epoch zero', supported, t => {
  const h = setup(t), foreign = [{ project: { alias: null, projectPath: path.join(h.root, 'other') }, epoch: 0 }];
  const before = h.db.changeCount();
  assert.throws(() => h.commands.beginArchive([{ entry: h.entry, record: {}, disabledFiles: [] }], foreign), { code: 'PROJECT_EPOCH_STALE' }, 'every affected identity needs an admitted proof');
  assert.equal(h.db.changeCount(), before, 'foreign proof refuses before settings writes');
});

test('a retained child worktree without parent archive can refresh during parent deletion reservation', supported, async t => {
  const h = setup(t); await h.writer.ready;
  const hold = reserve(h.writer, [h.project]); await hold.ready;
  const child = { projectPath: h.root.replaceAll('\\', '/') + '/.claude/worktrees/child', sessions: [] };
  const result = await h.writer.applyAndPersistArchived([child], false).then(value => ({ value }), error => ({ error: error.code }));
  assert.equal(result.error, undefined, 'parent deletion must not block the unrelated child worktree');
  assert.equal(result.value.length, 1);
  hold.release();
});

function workerHarness(h) {
  const port = new EventEmitter(), replies = new Map(), waiters = new Map();
  port.postMessage = message => {
    if (message.started) port.emit('started', message.id);
    if (message.id && !message.started) { replies.set(message.id, message); waiters.get(message.id)?.(message); }
  };
  const filename = require.resolve('../workers/session-index-writer'), nativeRequire = createRequire(filename);
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: name => name === 'node:worker_threads' ? { parentPort: port } : name === '../session-index-store' ? { openSessionIndexStore: () => h.db } : nativeRequire(name),
    setInterval: () => ({ unref() {} }), clearInterval() {},
  }, { filename });
  return { port, reply: id => replies.has(id) ? Promise.resolve(replies.get(id)) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker deadline')), 3000);
    waiters.set(id, message => { clearTimeout(timer); resolve(message); });
  }) };
}

test('worker fence rejects delayed beginArchive and cancels remaining effect chunks', supported, async t => {
  const h = setup(t), worker = workerHarness(h), workflowId = 'private-test';
  worker.port.emit('message', { id: 1, command: 'fenceWorkflow', args: [workflowId] });
  const fenced = await worker.reply(1);
  assert.equal(fenced.error, undefined, 'workflow cancellation barrier must ACK');
  const before = h.db.getSetting('_writer_revision');
  worker.port.emit('message', { id: 2, workflowId, command: 'beginArchive', args: [[{ entry: h.entry, record: {}, disabledFiles: [] }], [{ project: h.project, epoch: 0 }]] });
  assert.equal((await worker.reply(2)).error?.code, 'WORKFLOW_SEALED', 'delayed archive begin cannot persist after barrier');
  assert.equal(h.db.getSetting('_writer_revision'), before);
  assert.equal(h.db.getSetting('archivedProjects'), null);
  h.db.nextChunkSize = () => 1;
  const row = sessionId => ({ sessionId, folder: '-fixture', projectPath: h.root });
  const started = deferred(); worker.port.on('started', id => { if (id === 3) started.resolve(); });
  worker.port.emit('message', { id: 3, workflowId: 'chunked', command: 'effects', args: [[{ name: 'upsertCachedSessions', args: [[row('first'), row('last')]] }], before || 0] });
  await started.promise;
  worker.port.emit('message', { id: 4, command: 'fenceWorkflow', args: ['chunked'] });
  assert.equal((await worker.reply(4)).error, undefined);
  const cancelled = await worker.reply(3);
  assert.equal(cancelled.error?.code, 'WORKFLOW_SEALED');
  assert.ok(h.db.getCachedSession('first'), 'already executing transaction settled before barrier');
  assert.equal(h.db.getCachedSession('last'), null, 'queued remainder cannot commit after barrier');
  assert.equal(cancelled.settings?.find(([key]) => key === '_writer_revision')?.[1], h.db.getSetting('_writer_revision'), 'cancelled committed prefix must publish its current settings mirror');
  const revision = h.db.getSetting('_writer_revision');
  worker.port.emit('message', { id: 5, command: 'readProjectArchiveEpochs', args: [[h.project]] });
  const snapshot = await worker.reply(5);
  assert.equal(snapshot.error, undefined);
  assert.equal(snapshot.result[0].epoch, 0);
  assert.equal(Object.hasOwn(snapshot, 'settings'), false, 'archive epoch read omits mirror publication');
  assert.equal(h.db.getSetting('_writer_revision'), revision, 'epoch observation does not advance revision');
});

test('timed out beginArchive suppresses callbacks and keeps deletion waiting for cancellation ACK', supported, async t => {
  const h = setup(t); await h.writer.ready; h.db.setInitialScanComplete();
  assert.equal(typeof h.writer.reserveProjectDeletion, 'function', 'timeout recovery requires an exclusive workflow lease');
  const fenced = deferred(), acknowledge = deferred(), request = h.client.request.bind(h.client);
  let effects = 0;
  h.client.request = async (name, ...args) => {
    if (name === 'beginArchive') throw Object.assign(new Error('writer outcome unknown'), { code: 'WRITER_TIMEOUT' });
    return request(name, ...args);
  };
  h.client.fenceWorkflow = async () => { fenced.resolve(); await acknowledge.promise; };
  const archiving = h.writer.archiveProjectFolders([{ projectPath: h.root }], { disableSchedules: [h.file] }, {
    mergeProjects: projects => projects, now: () => 'then', activeSessions: new Map(), seedProjects: () => [h.root],
    scan: () => [{ filePath: h.file, name: 'race' }], realpath: fs.realpathSync,
    setEnabled() { effects++; return { ok: true }; }, notify() {},
  });
  await fenced.promise;
  const hold = reserve(h.writer, [h.project]); let ready = false; hold.ready.then(() => { ready = true; });
  await turn();
  assert.equal(ready, false, 'timeout rejection cannot release workflow lease');
  assert.equal(effects, 0, 'no not-yet-started filesystem callback after timeout');
  acknowledge.resolve(); assert.ok((await archiving).error);
  await hold.ready; hold.release();
});

test('multi-key reservations are atomic and canonical host keys leave unrelated workflows usable', supported, async t => {
  const h = setup(t); await h.writer.ready;
  const local = { alias: null, projectPath: '/shared' }, remote = { alias: 'remote', projectPath: '/shared' };
  const hold = reserve(h.writer, [local, h.project]); await hold.ready;
  assert.throws(() => reserve(h.writer, [remote, h.project]), { code: 'WORKFLOW_BUSY' }, 'a conflict cannot partially reserve another key');
  const remoteHold = reserve(h.writer, [remote]); await remoteHold.ready; remoteHold.release();
  assert.equal((await h.writer.reenableOfferedSchedules('/shared', 'remote::folder', { notify() {} })).ok, true, 'same-path remote workflow continues');
  const before = h.db.getSetting('archivedProjects');
  const result = await h.writer.archiveProjectFolders([{ projectPath: path.join(h.root, 'other') }, { projectPath: h.root }], {}, {}).catch(error => ({ error: error.code }));
  assert.ok(result.error, 'multi-group archive refuses atomically');
  assert.equal(h.db.getSetting('archivedProjects'), before);
  const unclaimed = reserve(h.writer, [{ alias: null, projectPath: path.join(h.root, 'other') }]); await unclaimed.ready; unclaimed.release();
  hold.release();
});

test('Undo holds its lease through an injected async schedule callback', supported, async t => {
  const h = setup(t); await h.writer.ready;
  assert.equal(typeof h.writer.reserveProjectDeletion, 'function', 'Undo must participate in deletion exclusion');
  h.db.setSetting('archivedProjects', { [h.entry]: { archivedAt: 'then', disabledByArchive: [h.file], disabledSchedules: [h.file] } });
  const entered = deferred(), proceed = deferred();
  const undo = h.writer.undoArchiveProjectFolders([{ projectPath: h.root }], 'then', { notify() {}, async reenable(files) { entered.resolve(); await proceed.promise; return h.reenable(files); } });
  await entered.promise;
  const hold = reserve(h.writer, [h.project]); let ready = false; hold.ready.then(() => { ready = true; });
  await turn(); assert.equal(ready, false, 'Undo filesystem callback remains protected');
  proceed.resolve(); assert.equal((await undo).ok, true); await hold.ready;
  assert.match(h.bytes().schedule, /enabled: true/); assert.ok(h.bytes().claims.length);
  hold.release();
});

test('unreachable cancellation keeps the identity unavailable after the caller receives its error', supported, async t => {
  const h = setup(t); await h.writer.ready;
  const request = h.client.request.bind(h.client);
  h.client.request = async (name, ...args) => {
    if (name === 'beginOffer') throw Object.assign(new Error('outcome unknown'), { code: 'WRITER_TIMEOUT' });
    return request(name, ...args);
  };
  h.client.fenceWorkflow = async () => { throw new Error('barrier unreachable'); };
  await assert.rejects(h.writer.reenableOfferedSchedules(h.root, null, { notify() {}, reenable: h.reenable }), { code: 'WRITER_TIMEOUT' });
  const hold = reserve(h.writer, [h.project]); let ready = false; hold.ready.then(() => { ready = true; });
  await turn();
  assert.equal(ready, false, 'unreachable barrier cannot authorize deletion');
});

test('client sealing removes unsent workflow requests and refuses future submissions', async () => {
  const port = new EventEmitter(), sent = [];
  port.postMessage = message => { sent.push(message); if (message.command === 'fenceWorkflow') queueMicrotask(() => port.emit('message', { id: message.id, result: true })); };
  port.terminate = async () => 0;
  const client = createWriterWorkerClient({ workerFactory: () => port, timeoutMs: 1000 });
  try {
    const pending = client.requestForWorkflow ? client.requestForWorkflow('old', 'beginArchive', []) : client.request('beginArchive', []);
    const rejected = pending.then(() => null, error => error);
    const fencing = client.fenceWorkflow ? client.fenceWorkflow('old') : Promise.resolve();
    port.emit('message', { ready: true, settings: [] });
    await fencing;
    assert.equal(sent.filter(message => message.command === 'beginArchive').length, 0, 'unsent begin must be removed before control ACK');
    assert.equal((await rejected)?.code, 'WORKFLOW_SEALED');
    await assert.rejects(client.requestForWorkflow('old', 'beginArchive', []), { code: 'WORKFLOW_SEALED' });
  } finally { await client.terminate(); }
});

for (const operation of ['list', 'hide', 'archive']) test(`ordinary ${operation} succeeds during a list load without a deletion reservation`, supported, async t => {
  const h = setup(t); await h.writer.ready;
  h.db.setInitialScanComplete(true);
  const projects = [{ projectPath: h.root, sessions: [] }];
  const loading = h.writer.applyAndPersistArchived(projects, false);
  const concurrent = operation === 'list' ? h.writer.applyAndPersistArchived(projects, false)
    : operation === 'hide' ? h.writer.hideProject(h.root, 'manual')
      : h.writer.archiveProjectFolders([{ projectPath: h.root }], {}, { mergeProjects: value => value, now: () => 'now', seedProjects: () => [], scan: () => [], notify() {} });
  const results = await Promise.allSettled([loading, concurrent]);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled'], 'ordinary workflows must both succeed without reservation');
  if (operation === 'archive') assert.equal(results[1].value.ok, true, 'archive completes during list load');
});

test('list containing a fenced project succeeds while retirement still guards affected entries', supported, async t => {
  const h = setup(t); await h.writer.ready; h.fence();
  const projects = [{ projectPath: h.root, sessions: [] }, { projectPath: path.join(h.root, 'other'), sessions: [] }];
  const result = await h.writer.applyAndPersistArchived(projects, false).then(value => ({ value }), error => ({ error: error.code }));
  assert.equal(result.error, undefined, 'blocked identity must not reject a project list');
  assert.equal(result.value.length, 2);
  const otherEntry = archive.archivedEntry(null, projects[1].projectPath);
  h.db.setSetting('archivedProjects', { [otherEntry]: { knownSessionIds: [], disabledSchedules: [] } });
  const withRetirement = await h.writer.applyAndPersistArchived([projects[0], { ...projects[1], sessions: [{ sessionId: 'new-other' }] }], false);
  assert.equal(withRetirement.length, 2);
  assert.equal(h.db.getSetting('archivedProjects')[otherEntry], undefined, 'only the retired entry needs an unblocked epoch');
  h.db.setSetting('archivedProjects', { [h.entry]: { knownSessionIds: [], disabledSchedules: [h.file] } });
  const listed = await h.writer.applyAndPersistArchived([{ projectPath: h.root, sessions: [{ sessionId: 'new' }] }], false)
    .then(value => ({ value }), error => ({ error: error.code }));
  assert.equal(listed.error, undefined, 'blocked retirement must not fail the list');
  assert.ok(h.db.getSetting('archivedProjects')[h.entry], 'blocked retirement preserves record');
  assert.equal(listed.value.length, 0, 'blocked record keeps project archived in rendering');
});

test('list skips reserved retirement while unrelated project retires', supported, async t => {
  const h = setup(t); await h.writer.ready;
  const other = path.join(h.root, 'other'), otherEntry = archive.archivedEntry(null, other);
  h.db.setSetting('archivedProjects', { [h.entry]: { knownSessionIds: [] }, [otherEntry]: { knownSessionIds: [] } });
  const hold = reserve(h.writer, [h.project]); await hold.ready;
  try {
    const listed = await h.writer.applyAndPersistArchived([h.root, other].map(projectPath => ({ projectPath, sessions: [{ sessionId: 'new' }] })), false)
      .then(value => ({ value }), error => ({ error: error.code }));
    assert.equal(listed.error, undefined, 'reservation must not fail a list');
    assert.ok(h.db.getSetting('archivedProjects')[h.entry], 'held entry stays archived');
    assert.equal(listed.value.length, 1, 'held record keeps project archived in rendering');
    assert.equal(h.db.getSetting('archivedProjects')[otherEntry], undefined, 'unheld entry retires');
  } finally { hold.release(); }
});

test('backend fence waits for reservation readiness through fetched offer completion', supported, async t => {
  const h = setup(t); h.offer(); await h.writer.ready;
  const fetched = deferred(), proceed = deferred();
  const request = h.client.request.bind(h.client);
  let fences = 0;
  h.client.request = async (name, ...args) => {
    if (name === 'fenceProjectDeletion') { fences++; return createProjectDeleteProgress(h.db).fence(args[0]); }
    const result = await request(name, ...args);
    if (name === 'beginOffer') { fetched.resolve(); await proceed.promise; }
    return result;
  };
  const enabling = h.writer.reenableOfferedSchedules(h.root, null, { notify() {}, reenable: h.reenable });
  await fetched.promise;
  const hold = reserve(h.writer, [h.project]);
  const fencing = h.writer.fenceProjectDeletion({ project: h.project, operationId: operationId(h.project, 0), expectedProjectEpoch: 0 });
  await turn();
  const beforeReady = fences;
  proceed.resolve(); await enabling.catch(() => {}); await hold.ready; await fencing;
  hold.release();
  assert.equal(beforeReady, 0, 'fence must not cross an unready deletion hold');
});

test('held rendering stays archived when unrelated retirement exhausts stale retries', supported, async t => {
  const h = setup(t); await h.writer.ready;
  const other = path.join(h.root, 'other'), otherEntry = archive.archivedEntry(null, other);
  h.db.setSetting('archivedProjects', { [h.entry]: { knownSessionIds: [] }, [otherEntry]: { knownSessionIds: [] } });
  const hold = reserve(h.writer, [h.project]); await hold.ready;
  const request = h.client.request.bind(h.client);
  let retries = 0;
  h.client.request = (name, ...args) => {
    if (name === 'retireArchivedEntries') { retries++; throw Object.assign(new Error('stale fixture'), { code: 'WRITER_STALE' }); }
    return request(name, ...args);
  };
  try {
    const listed = await h.writer.applyAndPersistArchived([h.root, other].map(projectPath => ({ projectPath, sessions: [{ sessionId: 'new' }] })), false);
    assert.equal(retries, 3, 'existing retry budget is retained');
    assert.equal(listed.some(project => project.projectPath === h.root), false, 'held rendering remains archived after unrelated stale retirement exhausts retries');
    assert.ok(h.db.getSetting('archivedProjects')[h.entry]);
  } finally { hold.release(); }
});

test('readonly fence lookup error falls back to worker proof', supported, async t => {
  const h = setup(t); await h.writer.ready;
  h.db.projectDeletion.hasFences = () => { throw new Error('SQLITE_BUSY'); };
  const request = h.client.request.bind(h.client), calls = [];
  h.client.request = async (name, ...args) => { calls.push(name); return request(name, ...args); };
  const result = await h.writer.applyAndPersistArchived([{ projectPath: h.root, sessions: [] }], false)
    .then(value => ({ value }), error => ({ error: error.message }));
  assert.equal(result.error, undefined, 'readonly lookup failure must use writer fallback');
  assert.ok(calls.includes('readProjectArchiveEpochs'));
});

test('list carries a relative remote cwd through without rejecting other identities', supported, async t => {
  const h = setup(t); await h.writer.ready; h.fence();
  const result = await h.writer.applyAndPersistArchived([{ remoteAlias: 'host', projectPath: 'relative/cwd', sessions: [] }, { projectPath: h.root, sessions: [] }], false)
    .then(value => ({ value }), error => ({ error: error.code }));
  assert.equal(result.error, undefined, 'unvalidated relative cwd must not reject the list');
  assert.equal(result.value.length, 2);
  assert.equal(result.value[0].projectPath, 'relative/cwd');
});

test('unfenced list reads do not send archive epoch requests', supported, async t => {
  const h = setup(t); await h.writer.ready;
  const request = h.client.request.bind(h.client), calls = [];
  h.client.request = async (name, ...args) => { calls.push(name); return request(name, ...args); };
  await h.writer.applyAndPersistArchived([{ projectPath: h.root, sessions: [] }], false);
  assert.equal(calls.includes('readProjectArchiveEpochs'), false, 'no writer round trip for an unfenced list');
  h.fence(); calls.length = 0;
  await h.writer.applyAndPersistArchived([{ projectPath: h.root, sessions: [] }], false).catch(() => {});
  assert.equal(calls.includes('readProjectArchiveEpochs'), true, 'existing fence requires fresh epoch proofs');
});

test('failed cancellation releases its lease only after old worker termination and recovery', supported, async t => {
  const h = setup(t), dead = deferred(), ports = [], sent = [];
  const client = createWriterWorkerClient({ heartbeatMs: 10000, workerFactory() {
    const port = new EventEmitter(); ports.push(port);
    port.terminate = () => ports.length === 1 ? dead.promise : Promise.resolve();
    port.postMessage = message => {
      sent.push(message);
      if (ports.length === 1 && message.command === 'beginOffer') { queueMicrotask(() => port.emit('error', new Error('worker crashed'))); return; }
      queueMicrotask(() => {
        const result = ['retireWorkflow', 'fenceWorkflow'].includes(message.command) ? true : h.commands[message.command](...message.args);
        port.emit('message', { id: message.id, result });
      });
    };
    queueMicrotask(() => port.emit('message', { ready: true, settings: [] }));
    return port;
  } });
  const fenceWorkflow = client.fenceWorkflow.bind(client);
  client.fenceWorkflow = id => { void fenceWorkflow(id).catch(() => {}); return Promise.reject(new Error('barrier unreachable')); };
  const writer = createSessionIndexWriter({ client, readonlyBackend: h.db }, {});
  t.after(() => client.terminate());
  await writer.ready;
  await assert.rejects(writer.reenableOfferedSchedules(h.root, null, { notify() {} }), /outcome unknown/);
  const hold = reserve(writer, [h.project]); let ready = false; hold.ready.then(() => { ready = true; });
  await turn(); assert.equal(ready, false, 'old worker must terminate before lease release');
  dead.resolve();
  const recovered = client.request('readProjectArchiveEpochs', [h.project]); await recovered;
  await turn();
  assert.equal(ready, true, 'dead worker cancellation lease must reconcile after recovery');
  await hold.ready; hold.release();
  assert.equal((await writer.reenableOfferedSchedules(h.root, null, { notify() {} })).ok, true);
  assert.ok(sent.length);
});

test('client failure retires sealed workflows once their active requests are gone', async () => {
  const ports = [];
  const client = createWriterWorkerClient({ heartbeatMs: 10000, workerFactory() {
    const port = new EventEmitter(); ports.push(port); port.postMessage = () => {}; port.terminate = async () => {};
    queueMicrotask(() => port.emit('message', { ready: true, settings: [] }));
    return port;
  } });
  try {
    await client.ready;
    const pending = client.requestForWorkflow('retiring', 'beginOffer', 'entry').catch(error => error);
    const fencing = client.fenceWorkflow('retiring').catch(error => error);
    client.retireWorkflow('retiring');
    ports[0].emit('error', new Error('crash'));
    await Promise.all([pending, fencing]);
    await turn();
    const next = client.requestForWorkflow('retiring', 'beginOffer', 'entry').then(() => 'admitted', error => error.code);
    const admission = await Promise.race([next, turn().then(() => 'pending')]);
    assert.equal(admission, 'pending', 'failed active request must not retain its retired seal');
  } finally { await client.terminate(); }
});

test('deletion reservation waits for every shared workflow and refuses new archive effects', supported, async t => {
  const h = setup(t); h.offer(); await h.writer.ready;
  const first = deferred(), second = deferred(); let callbacks = 0;
  t.after(() => { first.resolve(); second.resolve(); });
  const enabling = [first, second].map(blocker => h.writer.reenableOfferedSchedules(h.root, null, {
    notify() {}, async reenable(files) { callbacks++; await blocker.promise; return h.reenable(files); },
  }).catch(error => ({ error: error.code })));
  await turn(); await turn();
  assert.equal(callbacks, 2, 'ordinary workflows share their identity');
  const hold = reserve(h.writer, [h.project]); let ready = false; hold.ready.then(() => { ready = true; });
  const before = h.bytes();
  await assert.rejects(h.writer.archiveProjectFolders([{ projectPath: h.root }], {}, {}), { code: 'WORKFLOW_BUSY' });
  await assert.rejects(h.writer.reenableOfferedSchedules(h.root, null, { notify() {}, reenable: h.reenable }), { code: 'WORKFLOW_BUSY' });
  assert.deepEqual(h.bytes(), before, 'reservation refuses archive and offer filesystem effects');
  first.resolve(); await enabling[0]; await turn();
  assert.equal(ready, false, 'one shared workflow completing cannot release the other');
  second.resolve(); await enabling[1]; await hold.ready; hold.release();
});
