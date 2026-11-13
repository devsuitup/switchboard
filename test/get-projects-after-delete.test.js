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

test('worker suppresses deleted transcript writes across short cwd and long fence spellings', {
  skip: !openStore.supported ? 'SQLite needs Node 22 or a matching native ABI' : process.platform !== 'win32' && 'Windows 8.3 spelling',
}, async t => {
  const h = await setup(t);
  const project = h.projects[0];
  const long = fs.realpathSync.native(project.projectPath);
  const short = require('node:child_process').execFileSync('cmd.exe', ['/d', '/c', `for %I in ("${long}") do @echo %~sI`], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true }).trim();
  if (short.toLowerCase() === long.toLowerCase()) { t.skip('8.3 aliases are disabled on this Windows volume'); return; }
  assert.equal(fs.realpathSync.native(short), long, 'fixture must address the same real directory');
  assert.notEqual(short.toLowerCase(), long.toLowerCase(), 'fixture must exercise genuinely different spellings');
  await h.remove();
  const record = JSON.parse(fs.readFileSync(project.transcript, 'utf8'));
  record.cwd = short;
  fs.writeFileSync(project.transcript, JSON.stringify(record) + '\n');
  const shortFolder = path.join(path.dirname(path.dirname(project.transcript)), encodeProjectPath(short));
  fs.renameSync(path.dirname(project.transcript), shortFolder);
  const fence = h.db.connection.prepare('SELECT projectKey FROM project_delete_fences WHERE blocked = 1').get();
  assert.equal(JSON.parse(fence.projectKey)[1], long.replaceAll('\\', '/').toLowerCase(), 'deletion fence must retain the long canonical spelling');
  await h.makeList()('both');
  assert.deepEqual(h.errors, [], 'worker must suppress blocked writes before writer admission across path spellings');
  assert.equal(h.db.getCachedSession(project.sessionId), null);
  assert.equal(h.requests.length, 1, 'spelling differences must not cause worker conflict retries');
});

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
  const projects = ['doomed', 'a-before', 'z-after'].map((name, i) => {
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
    let handler;
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
      accepted: result => { accepted.push(result); handler.accepted(result); },
    });
    clients.push(client);
    handler = loadGetProjectsHandler({
      TRACE: { on: false }, projectsReconciledAt: reconcile ? 0 : Date.now(),
      getSetting: db.getSetting, isInitialScanComplete: () => true, isCachePopulated: () => true, isSearchIndexPopulated: () => true,
      backfillEntrypoints() {}, backfillCustomTitles() {}, projectsClient: client, writer,
      mergePlaceholderSessions: rows => rows, annotateRemoteAttachable: rows => rows,
      notifyRendererProjectsChanged() {},
    });
    const list = async mode => {
      let reply;
      await assert.doesNotReject(async () => { reply = await handler(null, mode); },
        'get-projects must survive a fenced project and retain unrelated projects');
      assert.equal(reply.projectsError, undefined, 'a project fence must not become a whole-list conflict');
      return reply;
    };
    list.reconciledAt = handler.reconciledAt;
    return list;
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
      const builds = h.requests.length;
      const reply = await list(mode);
      assert.equal(h.requests.length - builds, 1, 'a committed deletion must need exactly one build');
      for (const rows of mode === 'both' ? [reply.defaultProjects, reply.allProjects] : [reply]) {
        assert.deepEqual(rows.map(row => row.projectPath).sort(), h.projects.slice(1).map(row => row.projectPath).sort());
        for (const project of h.projects.slice(1)) {
          assert.ok(rows.find(row => row.projectPath === project.projectPath).sessions.some(row => row.sessionId === project.sessionId));
        }
      }
      assert.equal(h.db.getCachedSession(h.projects[0].sessionId), null, 'retained transcript must not resurrect deleted cache');
      assert.equal(h.db.getFolderMeta(h.projects[0].folder), null, 'fallback folder discovery must remain fenced');
    }
  }
  assert.deepEqual(h.errors, [], 'a snapshot containing the committed fence must not send doomed writes');
  assert.ok(fs.existsSync(h.projects[0].transcript));
  assert.equal(h.requests.length, 6);
});

test('committed deletion allows reconciliation before and after its folder and advances the main timestamp', supported, async t => {
  const h = await setup(t);
  await h.remove();
  for (const project of h.projects.slice(1)) h.db.deleteCachedSession(project.sessionId);
  const list = h.makeList();
  assert.equal(list.reconciledAt(), 0);
  await list('both');
  assert.ok(h.accepted[0].reconciled, 'reconciliation must complete despite the retained deleted folder');
  assert.ok(list.reconciledAt() > 0, 'the shipped acceptance callback must advance projectsReconciledAt');
  for (const project of h.projects.slice(1)) {
    assert.ok(h.db.getCachedSession(project.sessionId), 'folders on both sides of the deletion must reconcile');
  }
  await list('both');
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].reconcile, false, 'the next request must honor the completed reconciliation');
});

test('a deleted folder with no remaining ownership transcript cannot emit unowned reconcile writes', supported, async t => {
  const h = await setup(t);
  await h.remove();
  fs.unlinkSync(h.projects[0].transcript);
  await h.makeList()('both');
  assert.deepEqual(h.errors, [], 'an unresolved folder must not emit writes while the snapshot has a blocked fence');
  assert.equal(h.requests.length, 1);
  assert.equal(h.accepted[0].reconciled, true);
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
  assert.deepEqual(reply.allProjects.map(row => row.projectPath).sort(), h.projects.slice(1).map(row => row.projectPath).sort());
  assert.equal(h.db.getCachedSession(h.projects[0].sessionId), null);
  assert.equal(h.accepted.length, 1, 'never publish the pre-deletion result');
  await h.writer.revealAddedProject(h.projects[0].projectPath);
  const reopened = await h.makeList()('both');
  assert.equal(reopened.allProjects.length, 3, 'a later producer must use the fresh reopened epoch');
  assert.ok(h.db.getCachedSession(h.projects[0].sessionId), 'fresh reindex after explicit re-add is writable');
});
