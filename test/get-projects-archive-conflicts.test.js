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

async function setup(t, hooks) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'archive-compat-')));
  const previous = process.env.SWITCHBOARD_DATA_DIR;
  process.env.SWITCHBOARD_DATA_DIR = path.join(root, 'db');
  const db = openStore(), messages = [], workerPort = new EventEmitter(), clientPort = new EventEmitter();
  workerPort.postMessage = message => queueMicrotask(() => clientPort.emit('message', structuredClone(message)));
  const post = message => queueMicrotask(() => workerPort.emit('message', structuredClone(message)));
  clientPort.postMessage = message => {
    messages.push(structuredClone(message));
    hooks.beforePost?.(message, post);
    post(message);
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
    await writer.drain();
    await new Promise(resolve => setImmediate(resolve));
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

for (const protection of ['none', 'held', 'blocked']) {
  test(`three retirement conflicts return projects without persisting a stale archive decision: ${protection}`, supported, async t => {
    const hooks = {}, h = await setup(t, hooks), project = h.projects[0].projectPath;
    const entry = archive.archivedEntry(null, project);
    const protectedPath = path.join(h.root, 'protected'), protectedEntry = archive.archivedEntry(null, protectedPath);
    const protectedArchive = protection === 'none' ? {} : { [protectedEntry]: { archivedAt: 10, knownSessionIds: [] } };
    if (protection !== 'none') {
      h.projects.push({ projectPath: protectedPath, sessions: [{ sessionId: 'new-protected' }] });
      if (protection === 'held') {
        const hold = h.writer.reserveProjectDeletion([{ alias: null, projectPath: protectedPath }]);
        await hold.ready;
        t.after(() => hold.release());
      } else {
        const { archiveProjectIdentity } = require('../src/main/projects/project-archive-workflow');
        h.db.projectDeletion.setFence(archiveProjectIdentity({ alias: null, projectPath: protectedPath }).key, 1, null, 1);
      }
    }
    await h.writer.setSetting('archivedProjects', { [entry]: { archivedAt: 12, knownSessionIds: [] }, ...protectedArchive });
    let conflicts = 0;
    hooks.beforePost = (message, post) => {
      if (message.command !== 'retireArchivedEntries') return;
      post({ id: -1, command: 'setSetting', args: ['archivedProjects', {
        [entry]: { archivedAt: 12 + ++conflicts, knownSessionIds: [] }, ...protectedArchive,
      }] });
    };
    h.messages.length = 0;
    const reply = await h.invoke(null, false);
    assert.equal(reply.length, 1);
    assert.equal(reply[0].projectPath, project);
    assert.equal(conflicts, 3);
    assert.equal(h.messages.filter(message => message.command === 'retireArchivedEntries').length, 3);
    assert.equal(h.messages.length, protection === 'blocked' ? 4 : 3);
    assert.deepEqual(structuredClone(h.db.getSetting('archivedProjects')), {
      [entry]: { archivedAt: 15, knownSessionIds: [] }, ...protectedArchive,
    });
    assert.equal(h.db.getSetting('scheduleReenableOffers'), null);
    hooks.beforePost = () => {};
    const clean = await h.invoke(null, false);
    assert.equal(clean.length, 1);
    assert.equal(clean[0].projectPath, project);
    assert.deepEqual(structuredClone(h.db.getSetting('archivedProjects')), protectedArchive);
  });
}
