'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Worker } = require('node:worker_threads');
const { createSessionIndexWriter } = require('../../session-index-writer');
const { createProjectsWorkerClient } = require('../../projects-worker-client');
const { encodeProjectPath } = require('../../encode-project-path');

async function run() {
  const warm = process.argv[2].startsWith('warm-');
  const mode = process.argv[2].replace(/^warm-/, '');
  let hold = false, held, notifyHeld;
  const waiting = new Promise(resolve => { notifyHeld = resolve; });
  const writer = createSessionIndexWriter({ workerFactory: () => {
    const worker = new Worker(path.join(__dirname, '../../workers/session-index-writer.js'));
    const emit = worker.emit.bind(worker);
    worker.emit = (name, message, ...rest) => {
      if (hold && name === 'message' && message.settings && message.id && !message.started) {
        hold = false;
        held = () => emit(name, message, ...rest);
        notifyHeld();
        return true;
      }
      return emit(name, message, ...rest);
    };
    return worker;
  } });
  let projectsClient, scan, queued;
  const root = process.env.SWITCHBOARD_DATA_DIR;
  try {
    await writer.ready;
    const db = require('../../db');
    const projectsDir = path.join(root, 'projects');
    fs.mkdirSync(projectsDir);
    const folder = encodeProjectPath(root);
    writer.initializeCache({ PROJECTS_DIR: projectsDir, activeSessions: new Map(), getMainWindow: () => null, log: console });
    await writer.upsertCachedSessions([{ sessionId: 'cached', folder, projectPath: root,
      summary: 'Already cached', modified: '2026-10-16T00:00:00.000Z', messageCount: 1 }]);
    if (warm) {
      await writer.setInitialScanComplete();
      await writer.upsertSearchEntries([{ id: 'cached', type: 'session', folder, title: 'Already cached', body: 'cached content' }]);
      assert.equal(db.isInitialScanComplete(), true);
      assert.equal(db.isSearchIndexPopulated(), true);
    }
    const snapshot = () => ({ version: db.getProjectsRevision(), liveVersion: 'stable', activeSessions: [], remoteRoots: [] });
    const source = fs.readFileSync(path.join(__dirname, '../../main.js'), 'utf8');
    const applyStart = source.indexOf('  apply: async result => {', source.indexOf('const projectsClient'));
    const applyEnd = source.indexOf('\n  },', applyStart) + 4;
    const context = vm.createContext({ writer, projectsSnapshot: snapshot, projectsReconciledAt: 0, Date });
    const apply = vm.runInContext('({' + source.slice(applyStart, applyEnd) + '}).apply', context);
    let applications = 0, reconciled = false, workers = 0;
    projectsClient = createProjectsWorkerClient({
      workerFactory: () => {
        const worker = new Worker(path.join(__dirname, '../../workers/projects-query.js'), { workerData: { dbPath: db.DB_PATH, projectsDir } });
        if (mode === 'abandoned' && ++workers === 2) {
          const emit = worker.emit.bind(worker);
          worker.emit = (name, message, ...rest) => {
            const emitted = emit(name, message, ...rest);
            if (name === 'message' && message.result) held?.();
            return emitted;
          };
        }
        return worker;
      },
      snapshot, timeoutMs: 1000,
      apply: result => {
        applications++;
        reconciled ||= result.reconciled;
        if ((mode === 'effects' || mode === 'abandoned') && applications === 1) result.effects.push({ name: 'setName', args: ['cached', 'Stale title'] });
        const pending = apply(result);
        if (mode !== 'held' && mode !== 'abandoned') held?.();
        return pending;
      },
    });
    let invoke;
    Object.assign(context, {
      ipcMain: { handle: (_name, fn) => { invoke = fn; } }, console, TRACE: { on: false },
      getSetting: db.getSetting, isInitialScanComplete: db.isInitialScanComplete,
      isCachePopulated: db.isCachePopulated, isSearchIndexPopulated: db.isSearchIndexPopulated,
      populateCacheViaWorker() {}, backfillEntrypoints() {}, backfillCustomTitles() {}, projectsClient,
      mergePlaceholderSessions: projects => projects, annotateRemoteAttachable: projects => projects,
    });
    const start = source.indexOf("ipcMain.handle('get-projects'");
    vm.runInContext(source.slice(start, source.indexOf('\n});', start) + 4), context);
    hold = true;
    scan = writer.writeScannedFolder({ folder: 'scan-one', projectPath: root, sessions: [], indexMtimeMs: 1 });
    await waiting;
    queued = writer.writeScannedFolder({ folder: 'scan-two', projectPath: root, sessions: [], indexMtimeMs: 2 });
    let scanFinished = false;
    scan.then(() => { scanFinished = true; });
    if (mode === 'abandoned') {
      await assert.rejects(projectsClient.request({ reconcile: false }), /projects worker timed out/);
      assert.equal(scanFinished, false);
    }
    const reply = await invoke(null, 'both');
    if (warm) assert.equal(reconciled, true, 'the first warm request must reconcile');
    assert.ok(reply.defaultProjects.flatMap(project => project.sessions).some(row => row.sessionId === 'cached'));
    assert.ok(reply.allProjects.flatMap(project => project.sessions).some(row => row.sessionId === 'cached'));
    if (mode === 'held') assert.equal(scanFinished, false, 'cached rows must arrive before the held scan ACK');
    if (mode === 'effects') {
      assert.ok(applications >= 2, 'queued effects must be recomputed after the scan revision changes');
      assert.notEqual(db.getMeta('cached')?.name, 'Stale title');
    }
    console.log('cached rows published before scan completion');
  } finally {
    held?.();
    await Promise.allSettled([scan, queued].filter(Boolean));
    await projectsClient?.shutdown();
    await writer.closeDb();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
