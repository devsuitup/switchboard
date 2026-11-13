'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const openStore = require('./fixtures/conversation-store.cjs');
const { createSessionIndexWriter } = require('../session-index-writer');
const { createProjectsWorkerClient } = require('../projects-worker-client');
const { createProjectDeleteMain } = require('../src/main/projects/project-delete-main');
const { createProjectOperationGate } = require('../src/main/shared/project-operation-gate');
const { encodeProjectPath } = require('../encode-project-path');
const loadGetProjectsHandler = require('./get-projects-handler.cjs');
const supported = { skip: !openStore.supported && 'SQLite needs Node 22 or a matching native ABI' };

function freshCache() {
  const filename = require.resolve('../session-cache');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: createRequire(filename), module, exports: module.exports, __dirname: path.dirname(filename),
    process, console, Buffer, structuredClone, setTimeout, clearTimeout, setImmediate,
  }, { filename });
  return module.exports;
}

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-delete-'));
  const previousData = process.env.SWITCHBOARD_DATA_DIR;
  process.env.SWITCHBOARD_DATA_DIR = path.join(root, 'data');
  const db = openStore(), read = openStore({ readonly: true });
  const projectsDir = path.join(root, 'transcripts');
  const projects = ['doomed', 'kept'].map((name, i) => {
    const projectPath = path.join(root, name), folder = encodeProjectPath(projectPath);
    const sessionId = `12345678-1234-1234-1234-123456789ab${i}`;
    fs.mkdirSync(projectPath);
    fs.mkdirSync(path.join(projectsDir, folder), { recursive: true });
    const transcript = path.join(projectsDir, folder, sessionId + '.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({ type: 'user', sessionId, cwd: projectPath,
      timestamp: '2026-11-01T00:00:00.000Z', message: { role: 'user', content: name } }) + '\n');
    db.setFolderMeta(folder, projectPath, 0);
    db.upsertCachedSessions([{ sessionId, projectPath, folder, runtime: 'claude', summary: name,
      created: '2026-11-01T00:00:00.000Z', modified: '2026-11-01T00:00:00.000Z', messageCount: 1 }]);
    return { projectPath, folder, sessionId, transcript };
  });
  db.setInitialScanComplete();
  const worker = require('./fixtures/project-deletion-worker.cjs')(db);
  worker.client.requestForWorkflow = (_lease, ...args) => worker.client.request(...args);
  const writer = createSessionIndexWriter({ client: worker.client, readonlyBackend: db }, freshCache());
  await writer.ready;
  writer.initializeCache({ PROJECTS_DIR: projectsDir, activeSessions: new Map(), getMainWindow: () => null, log: console });
  const win = new EventEmitter(), wc = new EventEmitter(), handlers = new Map();
  win.webContents = wc; win.isDestroyed = wc.isDestroyed = () => false;
  wc.mainFrame = {}; wc.getURL = () => 'file:///switchboard/index.html';
  const gate = createProjectOperationGate();
  const deletion = createProjectDeleteMain({ writer, projectsDir, dataDir: path.join(root, 'data'),
    jobsDir: path.join(root, 'jobs'), activeSessions: new Map(), gate,
    runClaude: async () => ({ code: 0, stdout: '[]' }),
    cliSessionState: { getScheduleRunSnapshot: () => [], readStatusEvidence: async () => ({ known: true, live: null }),
      liveElsewhereV1Checked: async () => ({ known: true, live: null }) },
    ipcMain: { handle: (key, fn) => handlers.set(key, fn), removeHandler: key => handlers.delete(key) },
    getMainWindow: () => win,
  });
  deletion.attach(win); wc.emit('did-finish-load'); await deletion.startRecovery();
  const invoke = (name, input) => handlers.get(name)({ sender: wc, senderFrame: wc.mainFrame }, input);
  const remove = async () => {
    const preview = await invoke('preview-project-delete', { projectPath: projects[0].projectPath,
      options: { sessions: true, settings: false, schedules: false, transcripts: false, stopBackgroundJobs: false } });
    assert.ok(preview.token, JSON.stringify(preview));
    const result = await invoke('delete-project', { token: preview.token, fingerprint: preview.plan.fingerprint });
    assert.equal(result.state, 'committed', JSON.stringify(result));
    assert.equal(result.ok, true);
    const admission = gate.tryAdmit(projects[0].projectPath);
    assert.ok(admission, 'committed deletion must release the main hold'); admission.release();
    return result;
  };
  const requests = [], errors = [], accepted = [], clients = [];
  let beforeApply = async () => {};
  const makeList = (reconcile = true) => {
    const client = createProjectsWorkerClient({
      workerFactory: () => {
        const query = new EventEmitter(), port = new EventEmitter();
        query.terminate = async () => {};
        query.postMessage = message => { requests.push(message); port.emit('message', structuredClone(message)); };
        port.postMessage = message => query.emit('message', structuredClone(message));
        const filename = require.resolve('../workers/projects-query'), nativeRequire = createRequire(filename);
        vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
          require: name => name === 'node:worker_threads' ? { parentPort: port, workerData: { projectsDir, dbPath: db.DB_PATH } }
            : name === 'better-sqlite3' ? function Database() { return read.connection; }
              : name === '../session-cache' ? freshCache() : nativeRequire(name),
          console, Buffer, structuredClone,
        }, { filename });
        return query;
      },
      snapshot: () => ({ version: db.getProjectsRevision(), writerRevision: db.getSetting('_writer_revision') || 0, liveVersion: 'idle' }),
      apply: async result => {
        await beforeApply(result);
        try { return await writer.applyProjectsWorkerEffects(result); }
        catch (error) { errors.push(error.code); throw error; }
      },
      accepted: result => accepted.push(result),
    });
    clients.push(client);
    const handler = loadGetProjectsHandler({
      TRACE: { on: false }, projectsReconciledAt: reconcile ? 0 : Date.now(),
      getSetting: db.getSetting, isInitialScanComplete: () => true, isCachePopulated: () => true, isSearchIndexPopulated: () => true,
      backfillEntrypoints() {}, backfillCustomTitles() {}, projectsClient: client, writer,
      mergePlaceholderSessions: rows => rows, annotateRemoteAttachable: rows => rows,
      notifyRendererProjectsChanged() {},
    });
    return async mode => {
      let reply;
      await assert.doesNotReject(async () => { reply = await handler(null, mode); },
        'get-projects must survive a fenced project and retain unrelated projects');
      assert.equal(reply.projectsError, undefined, 'a project fence must not become a whole-list conflict');
      return reply;
    };
  };
  t.after(async () => {
    await Promise.all(clients.map(client => client.shutdown()));
    deletion.dispose(); read.closeDb(); db.closeDb();
    process.env.SWITCHBOARD_DATA_DIR = previousData;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { db, writer, projects, remove, makeList, requests, errors, accepted,
    beforeApply: callback => { beforeApply = callback; } };
}

for (const reconcile of [true, false]) test(`committed deletion followed by get-projects survives reconcile=${reconcile} and reload`, supported, async t => {
  const h = await setup(t);
  await h.remove();
  for (const list of [h.makeList(reconcile), h.makeList(reconcile)]) {
    for (const mode of [false, true, 'both']) {
      const reply = await list(mode);
      for (const rows of mode === 'both' ? [reply.defaultProjects, reply.allProjects] : [reply]) {
        assert.deepEqual(rows.map(row => row.projectPath), [h.projects[1].projectPath]);
        assert.ok(rows[0].sessions.some(row => row.sessionId === h.projects[1].sessionId));
      }
      assert.equal(h.db.getCachedSession(h.projects[0].sessionId), null, 'retained transcript must not resurrect deleted cache');
      assert.equal(h.db.getFolderMeta(h.projects[0].folder), null, 'fallback folder discovery must remain fenced');
    }
  }
  assert.ok(h.errors.includes('PROJECT_EPOCH_STALE'), 'the real writer must exercise its producer fence');
  assert.ok(fs.existsSync(h.projects[0].transcript));
  assert.ok(h.requests.length <= 12, 'one fresh read per fenced request must suffice');
});

test('deletion between project computation and publication fences old effects and refreshes the read', supported, async t => {
  const h = await setup(t);
  let removed = false;
  h.beforeApply(async result => {
    if (!removed && result.effects.length) { removed = true; await h.remove(); }
  });
  const reply = await h.makeList()('both');
  assert.ok(removed, 'deletion must interleave with real computed effects');
  assert.ok(h.errors.includes('PROJECT_EPOCH_STALE'));
  assert.deepEqual(reply.allProjects.map(row => row.projectPath), [h.projects[1].projectPath]);
  assert.equal(h.db.getCachedSession(h.projects[0].sessionId), null);
  assert.equal(h.accepted.length, 1, 'never publish the pre-deletion result');
  await h.writer.revealAddedProject(h.projects[0].projectPath);
  const reopened = await h.makeList()('both');
  assert.equal(reopened.allProjects.length, 2, 'a later producer must use the fresh reopened epoch');
  assert.ok(h.db.getCachedSession(h.projects[0].sessionId), 'fresh reindex after explicit re-add is writable');
});
