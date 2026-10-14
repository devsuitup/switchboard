'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const db = require('../../db');
const cache = require('../../session-cache');
const { encodeProjectPath } = require('../../encode-project-path');
const { createProjectsWorkerClient } = require('../../projects-worker-client');

async function run() {
  if (process.env.PROJECTS_WORKER_HUNG_RECONCILE) return runHungReconcile();
  const projectsDir = path.join(process.env.SWITCHBOARD_DATA_DIR, 'projects');
  for (const name of ['one', 'two']) {
    const project = path.join(process.env.SWITCHBOARD_DATA_DIR, name);
    const folder = encodeProjectPath(project);
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(path.join(projectsDir, folder), { recursive: true });
    fs.writeFileSync(path.join(projectsDir, folder, name + '.jsonl'), JSON.stringify({ type: 'user', cwd: project, timestamp: '2026-10-01T00:00:00.000Z', message: { role: 'user', content: name } }) + '\n');
  }
  db.setInitialScanComplete();
  cache.init({ PROJECTS_DIR: projectsDir, activeSessions: new Map(), getMainWindow: () => null, log: console, db });
  const worker = new Worker(path.join(__dirname, 'projects-worker-delayed.cjs'), {
    workerData: { dbPath: db.DB_PATH, projectsDir, reconcileFolderDelayMs: 200 },
  });
  let reconciledAt = 0;
  const client = createProjectsWorkerClient({
    workerFactory: () => worker,
    snapshot: () => ({ version: db.getProjectsRevision(), activeSessions: [], remoteRoots: [] }),
    apply: result => { cache.applyProjectsWorkerEffects(result); if (result.reconciled) reconciledAt = Date.now(); },
    timeoutMs: 100,
  });
  try {
    const expired = assert.rejects(client.request({ reconcile: true }), /timed out/);
    expired.catch(() => {});
    const firstFolder = new Promise(resolve => worker.on('message', message => { if (message.progress) resolve(); }));
    const completed = new Promise((resolve, reject) => {
      worker.on('message', message => { if (message.result) resolve(message.result); if (message.error) reject(new Error(message.error)); });
      worker.once('error', reject);
    });
    await firstFolder;
    assert.ok(db.getAllCached().length >= 1, 'completed folder writes must reach main before the sweep reply');
    await expired;
    assert.equal(reconciledAt, 0);
    await completed;
    assert.equal(db.getAllCached().length, 2);
    assert.ok(reconciledAt > 0, 'a sweep slower than the caller timeout must still advance reconciliation');
    const result = await client.request({ reconcile: false, measureBytes: true });
    assert.equal(result.defaultProjects.length, 2);
    assert.equal(result.reconciled, false);
    assert.equal(result.replyBytes.both, Buffer.byteLength(JSON.stringify({ defaultProjects: result.defaultProjects, allProjects: result.allProjects })));
    console.log('slow reconcile progress verified');
  } finally { client.shutdown(); await worker.terminate(); db.closeDb(); }
}

async function runHungReconcile() {
  const projectsDir = path.join(process.env.SWITCHBOARD_DATA_DIR, 'projects');
  const project = path.join(process.env.SWITCHBOARD_DATA_DIR, 'hung');
  const folder = encodeProjectPath(project);
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.join(projectsDir, folder), { recursive: true });
  fs.writeFileSync(path.join(projectsDir, folder, 'hung.jsonl'), JSON.stringify({ type: 'user', cwd: project, message: { role: 'user', content: 'hung' } }) + '\n');
  db.setInitialScanComplete();
  cache.init({ PROJECTS_DIR: projectsDir, activeSessions: new Map(), getMainWindow: () => null, log: console, db });
  const workers = [];
  let firstFolder;
  const progress = new Promise(resolve => { firstFolder = resolve; });
  const client = createProjectsWorkerClient({
    workerFactory: () => {
      const worker = new Worker(path.join(__dirname, 'projects-worker-delayed.cjs'), {
        workerData: { dbPath: db.DB_PATH, projectsDir, reconcileFolderDelayMs: workers.length ? 0 : 5000 },
      });
      workers.push(worker);
      worker.on('message', message => { if (message.progress) firstFolder(); });
      return worker;
    },
    snapshot: () => ({ version: db.getProjectsRevision(), activeSessions: [], remoteRoots: [] }),
    apply: result => cache.applyProjectsWorkerEffects(result),
    timeoutMs: 4000,
    reconcileTimeoutMs: 1500,
  });
  const guard = setTimeout(() => firstFolder(), 3000);
  let deadlineGuard;
  try {
    const first = client.request({ reconcile: true });
    first.catch(() => {});
    await progress;
    clearTimeout(guard);
    assert.equal(db.getAllCached().length, 1, 'completed folder effects survive worker termination');
    const pending = client.request({ reconcile: false });
    pending.catch(() => {});
    const settled = await Promise.race([
      Promise.allSettled([first, pending]),
      new Promise(resolve => { deadlineGuard = setTimeout(() => resolve(null), 2200); }),
    ]);
    assert.ok(settled, 'hung reconcile must reject active and pending waiters at the hard ceiling');
    for (const result of settled) {
      assert.equal(result.status, 'rejected');
      assert.match(result.reason.message, /reconcile timed out/);
    }
    const recovered = await client.request({ reconcile: false });
    assert.equal(workers.length, 2, 'the next request must use a fresh worker');
    assert.equal(recovered.defaultProjects.length, 1);
    console.log('hung reconcile ceiling verified');
  } finally {
    clearTimeout(guard);
    clearTimeout(deadlineGuard);
    client.shutdown();
    await Promise.all(workers.map(worker => worker.terminate()));
    db.closeDb();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
