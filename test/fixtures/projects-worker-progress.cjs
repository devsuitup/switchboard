'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const db = require('../../db');
const cache = require('../../session-cache');
const { encodeProjectPath } = require('../../encode-project-path');

async function run() {
  const projectsDir = path.join(process.env.SWITCHBOARD_DATA_DIR, 'projects');
  const transcripts = [];
  const folders = [];
  for (const name of ['one', 'two', 'three']) {
    const project = path.join(process.env.SWITCHBOARD_DATA_DIR, name);
    const folder = encodeProjectPath(project);
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(path.join(projectsDir, folder), { recursive: true });
    const transcript = path.join(projectsDir, folder, name + '.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({ type: 'user', cwd: project, message: { role: 'user', content: name } }) + '\n');
    transcripts.push(transcript);
    folders.push({ folder, project });
  }
  db.setInitialScanComplete();
  cache.init({ PROJECTS_DIR: projectsDir, activeSessions: new Map(), getMainWindow: () => null, log: console, db });
  const worker = new Worker(path.join(__dirname, '../../workers/projects-query.js'), { workerData: { dbPath: db.DB_PATH, projectsDir } });
  let nextId = 0;
  const reconcile = () => new Promise((resolve, reject) => {
    const id = ++nextId;
    const progress = [];
    const receive = message => {
      if (message.id !== id) return;
      if (message.progress) {
        progress.push(message.progress);
        cache.applyProjectsWorkerEffects(message.progress);
        return;
      }
      worker.off('message', receive);
      worker.off('error', error);
      if (message.error) reject(new Error(message.error));
      else {
        cache.applyProjectsWorkerEffects(message.result);
        resolve({ progress, result: message.result });
      }
    };
    const error = err => { worker.off('message', receive); reject(err); };
    worker.on('message', receive);
    worker.once('error', error);
    worker.postMessage({ id, reconcile: true, activeSessions: [], remoteRoots: [] });
  });
  try {
    assert.equal((await reconcile()).progress.length, 3);
    assert.equal((await reconcile()).progress.length, 0, 'three unchanged folders must emit zero progress messages');
    fs.appendFileSync(transcripts[1], JSON.stringify({ type: 'user', cwd: folders[1].project, message: { role: 'user', content: 'changed' } }) + '\n');
    db.setFolderMeta(folders[1].folder, folders[1].project, 0);
    const changed = await reconcile();
    assert.equal(changed.progress.length, 1, 'one changed folder must emit exactly one progress message');
    assert.ok(changed.progress[0].effects.length > 0);
    assert.equal(db.getAllCached().length, 3);
    console.log('unchanged and changed folder progress verified');
  } finally { await worker.terminate(); db.closeDb(); }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
