'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const Database = require('better-sqlite3');
const db = require('./writer-store.cjs');
const cache = require('../../session-cache');
const { encodeProjectPath } = require('../../encode-project-path');
const { getFolderIndexMtimeMs } = require('../../folder-index-state');

async function run() {
  const projectsDir = path.join(process.env.SWITCHBOARD_DATA_DIR, 'projects');
  const project = path.join(process.env.SWITCHBOARD_DATA_DIR, 'repo');
  const empty = path.join(process.env.SWITCHBOARD_DATA_DIR, 'empty');
  const folder = encodeProjectPath(project);
  fs.mkdirSync(path.join(projectsDir, folder), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(empty);
  fs.mkdirSync(path.join(projectsDir, encodeProjectPath(empty)));
  db.setFolderMeta(encodeProjectPath(empty), empty, 1);
  const transcript = path.join(projectsDir, folder, 'parent.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', cwd: project, timestamp: '2026-10-01T00:00:00.000Z', message: { role: 'user', content: 'Fixture prompt' } }) + '\n');
  const base = { folder, projectPath: project, summary: 'Fixture prompt', firstPrompt: 'Fixture prompt', created: '2026-10-01T00:00:00.000Z', modified: '2026-10-01T00:00:00.000Z', messageCount: 2, fileMtime: fs.statSync(transcript).mtime.toISOString() };
  db.upsertCachedSessions([
    { ...base, sessionId: 'parent' },
    { ...base, sessionId: 'archived' },
    { ...base, sessionId: 'child', parentSessionId: 'archived', subagentType: 'researcher' },
    { ...base, sessionId: 'mirror', mergedIntoSessionId: 'parent', bridgeSessionId: 'bridge', messageCount: 4 },
    { ...base, sessionId: 'sdk', entrypoint: 'sdk-cli' },
    { ...base, sessionId: 'remote', folder: 'host::-remote', projectPath: '/remote' },
    { ...base, sessionId: 'hidden', folder: '-hidden', projectPath: '/hidden' },
  ]);
  db.setArchived('archived', true);
  db.setSetting('global', { hiddenProjects: ['/hidden'], hideSdkSessions: true });
  db.setFolderMeta(folder, project, getFolderIndexMtimeMs(path.join(projectsDir, folder)));
  db.setInitialScanComplete();
  const activeSessions = new Map([
    ['terminal', { isPlainTerminal: true, projectPath: project, _openedAt: Date.parse(base.created) }],
    ['panel', { isPlainTerminal: true, projectPath: project, _openedAt: Date.parse(base.created), panelFor: 'archived' }],
    ['archived', { projectPath: project }],
  ]);
  cache.init({ PROJECTS_DIR: projectsDir, activeSessions, getMainWindow: () => null, log: console, db });
  const worker = new Worker(path.join(__dirname, '../../workers/projects-query.js'), { workerData: { dbPath: db.DB_PATH, projectsDir } });
  let nextId = 0;
  const request = reconcile => new Promise((resolve, reject) => {
    const id = ++nextId;
    const effects = [];
    const message = msg => {
      if (msg.id !== id) return;
      if (msg.progress) { effects.push(...msg.progress.effects); return; }
      worker.off('message', message);
      worker.off('error', error);
      msg.error ? reject(new Error(msg.error)) : resolve({ ...msg.result, effects: [...effects, ...msg.result.effects] });
    };
    const error = err => { worker.off('message', message); reject(err); };
    worker.on('message', message);
    worker.once('error', error);
    worker.postMessage({ id, reconcile, activeSessions: [...activeSessions], remoteRoots: [] });
  });
  try {
    for (const complete of [true, false]) {
      db.setSetting('initial_scan_complete', complete);
      const expected = { defaultProjects: cache.buildProjectsFromCache(false), allProjects: cache.buildProjectsFromCache(true) };
      const actual = await request(false);
      assert.deepEqual(actual.defaultProjects, expected.defaultProjects);
      assert.deepEqual(actual.allProjects, expected.allProjects);
      assert.equal(actual.rows, db.getAllCached().length);
      const visibleIds = actual.defaultProjects.flatMap(p => p.sessions.map(s => s.sessionId));
      const allIds = actual.allProjects.flatMap(p => p.sessions.map(s => s.sessionId));
      assert.ok(!visibleIds.includes('archived') && !visibleIds.includes('child'));
      assert.ok(allIds.includes('archived') && allIds.includes('child'));
      assert.ok(!allIds.includes('sdk') && !allIds.includes('mirror') && !allIds.includes('hidden') && !allIds.includes('panel'));
      assert.ok(allIds.includes('terminal') && allIds.includes('remote'));
      assert.equal(actual.allProjects.flatMap(p => p.sessions).find(s => s.sessionId === 'parent').messageCount, 6);
    }
    db.setInitialScanComplete();
    fs.appendFileSync(transcript, JSON.stringify({ type: 'user', cwd: project, timestamp: '2026-10-02T00:00:00.000Z', message: { role: 'user', content: 'Changed' } }) + '\n');
    db.setFolderMeta(folder, project, 0);
    const before = db.getAllCached();
    const copyDir = path.join(process.env.SWITCHBOARD_DATA_DIR, 'unreconciled');
    fs.mkdirSync(copyDir);
    const original = new Database(db.DB_PATH);
    await original.backup(path.join(copyDir, 'switchboard.db'));
    original.close();
    const actual = await request(true);
    assert.deepEqual(db.getAllCached(), before, 'the worker must not write SQLite');
    assert.ok(actual.effects.length > 0);
    cache.reconcileCacheFromFilesystem();
    assert.deepEqual(actual.defaultProjects, cache.buildProjectsFromCache(false));
    assert.deepEqual(actual.allProjects, cache.buildProjectsFromCache(true));
    process.env.SWITCHBOARD_DATA_DIR = copyDir;
    delete require.cache[require.resolve('./writer-store.cjs')];
    const workerDb = require('./writer-store.cjs');
    cache.init({ PROJECTS_DIR: projectsDir, activeSessions, getMainWindow: () => null, log: console, db: workerDb });
    cache.resetProjectsWorkerRetainedRows();
    if (process.env.PROJECTS_WORKER_DROP_WRITE) actual.effects = actual.effects.filter(effect => effect.name !== 'upsertCachedSessions');
    cache.applyProjectsWorkerEffects(actual);
    assert.deepEqual(workerDb.getAllCached().sort((a, b) => a.sessionId.localeCompare(b.sessionId)), db.getAllCached().sort((a, b) => a.sessionId.localeCompare(b.sessionId)), 'session_cache effects must match on the unreconciled copy');
    assert.deepEqual(workerDb.getAllFolderMeta(), db.getAllFolderMeta(), 'cache_meta effects must match on the unreconciled copy');
    assert.deepEqual(actual.defaultProjects, cache.buildProjectsFromCache(false));
    assert.deepEqual(actual.allProjects, cache.buildProjectsFromCache(true));
    assert.equal(cache.releaseLiveSession('archived'), false);
    activeSessions.delete('archived');
    assert.equal(cache.releaseLiveSession('archived'), true);
    assert.equal(workerDb.getCachedSession('archived'), null);
    workerDb.closeDb();
    console.log('equivalence verified');
  } finally {
    await worker.terminate();
    db.closeDb();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
