'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const openStore = require('./fixtures/conversation-store.cjs');

const ID_A = '01a03f6c-fdf9-7c83-86e3-c388f81d765c';
const ID_B = '01a03f6c-fdf9-7c83-86e3-c388f81d765d';
const FOLDER = 'codex/2026/08/26';

function rollout(cwd, turns, extra = [], originator = 'codex_cli_rs') {
  const lines = [
    { timestamp: '2026-08-26T10:00:00.000Z', type: 'session_meta', payload: { id: 'root', cwd, originator } },
    { timestamp: '2026-08-26T10:00:00.200Z', type: 'turn_context', payload: { model: 'gpt-6', cwd } },
  ];
  let t = 1;
  for (const [role, text] of turns) {
    lines.push({ timestamp: `2026-08-26T10:00:${String(t++).padStart(2, '0')}.000Z`, type: 'response_item',
      payload: { type: 'message', role, content: [{ type: 'text', text }] } });
  }
  return lines.concat(extra).map(l => JSON.stringify(l)).join('\n') + '\n';
}

function fakeDb() {
  const rows = new Map(), meta = new Map(), metrics = new Map(), search = new Map(), settings = new Map();
  const db = {
    getCachedByFolder: key => [...rows.values()].filter(r => r.folder === key),
    getAllCached: () => [...rows.values()], getAllMeta: () => new Map(), getAllFolderMeta: () => meta,
    getFolderMeta: key => meta.get(key), getSetting: key => settings.get(key), setSetting: (key, value) => settings.set(key, value),
    getMeta: () => null, setName() {}, isInitialScanComplete: () => true,
    setFolderMeta: (key, projectPath, indexMtimeMs) => meta.set(key, { folder: key, projectPath, indexMtimeMs }),
    upsertCachedSessions: fresh => fresh.forEach(r => rows.set(r.sessionId, { ...rows.get(r.sessionId), ...r })),
    deleteCachedSession: id => { rows.delete(id); metrics.delete(id); },
    deleteCachedFolder: key => { for (const r of rows.values()) if (r.folder === key) { rows.delete(r.sessionId); metrics.delete(r.sessionId); } },
    deleteSearchFolder: key => { for (const r of search.values()) if (r.folder === key) search.delete(r.id); },
    deleteSearchSession: id => search.delete(id),
    upsertSearchEntries: entries => entries.forEach(e => search.set(e.id, e)),
    replaceSessionMetrics: (id, daily) => metrics.set(id, daily), touchCachedModified() {}, setCachedFileSize() {},
  };
  return { db, rows, meta, metrics, search, settings };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-index-'));
  const projectsDir = path.join(root, 'projects');
  const { home: codexHome } = require('./fixtures/isolated-codex-home.cjs')(t);
  const project = path.join(root, 'project');
  const day = path.join(codexHome, 'sessions', '2026', '08', '26');
  fs.mkdirSync(projectsDir); fs.mkdirSync(project); fs.mkdirSync(day, { recursive: true });
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const file = id => path.join(day, `rollout-2026-08-26T11-55-02-${id}.jsonl`);
  const write = (id, turns, extra, originator) => fs.writeFileSync(file(id), rollout(project, turns, extra, originator));
  const cache = require('../session-cache');
  const store = fakeDb();
  const activeSessions = new Map();
  cache.init({ PROJECTS_DIR: projectsDir, activeSessions, getMainWindow: () => null, log: { info() {}, warn() {}, error() {} }, db: store.db });
  cache.setRemoteRoots(new Map());
  return { root, projectsDir, codexHome, project, day, file, write, cache, activeSessions, ...store };
}

test('Codex full readers record stable certificates and the effective external title', t => {
  const f = fixture(t);
  f.write(ID_A, [['user', 'certificate corpus']]);
  const titleFile = path.join(f.codexHome, 'session_index.jsonl');
  fs.writeFileSync(titleFile, JSON.stringify({ id: ID_A, thread_name: 'Title witness' }) + '\n');
  const harness = require('../harnesses/codex');
  const full = require('../harnesses').readHarnessFolder(harness, FOLDER).sessions[0];
  assert.ok(full.fullReadStamp, 'full harness scan proposes a certificate');
  const stamp = JSON.parse(full.fullReadStamp);
  assert.equal(stamp.runtime, 'codex');
  assert.equal(stamp.relativePath, path.basename(f.file(ID_A)));
  assert.equal(stamp.dependencies.title, 'Title witness');
  f.cache.refreshFolder(FOLDER);
  assert.equal(f.rows.get(ID_A).fullReadStamp, full.fullReadStamp, 'harness refresh uses the same full reader');
});

test('Codex failed title observation cannot certify a full read', t => {
  const f = fixture(t);
  f.write(ID_A, [['user', 'still parse this rollout']]);
  const titleFile = path.join(f.codexHome, 'session_index.jsonl'), original = fs.statSync;
  fs.statSync = function (file, ...args) {
    if (file === titleFile) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return original.call(this, file, ...args);
  };
  t.after(() => { fs.statSync = original; });
  const row = require('../harnesses/codex').readSessionFile(f.file(ID_A), FOLDER);
  assert.ok(row, 'failed auxiliary reads retain existing parser behavior');
  assert.equal(row.fullReadStamp, null, 'failed title reads do not prove title absence');
});

test('Codex title race cannot certify the previously read title', t => {
  const f = fixture(t);
  f.write(ID_A, [['user', 'title race corpus']]);
  const titleFile = path.join(f.codexHome, 'session_index.jsonl');
  fs.writeFileSync(titleFile, JSON.stringify({ id: ID_A, thread_name: 'Before' }) + '\n');
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (file, ...args) {
    const value = read.call(this, file, ...args);
    if (file === titleFile) fs.appendFileSync(titleFile, JSON.stringify({ id: ID_A, thread_name: 'After' }) + '\n');
    return value;
  });
  const row = require('../harnesses/codex').readSessionFile(f.file(ID_A), FOLDER);
  assert.equal(row.aiTitle, 'Before', 'display parsing keeps existing semantics');
  assert.equal(row.fullReadStamp, null, 'changed auxiliary source prevents certification');
});

test('Codex certification requires the title-index read to reach observed EOF', t => {
  const f = fixture(t);
  f.write(ID_A, [['user', 'title EOF corpus']]);
  const titleFile = path.join(f.codexHome, 'session_index.jsonl');
  fs.writeFileSync(titleFile, JSON.stringify({ id: ID_A, thread_name: 'Before' }) + '\n');
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (file, ...args) {
    const bytes = read.call(this, file, ...args);
    return file === titleFile ? bytes.subarray(0, bytes.length - 1) : bytes;
  });
  const row = require('../harnesses/codex').readSessionFile(f.file(ID_A), FOLDER);
  assert.equal(row.fullReadStamp, null, 'short title-index read cannot certify observed EOF');
});

test('refreshFolder indexes a Codex date folder through its harness, keeps a running row and drops a vanished one', t => {
  const f = fixture(t);
  f.write(ID_A, [['user', 'fix the parser'], ['assistant', 'done']]);
  f.write(ID_B, [['user', 'second thread']]);
  assert.equal(f.cache.refreshFolder(FOLDER), true);
  const a = f.rows.get(ID_A);
  assert.equal(a.runtime, 'codex');
  assert.equal(a.sessionFile, f.file(ID_A));
  assert.equal(a.projectPath, f.project);
  assert.equal(a.folder, FOLDER);
  assert.equal(a.summary, 'fix the parser');
  assert.equal(f.meta.get(FOLDER).projectPath, null, 'a date folder has no folder-level project');
  assert.ok(f.meta.get(FOLDER).indexMtimeMs > 0);
  assert.equal(f.search.get(ID_A).folder, FOLDER);
  assert.match(f.search.get(ID_A).body, /fix the parser/);
  assert.equal(f.metrics.get(ID_A)[0].model, 'gpt-6');
  assert.equal(f.cache.refreshFolder(FOLDER), false, 'unchanged transcripts are not re-read');

  f.activeSessions.set(ID_B, { exited: false });
  fs.rmSync(f.file(ID_B));
  fs.rmSync(f.file(ID_A));
  assert.equal(f.cache.refreshFolder(FOLDER), true);
  assert.equal(f.rows.has(ID_A), false, 'a vanished rollout loses its row');
  assert.equal(f.rows.has(ID_B), true, 'a running session keeps its row');
  assert.equal(f.cache.getRetainedFolder(ID_B), FOLDER);
  f.activeSessions.delete(ID_B);
  fs.rmSync(f.day, { recursive: true });
  assert.equal(f.cache.refreshFolder(FOLDER), true);
  assert.equal(f.rows.size, 0, 'a vanished date folder drops every row');
});

test('a Codex thread rename is picked up without a transcript change', t => {
  const f = fixture(t);
  f.write(ID_A, [['user', 'hello']]);
  f.cache.refreshFolder(FOLDER);
  assert.equal(f.rows.get(ID_A).aiTitle, null);
  const index = path.join(f.codexHome, 'session_index.jsonl');
  fs.writeFileSync(index, JSON.stringify({ id: ID_A, thread_name: 'Parser work' }) + '\n');
  // The rename happens after the last transcript write; CI file clocks tick coarsely enough for both to share one mtime.
  const renamedAt = new Date(f.meta.get(FOLDER).indexMtimeMs + 1000);
  fs.utimesSync(index, renamedAt, renamedAt);
  const seen = [];
  f.cache.reconcileCacheFromFilesystem({ onFolder: folder => seen.push(folder), throttle: false });
  assert.ok(seen.includes(FOLDER), 'the reconcile pass lists Codex folders');
  assert.equal(f.rows.get(ID_A).aiTitle, 'Parser work');
  assert.match(f.search.get(ID_A).title, /Parser work/);
});

test('reconciliation lists a Codex folder whose directory vanished so its rows are dropped', t => {
  const f = fixture(t);
  f.write(ID_A, [['user', 'hello']]);
  f.cache.refreshFolder(FOLDER);
  fs.rmSync(f.day, { recursive: true });
  f.cache.reconcileCacheFromFilesystem({ throttle: false });
  assert.equal(f.rows.size, 0);
});

test('a malformed Codex folder key never resolves under the sessions root', t => {
  const f = fixture(t);
  f.write(ID_A, [['user', 'hello']]);
  for (const key of ['codex/../../project', 'codex/2026/08', 'codex/2026/08/26/x']) {
    assert.equal(f.cache.refreshFolder(key), false, key);
  }
  assert.equal(f.rows.size, 0);
});

test('projected sessions carry the runtime and its label and group under the transcript cwd', t => {
  const f = fixture(t);
  f.write(ID_A, [['user', 'hello']]);
  f.cache.refreshFolder(FOLDER);
  const projects = f.cache.buildProjectsFromCache(false);
  const project = projects.find(p => p.projectPath === f.project);
  assert.ok(project, 'the Codex session is filed under its cwd');
  const session = project.sessions.find(s => s.sessionId === ID_A);
  assert.equal(session.runtime, 'codex');
  assert.equal(session.runtimeLabel, 'Codex');
  assert.equal(session.canLaunch, true, 'a Codex row can be resumed');
});

// see .ai/contexts/cli-harnesses.md ("Codex adapter"), .ai/contexts/session-cache.md ("SDK-launched sessions")
test('a codex exec rollout is hidden like an SDK session, stays searchable, and is listed when the setting is off', t => {
  const f = fixture(t);
  f.write(ID_A, [['user', 'review the diff']], [], 'codex_exec');
  f.write(ID_B, [['user', 'hello']], [], 'codex_cli_rs');
  f.cache.refreshFolder(FOLDER);
  assert.equal(f.rows.get(ID_A).entrypoint, 'sdk-codex-exec');
  assert.equal(f.rows.get(ID_B).entrypoint, '');
  assert.match(f.search.get(ID_A).body, /review the diff/, 'the hidden rollout is still indexed for search');
  const listed = () => f.cache.buildProjectsFromCache(false).flatMap(p => p.sessions).map(s => s.sessionId).sort();
  assert.deepEqual(listed(), [ID_B], 'the exec rollout is hidden by default, the interactive one is listed');
  f.settings.set('global', { hideSdkSessions: false });
  assert.deepEqual(listed(), [ID_A, ID_B].sort(), 'turning the setting off lists the exec rollout again');
  f.settings.set('global', { hideSdkSessions: true });
  f.activeSessions.set(ID_A, { exited: false });
  assert.deepEqual(listed(), [ID_A, ID_B].sort(), 'an exec rollout open in a tab stays listed');
});

test('opening a store indexed before #1145 schedules one re-read of its Codex rows and leaves Claude rows alone',
  { skip: !openStore.supported && 'native SQLite ABI differs; node:sqlite requires Node 22' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-store-'));
  const previous = process.env.SWITCHBOARD_DATA_DIR;
  process.env.SWITCHBOARD_DATA_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.SWITCHBOARD_DATA_DIR; else process.env.SWITCHBOARD_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  let db = openStore({ readonly: false });
  try {
    assert.equal(db.getSetting('codex_exec_entrypoint_version'), 1, 'a fresh store starts at the current version');
    db.upsertCachedSessions([
      { sessionId: ID_A, folder: FOLDER, projectPath: '/p', summary: 'codex', runtime: 'codex', sessionFile: '/s/a.jsonl', fileMtime: '2026-08-26T10:00:00.000Z', entrypoint: '' },
      { sessionId: 'claude-1', folder: '-p', projectPath: '/p', summary: 'claude', fileMtime: '2026-08-26T10:00:00.000Z', entrypoint: 'cli' }]);
    db.setFolderMeta(FOLDER, null, 5);
    db.setFolderMeta('-p', '/p', 7);
    db.deleteSetting('codex_exec_entrypoint_version');
  } finally { db.closeDb(); }
  db = openStore({ readonly: false });
  try {
    assert.equal(db.getSetting('codex_exec_entrypoint_version'), 1);
    assert.equal(db.getCachedSession(ID_A).fileMtime, null, 'the Codex row will be re-read on its next folder refresh');
    assert.equal(db.getCachedSession(ID_A).entrypoint, '', 'the row itself stays until the re-read decides');
    assert.equal(db.getFolderMeta(FOLDER)?.indexMtimeMs, null, 'the Codex folder remains discoverable with an invalidated stamp');
    assert.equal(db.getCachedSession('claude-1').fileMtime, '2026-08-26T10:00:00.000Z');
    assert.equal(db.getFolderMeta('-p').indexMtimeMs, 7);
  } finally { db.closeDb(); }
});

for (const missing of ['date directory', 'sessions root']) {
  test(`upgrade reconciliation removes the cached row and search entry after the Codex ${missing} disappears`,
    { skip: !openStore.supported && 'native SQLite ABI differs; node:sqlite requires Node 22' }, async t => {
    const f = fixture(t);
    const previous = process.env.SWITCHBOARD_DATA_DIR;
    process.env.SWITCHBOARD_DATA_DIR = path.join(f.root, 'data');
    let db;
    const bind = () => f.cache.init({ PROJECTS_DIR: f.projectsDir, activeSessions: f.activeSessions,
      getMainWindow: () => null, log: console, db });
    try {
      db = openStore({ readonly: false });
      bind();
      f.write(ID_A, [['user', 'needle migration regression']], [], 'codex_exec');
      f.cache.refreshFolder(FOLDER);
      db.setCachedEntrypoints([{ sessionId: ID_A, entrypoint: '' }]);
      db.setInitialScanComplete();
      db.deleteSetting('codex_exec_entrypoint_version');
      assert.equal(db.getCachedSession(ID_A).entrypoint, '');
      assert.ok(db.searchByType('session', 'needle').some(row => row.id === ID_A));
      db.closeDb();
      fs.rmSync(missing === 'date directory' ? f.day : path.join(f.codexHome, 'sessions'), { recursive: true });
      db = openStore({ readonly: false });
      bind();
      assert.equal(db.getSetting('codex_exec_entrypoint_version'), 1);
      await f.cache.reconcileCacheFromFilesystemAsync({ throttle: false });
      assert.deepEqual({
        cached: !!db.getCachedSession(ID_A),
        searchable: db.searchByType('session', 'needle').some(row => row.id === ID_A),
      }, { cached: false, searchable: false }, 'upgrade must remove the vanished rollout from cache and search');
    } finally {
      await f.cache.shutdownProducers();
      if (db) db.closeDb();
      if (previous === undefined) delete process.env.SWITCHBOARD_DATA_DIR; else process.env.SWITCHBOARD_DATA_DIR = previous;
    }
  });
}

test('continuation rollups ignore rows of a harness without continuations', t => {
  const f = fixture(t);
  const index = JSON.stringify({ format: 3, version: 3, ids: [ID_A], complete: true });
  const base = { folder: FOLDER, projectPath: f.project, created: '2026-08-26T10:00:00.000Z', messageCount: 1, summary: 's', runtime: 'codex' };
  f.rows.set(ID_A, { ...base, sessionId: ID_A, modified: '2026-08-26T10:00:01.000Z' });
  f.rows.set(ID_B, { ...base, sessionId: ID_B, modified: '2026-08-26T10:00:02.000Z', continuationIndex: index });
  const sessions = f.cache.buildProjectsFromCache(false).flatMap(p => p.sessions).map(s => s.sessionId).sort();
  assert.deepEqual(sessions, [ID_A, ID_B].sort(), 'both Codex rows stay separate');
});

test('the scan worker streams Codex date folders after the Claude folders', async t => {
  const f = fixture(t);
  f.write(ID_A, [['user', 'hello from codex']]);
  const messages = await new Promise((resolve, reject) => {
    const out = [];
    const worker = new Worker(path.join(__dirname, '..', 'workers', 'scan-projects.js'), {
      workerData: { projectsDir: f.projectsDir }, env: { ...process.env, CODEX_HOME: f.codexHome },
    });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('worker did not finish')); }, 20000);
    worker.on('message', msg => { out.push(msg); if (msg.type === 'done') { clearTimeout(timer); resolve(out); } });
    worker.on('error', err => { clearTimeout(timer); reject(err); });
  });
  const folder = messages.find(m => m.type === 'folder' && m.result?.folder === FOLDER);
  assert.ok(folder, 'the Codex folder is scanned');
  assert.equal(folder.result.projectPath, null);
  assert.equal(folder.result.sessions[0].sessionId, ID_A);
  assert.equal(folder.result.sessions[0].runtime, 'codex');
  assert.equal(folder.total, 1);
  assert.equal(messages.at(-1).ok, true);
  assert.equal(f.cache.writeScannedFolder(folder.result), 1);
  assert.equal(f.rows.get(ID_A).sessionFile, f.file(ID_A));
});

test('the store writes runtime and sessionFile and keeps them on a Claude-shaped upsert',
  { skip: !openStore.supported && 'native SQLite ABI differs; node:sqlite requires Node 22' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-store-'));
  const previous = process.env.SWITCHBOARD_DATA_DIR;
  process.env.SWITCHBOARD_DATA_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.SWITCHBOARD_DATA_DIR; else process.env.SWITCHBOARD_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const db = openStore({ readonly: false });
  try {
    db.upsertCachedSessions([{ sessionId: ID_A, folder: FOLDER, projectPath: '/p', summary: 'codex', runtime: 'codex', sessionFile: '/sessions/a.jsonl' },
      { sessionId: 'claude-1', folder: '-p', projectPath: '/p', summary: 'claude' }]);
    assert.equal(db.getCachedSession(ID_A).runtime, 'codex');
    assert.equal(db.getCachedSession(ID_A).sessionFile, '/sessions/a.jsonl');
    assert.equal(db.getCachedSession('claude-1').runtime, 'claude');
    assert.equal(db.getCachedSession('claude-1').sessionFile, null);
    db.upsertCachedSessions([{ sessionId: ID_A, folder: FOLDER, projectPath: '/p', summary: 'touched' }]);
    assert.equal(db.getCachedSession(ID_A).runtime, 'codex', 'an upsert without runtime keeps the stored one');
    assert.equal(db.getCachedSession(ID_A).sessionFile, '/sessions/a.jsonl');
    db.upsertCachedSessions([{ sessionId: ID_A, folder: FOLDER, projectPath: '/p', summary: 'moved', runtime: 'codex', sessionFile: '/sessions/b.jsonl' }]);
    assert.equal(db.getCachedSession(ID_A).sessionFile, '/sessions/b.jsonl');
  } finally { db.closeDb(); }
});

test('reconciliation drops the cached rows and search entries of a Codex sessions root that is gone', t => {
  const f = fixture(t);
  f.write(ID_A, [['user', 'hello']]);
  f.cache.refreshFolder(FOLDER);
  assert.equal(f.rows.size, 1);
  assert.equal(f.search.size, 1);
  fs.rmSync(path.join(f.codexHome, 'sessions'), { recursive: true });
  const seen = [];
  f.cache.reconcileCacheFromFilesystem({ onFolder: folder => seen.push(folder), throttle: false });
  assert.deepEqual(seen, [FOLDER], 'the cached folder of an unavailable CLI is still reconciled');
  assert.equal(f.rows.size, 0, 'a missing sessions root purges its cached sessions');
  assert.equal(f.search.size, 0);
});
