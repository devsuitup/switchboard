'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const electron = require('electron');
const appDir = path.join(__dirname, '..');

function run(code, root) {
  const result = spawnSync(electron, ['-e', code], { cwd: appDir, encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: root } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

const fixture = `
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const db = require('./db');
  const cache = require('./session-cache');
  const root = process.env.SWITCHBOARD_DATA_DIR;
  const projectsDir = path.join(root, 'projects');
  const { encodeProjectPath } = require('./encode-project-path');
  const folder = encodeProjectPath(root);
  fs.mkdirSync(path.join(projectsDir, folder), { recursive: true });
  const id = '11111111-1111-4111-8111-111111111111';
  const file = path.join(projectsDir, folder, id + '.jsonl');
  const modified = '2026-10-14T00:00:00.000Z';
  fs.writeFileSync(file, [
    { type: 'custom-title', sessionId: id, customTitle: 'launch (3)' },
    { type: 'user', sessionId: id, cwd: root, timestamp: modified, message: { content: 'fixture prompt' } }
  ].map(JSON.stringify).join('\\n') + '\\n');
  const descriptor = { sessionId: id, kind: 'interactive', name: 'registry rename', nameSource: 'user', cwd: root };
  cache.init({ PROJECTS_DIR: projectsDir, activeSessions: new Map(), getMainWindow: () => null,
    getLocalDescriptors: () => [descriptor], getLocalJobs: () => new Map([['aaaaaaaa', { state: 'working', name: 'launch' }]]),
    log: { info() {}, warn() {}, error() {}, debug() {} }, db });
  db.setFolderMeta(folder, root, 0);
  const displayed = () => cache.buildProjectsFromCache(false).flatMap(p => p.sessions)[0];
`;

test('SQLite retains the parsed custom title so launch names yield and Switchboard renames win', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bg-name-db-631-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  run(fixture + `
    const row = cache.readSessionFile(file, folder, root);
    db.upsertCachedSessions([row]);
    for (const kind of ['interactive', 'bg']) {
      descriptor.kind = kind;
      descriptor.jobId = kind === 'bg' ? 'aaaaaaaa' : null;
      db.setName(id, 'launch (3)');
      assert.equal(displayed().name, 'registry rename');
      db.setName(id, 'Switchboard rename');
      assert.equal(displayed().name, 'Switchboard rename');
    }
    assert.equal(db.getCachedSession(id).customTitle, 'launch (3)');
  `, root);
});

test('legacy SQLite title backfill preserves metadata and reads transcripts only in a worker', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bg-name-legacy-631-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  run(fixture + `
    db.upsertCachedSessions([cache.readSessionFile(file, folder, root)]);
    db.setName(id, 'launch (3)');
    db.setName('renamed', 'Switchboard rename');
    const Database = require('better-sqlite3');
    const sql = new Database(path.join(root, 'switchboard.db'));
    if (sql.prepare('PRAGMA table_info(session_cache)').all().some(c => c.name === 'customTitle')) {
      sql.exec('ALTER TABLE session_cache DROP COLUMN customTitle');
    }
    sql.close();
  `, root);
  run(`
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const db = require('./db');
    const cache = require('./session-cache');
    const root = process.env.SWITCHBOARD_DATA_DIR;
    const id = '11111111-1111-4111-8111-111111111111';
    cache.init({ PROJECTS_DIR: path.join(root, 'projects'), activeSessions: new Map(), getMainWindow: () => null,
      getLocalDescriptors: () => [{ sessionId: id, kind: 'interactive', name: 'registry rename', nameSource: 'user' }],
      log: { info() {}, warn() {}, error() {}, debug() {} }, db });
    const read = fs.readFileSync;
    fs.readFileSync = function(file, ...args) {
      assert.ok(!String(file).endsWith('.jsonl'), 'title backfill must not read a transcript on main');
      return read.call(this, file, ...args);
    };
    (async () => {
      await cache.backfillCustomTitles?.();
      assert.equal(cache.buildProjectsFromCache(false).flatMap(p => p.sessions)[0].name, 'registry rename');
      assert.equal(db.getMeta(id).name, 'launch (3)');
      assert.equal(db.getMeta('renamed').name, 'Switchboard rename');
      assert.equal(db.getCachedSession(id).customTitle, 'launch (3)');
    })().catch(err => { console.error(err); process.exitCode = 1; });
  `, root);
});

test('a stale title backfill cannot replace a refreshed cache row or its Switchboard rename', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bg-name-race-631-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  run(fixture + `
    const row = cache.readSessionFile(file, folder, root);
    db.upsertCachedSessions([row]);
    db.setName(id, 'Switchboard rename');
    db.setCachedCustomTitles([{ sessionId: id, customTitle: 'stale', fileMtime: row.fileMtime }]);
    assert.equal(db.getCachedSession(id).customTitle, 'launch (3)');
    const Database = require('better-sqlite3');
    const sql = new Database(path.join(root, 'switchboard.db'));
    sql.prepare('UPDATE session_cache SET customTitle = NULL, fileMtime = ? WHERE sessionId = ?').run('new mtime', id);
    sql.close();
    db.setCachedCustomTitles([{ sessionId: id, customTitle: 'stale', fileMtime: row.fileMtime }]);
    assert.equal(db.getCachedSession(id).customTitle, null);
    assert.equal(displayed().name, 'Switchboard rename');
  `, root);
});


test('an empty custom-title backfill is memoized without rescanning cached rows on reload', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bg-name-empty-631-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  run(fixture + `
    db.upsertCachedSessions([cache.readSessionFile(file, folder, root)]);
    let reads = 0;
    cache.init({ PROJECTS_DIR: projectsDir, activeSessions: new Map(), getMainWindow: () => null,
      log: console, db: { ...db,
        getAllCached: () => assert.fail('title backfill must not load every cache row'),
        getCachedMissingCustomTitle: () => { reads++; return db.getCachedMissingCustomTitle(); } } });
    (async () => {
      const first = cache.backfillCustomTitles();
      await first;
      assert.equal(cache.backfillCustomTitles(), first);
      assert.equal(reads, 0, 'the worker must read missing-title candidates instead of main');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `, root);
});

test('header-only upserts leave unknown titles eligible for backfill and preserve existing titles', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bg-name-refresh-631-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  run(fixture + `
    const row = cache.readSessionFile(file, folder, root);
    delete row.customTitle;
    db.upsertCachedSessions([row]);
    assert.equal(db.getCachedSession(id).customTitle, null, 'an undefined title remains unknown');
    db.upsertCachedSessions([{ ...row, modified: '2026-10-14T01:00:00.000Z' }]);
    assert.equal(db.getCachedSession(id).customTitle, null, 'header refresh does not mark a legacy title absent');
    fs.utimesSync(file, new Date('2026-10-14T01:00:00.000Z'), new Date('2026-10-14T01:00:00.000Z'));
    (async () => {
      await cache.refreshFolder(folder);
      assert.equal(db.getCachedSession(id).customTitle, null, 'the public header refresh preserves unknown titles');
      await cache.backfillCustomTitles();
      assert.equal(db.getCachedSession(id).customTitle, 'launch (3)');
      db.upsertCachedSessions([row]);
      assert.equal(db.getCachedSession(id).customTitle, 'launch (3)', 'an omitted title does not overwrite a known title');
      fs.utimesSync(file, new Date('2026-10-14T02:00:00.000Z'), new Date('2026-10-14T02:00:00.000Z'));
      await cache.refreshFolder(folder);
      assert.equal(db.getCachedSession(id).customTitle, 'launch (3)', 'the public header refresh preserves known titles');
      db.upsertCachedSessions([{ ...row, customTitle: '' }]);
      assert.equal(db.getCachedSession(id).customTitle, '', 'a full scan can record a known absence');
      cache.shutdownIndexing();
      db.closeDb();
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `, root);
});

test('title backfill selects only narrow unknown top-level rows and excludes known titles and subagents', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bg-name-query-631-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  run(fixture + `
    const row = cache.readSessionFile(file, folder, root);
    db.upsertCachedSessions([
      { ...row, customTitle: undefined },
      { ...row, sessionId: 'known', customTitle: 'known' },
      { ...row, sessionId: 'absent', customTitle: '' },
      { ...row, sessionId: 'child', parentSessionId: id, agentId: 'agent', customTitle: undefined },
    ]);
    const candidates = db.getCachedMissingCustomTitle();
    assert.equal(candidates.length, 1);
    assert.deepEqual(candidates[0], { sessionId: id, folder, fileMtime: row.fileMtime });
    cache.init({ PROJECTS_DIR: projectsDir, activeSessions: new Map(), getMainWindow: () => null, log: console,
      db: { ...db, getAllCached: () => assert.fail('title backfill must use the narrow query') } });
    (async () => {
      await cache.backfillCustomTitles();
      assert.equal(db.getCachedSession(id).customTitle, 'launch (3)');
      assert.equal(db.getCachedSession('child').customTitle, null);
      db.closeDb();
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `, root);
});

test('the readonly projects worker applies live background state to both views and preserves Switchboard names', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bg-worker-631-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  run(fixture + `
    const { Worker } = require('node:worker_threads');
    db.upsertCachedSessions([cache.readSessionFile(file, folder, root)]);
    db.setName(id, 'launch (3)');
    descriptor.kind = 'bg';
    descriptor.jobId = 'aaaaaaaa';
    const pendingId = '22222222-2222-4222-8222-222222222222';
    const pending = { sessionId: pendingId, kind: 'bg', jobId: 'bbbbbbbb', cwd: root, name: 'pending' };
    const jobs = new Map([['aaaaaaaa', { state: 'working', name: 'launch' }], ['bbbbbbbb', { state: 'blocked' }]]);
    const worker = new Worker(path.join(process.cwd(), 'workers/projects-query.js'), { workerData: { dbPath: db.DB_PATH, projectsDir } });
    let nextId = 0;
    const request = (descriptors = [descriptor, pending], activeSessions = []) => new Promise((resolve, reject) => {
      const requestId = ++nextId;
      const onMessage = message => {
        if (message.id !== requestId) return;
        worker.off('message', onMessage);
        worker.off('error', onError);
        message.error ? reject(new Error(message.error)) : resolve(message.result);
      };
      const onError = error => { worker.off('message', onMessage); reject(error); };
      worker.on('message', onMessage);
      worker.once('error', onError);
      worker.postMessage({ id: requestId, localDescriptors: descriptors, localJobs: [...jobs], activeSessions, remoteRoots: [] });
    });
    (async () => {
      try {
        let result = await request();
        for (const view of [result.defaultProjects, result.allProjects]) {
          const rows = view.flatMap(project => project.sessions);
          assert.equal(rows.find(row => row.sessionId === id).bgJobId, 'aaaaaaaa');
          assert.equal(rows.find(row => row.sessionId === id).name, 'registry rename');
          assert.equal(rows.find(row => row.sessionId === pendingId).descriptorOnly, true);
        }
        db.setName(id, 'Switchboard rename');
        result = await request();
        assert.equal(result.defaultProjects.flatMap(project => project.sessions).find(row => row.sessionId === id).name, 'Switchboard rename');
        jobs.get('aaaaaaaa').state = 'completed';
        jobs.get('bbbbbbbb').state = 'completed';
        result = await request();
        const finished = result.defaultProjects.flatMap(project => project.sessions);
        assert.equal(finished.find(row => row.sessionId === id).bgJobId, undefined);
        assert.ok(!finished.some(row => row.sessionId === pendingId));
        jobs.get('bbbbbbbb').state = 'working';
        result = await request([], [['attach-tab', { isAttach: true, attachJobId: 'bbbbbbbb', realSessionId: pendingId, cwd: root }]]);
        assert.equal(result.defaultProjects.flatMap(project => project.sessions).find(row => row.sessionId === pendingId).bgJobId, 'bbbbbbbb');
        db.setArchived(id, true);
        result = await request();
        assert.ok(!result.defaultProjects.flatMap(project => project.sessions).some(row => row.sessionId === id));
        assert.ok(result.allProjects.flatMap(project => project.sessions).some(row => row.sessionId === id));
        assert.equal(db.getCachedSession(pendingId), null);
        assert.equal(db.getMeta(id).name, 'Switchboard rename');
      } finally { await worker.terminate(); db.closeDb(); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `, root);
});
