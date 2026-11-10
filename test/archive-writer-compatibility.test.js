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
const archive = require('../archived-projects');
const openStore = require('./fixtures/conversation-store.cjs');
const loadGetProjectsHandler = require('./get-projects-handler.cjs');
const supported = { skip: !openStore.supported && 'native SQLite ABI differs; node:sqlite requires Node 22' };

async function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'archive-compat-')));
  const previous = process.env.SWITCHBOARD_DATA_DIR;
  process.env.SWITCHBOARD_DATA_DIR = path.join(root, 'db');
  const db = openStore(), messages = [], workerPort = new EventEmitter(), clientPort = new EventEmitter();
  workerPort.postMessage = message => queueMicrotask(() => clientPort.emit('message', structuredClone(message)));
  clientPort.postMessage = message => {
    messages.push(structuredClone(message));
    queueMicrotask(() => workerPort.emit('message', structuredClone(message)));
  };
  clientPort.terminate = async () => {};
  const filename = require.resolve('../workers/session-index-writer'), nativeRequire = createRequire(filename);
  const client = createWriterWorkerClient({ workerFactory: () => clientPort });
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: name => name === 'node:worker_threads' ? { parentPort: workerPort }
      : name === '../session-index-store' ? { openSessionIndexStore: () => db } : nativeRequire(name),
    setInterval: () => ({ unref() {} }), clearInterval() {},
  }, { filename });
  const writer = createSessionIndexWriter({ client, readonlyBackend: db }, {});
  t.after(async () => {
    await client.terminate(); db.closeDb();
    if (previous === undefined) delete process.env.SWITCHBOARD_DATA_DIR;
    else process.env.SWITCHBOARD_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  await writer.ready;
  const projects = [{ projectPath: path.join(root, 'project'), sessions: [{ sessionId: 'new', summary: 'PROJECT_PAYLOAD' }] }];
  const invoke = loadGetProjectsHandler({
    TRACE: { on: false }, projectsReconciledAt: Date.now(), getSetting: db.getSetting,
    normalizeHosts: () => [], parseFolderKey: require('../src/main/remote/remote-hosts').parseFolderKey,
    isInitialScanComplete: () => true, isCachePopulated: () => true, isSearchIndexPopulated: () => true,
    populateCacheViaWorker: () => assert.fail('warm cache populated'), backfillEntrypoints() {}, backfillCustomTitles() {},
    writer, projectsClient: { request: async () => structuredClone({ defaultProjects: projects, allProjects: projects, rows: 1 }) },
    mergePlaceholderSessions: rows => rows, annotateRemoteAttachable: rows => rows, notifyRendererProjectsChanged() {},
  });
  return { root, db, writer, messages, projects, invoke };
}

test('get-projects retirement keeps the legacy command shape without an epoch proof', supported, async t => {
  const h = await setup(t), entry = archive.archivedEntry(null, h.projects[0].projectPath);
  const other = archive.archivedEntry(null, path.join(h.root, 'other'));
  await h.writer.setSetting('archivedProjects', { [entry]: { archivedAt: 12, knownSessionIds: [] } });
  await h.writer.setSetting('scheduleReenableOffers', { [other]: { disabledSchedules: ['other.md'] } });
  const snapshot = { archivedProjects: structuredClone(h.db.getSetting('archivedProjects')), hiddenProjects: [], hiddenProjectScopes: {},
    scheduleReenableOffers: structuredClone(h.db.getSetting('scheduleReenableOffers')) };
  h.messages.length = 0;
  const reply = await h.invoke(null, 'both');
  assert.equal(reply.defaultProjects.length, 1);
  assert.deepEqual(structuredClone(h.db.getSetting('archivedProjects')), {});
  assert.deepEqual(structuredClone(h.db.getSetting('scheduleReenableOffers')), snapshot.scheduleReenableOffers);
  assert.deepEqual(h.messages.map(({ command, args }) => ({ command, args })), [
    { command: 'retireArchivedEntries', args: [[entry], snapshot] },
  ], 'unfenced retirement sends exactly the two legacy arguments');
  assert.ok(!JSON.stringify(h.messages).includes('PROJECT_PAYLOAD'));
});

for (const projectPath of ['/', '/srv/project', 'C:/remote/project']) {
  test(`get-projects remote retirement preserves the exact key and offers once: ${projectPath}`, supported, async t => {
    const h = await setup(t), entry = archive.archivedEntry('host', projectPath);
    const other = archive.archivedEntry(null, path.join(h.root, 'other'));
    const schedule = path.join(h.root, 'remote-schedule.md');
    fs.writeFileSync(schedule, '---\nname: Remote task\nenabled: false\n---\n');
    await h.writer.setSetting('archivedProjects', {
      [entry]: { archivedAt: 12, knownSessionIds: [], disabledSchedules: [schedule] }, [other]: { archivedAt: 13 },
    });
    h.projects.splice(0, 1, { projectPath, remoteAlias: 'host', sessions: [{ sessionId: 'new' }] });
    h.messages.length = 0;
    const outcome = await h.invoke(null, false).then(value => ({ value }), error => ({ error: error.code }));
    assert.equal(outcome.error, undefined, 'remote archive identity must not reject get-projects');
    assert.deepEqual(structuredClone(h.db.getSetting('archivedProjects')), { [other]: { archivedAt: 13 } });
    assert.deepEqual(structuredClone(h.db.getSetting('scheduleReenableOffers')), { [entry]: { archivedAt: 12, disabledSchedules: [schedule] } });
    assert.deepEqual(JSON.parse(JSON.stringify(outcome.value[0].reenableOffer)), { names: ['Remote task'] });
    assert.equal(h.messages.filter(m => m.command === 'retireArchivedEntries').length, 1);
    h.messages.length = 0;
    await h.invoke(null, false);
    assert.deepEqual(h.messages, [], 'subsequent list neither retires nor creates another offer');
  });
}

test('invalid dismissal is a no-op through both facade and queued writer command', supported, async t => {
  const h = await setup(t), project = h.projects[0].projectPath, entry = archive.archivedEntry(null, project);
  const other = archive.archivedEntry(null, path.join(h.root, 'other'));
  const offers = { [entry]: { disabledSchedules: ['first.md'] }, [other]: { disabledSchedules: ['other.md'] } };
  await h.writer.setSetting('scheduleReenableOffers', offers);
  let notifications = 0;
  for (const invalid of ['', null, undefined, 42]) {
    const outcome = await h.writer.dismissReenableOffer(invalid, '-folder', { notify() { notifications++; } })
      .then(value => ({ value }), error => ({ error: error.code }));
    assert.equal(outcome.error, undefined, 'invalid dismissal must return its legacy error instead of throwing');
    assert.deepEqual(outcome.value, { error: 'invalid project path' });
    assert.deepEqual(structuredClone(h.db.getSetting('scheduleReenableOffers')), offers);
  }
  assert.equal(notifications, 0);
  assert.deepEqual(await h.writer.dismissReenableOffer(project, '-folder', { notify() { notifications++; } }), { ok: true });
  assert.equal(notifications, 1);
  assert.deepEqual(structuredClone(h.db.getSetting('scheduleReenableOffers')), { [other]: offers[other] });
});

test('remote root guards retain supplied epoch proofs and refuse a later deletion fence', supported, async t => {
  const h = await setup(t), entry = archive.archivedEntry('host', '/'), key = JSON.stringify(['host', '/']);
  h.db.projectDeletion.setFence(key, 2, null, 0);
  await h.writer.setSetting('archivedProjects', { [entry]: { knownSessionIds: [] } });
  h.projects.splice(0, 1, { projectPath: '/', remoteAlias: 'host', sessions: [{ sessionId: 'new' }] });
  h.messages.length = 0;
  await h.invoke(null, false);
  const retirement = h.messages.find(message => message.command === 'retireArchivedEntries');
  assert.equal(retirement.args.length, 3, 'an actual proof must remain on the wire');
  assert.deepEqual(retirement.args[2], [{ project: { alias: 'host', projectPath: '/' }, epoch: 2 }]);
  await assert.doesNotReject(h.writer.hideProject(entry, 'archive'), 'remote root workflow must decode its empty key suffix');
  assert.deepEqual(structuredClone(h.db.getSetting('global').hiddenProjects), [entry]);
  h.db.projectDeletion.setFence(key, 3, null, 1);
  await h.writer.setSetting('archivedProjects', { [entry]: { knownSessionIds: [] } });
  await assert.doesNotReject(h.writer.applyAndPersistArchived(h.projects, false));
  assert.ok(h.db.getSetting('archivedProjects')[entry], 'blocked root retirement retains its exact archive key');
});
