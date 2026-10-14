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
  const worker = new Worker(path.join(__dirname, '../../workers/projects-query.js'), {
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

run().catch(error => { console.error(error); process.exitCode = 1; });
