const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { encodeProjectPath, setRemappedProjectReader } = require('../encode-project-path');
const { deriveProjectPath } = require('../derive-project-path');
const { getFolderIndexMtimeMs } = require('../folder-index-state');
const { remapProjectTranscripts } = require('../project-remap');
const sessionCache = require('../session-cache');

function mkTmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-tcc-')));
}

function cleanup(dir) {
  setRemappedProjectReader(null);
  fs.rmSync(dir, { recursive: true, force: true });
}

function project(tmp, ...parts) {
  const dir = path.join(tmp, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTranscript(projectsDir, folder, sessionId, cwd) {
  const dir = path.join(projectsDir, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sessionId + '.jsonl'),
    JSON.stringify({ type: 'user', cwd, sessionId, message: { role: 'user', content: 'hi' } }) + '\n');
}

function makeStatefulDb({ settings = {}, folderMeta = new Map(), rows = [], scanComplete = true } = {}) {
  const calls = { deletedFolders: [], metaWrites: [] };
  const db = {
    deleteCachedFolder: (f) => { calls.deletedFolders.push(f); },
    getCachedByFolder: (f) => rows.filter(r => r.folder === f),
    upsertCachedSessions: (list) => {
      for (const s of list) {
        const i = rows.findIndex(r => r.sessionId === s.sessionId);
        if (i >= 0) rows[i] = s; else rows.push(s);
      }
    },
    touchCachedModified: () => {}, deleteCachedSession: () => {}, replaceSessionMetrics: () => {},
    deleteSearchFolder: () => {}, deleteSearchSession: () => {}, upsertSearchEntries: () => {},
    getFolderMeta: (f) => folderMeta.get(f) || null,
    setFolderMeta: (folder, projectPath, indexMtimeMs) => {
      calls.metaWrites.push({ folder, projectPath });
      folderMeta.set(folder, { folder, projectPath, indexMtimeMs });
    },
    getAllFolderMeta: () => folderMeta,
    getAllMeta: () => new Map(),
    getAllCached: () => rows,
    getSetting: (k) => (k in settings ? settings[k] : {}),
    getMeta: () => null,
    setName: () => {},
    isInitialScanComplete: () => scanComplete,
    setInitialScanComplete: () => {},
  };
  return { db, calls, rows, folderMeta, settings };
}

function initCache(projectsDir, db, log = console) {
  sessionCache.init({ PROJECTS_DIR: projectsDir, activeSessions: new Map(), getMainWindow: () => null, log, db });
}

test('remap: a remapped project keeps its folder and its project path through derive, refreshFolder and a cold sidebar build', () => {
  const tmp = mkTmp();
  try {
    const oldP = path.join(tmp, 'gone');
    const newP = project(tmp, 'moved');
    const projectsDir = project(tmp, 'projects');
    const folder = encodeProjectPath(oldP);
    writeTranscript(projectsDir, folder, 's1', oldP);
    const state = makeStatefulDb();
    initCache(projectsDir, state.db);
    const folderPath = path.join(projectsDir, folder);

    remapProjectTranscripts({
      folder, folderPath, oldPath: oldP, newPath: newP,
      getSetting: state.db.getSetting,
      setSetting: (k, v) => { state.settings[k] = v; },
    });

    assert.equal(deriveProjectPath(folderPath, folder), newP);
    sessionCache.refreshFolder(folder);
    assert.ok(state.calls.metaWrites.every(w => w.projectPath === newP), JSON.stringify(state.calls.metaWrites));
    assert.equal(state.rows.length, 1);
    assert.equal(state.rows[0].projectPath, newP);

    state.folderMeta.clear();
    state.rows.length = 0;
    const projects = sessionCache.buildProjectsFromCache(false);
    assert.deepEqual(projects.map(p => p.projectPath), [newP]);
    assert.equal(projects[0].missing, false);
  } finally { cleanup(tmp); }
});

test('remap: a cwd that was never recorded for the folder is still refused after a remap elsewhere', () => {
  const tmp = mkTmp();
  try {
    const p = project(tmp, 'proj');
    const evil = project(tmp, 'proj', 'evil');
    const projectsDir = project(tmp, 'projects');
    const folder = encodeProjectPath(p);
    writeTranscript(projectsDir, folder, 'forged', evil);
    const state = makeStatefulDb({ settings: { projectRemaps: { '-some-other-folder': evil } } });
    initCache(projectsDir, state.db);
    assert.equal(deriveProjectPath(path.join(projectsDir, folder), folder), null);
  } finally { cleanup(tmp); }
});

test('buildProjectsFromCache: a forged projectPath stored in cache_meta before the upgrade is re-derived, not shown', () => {
  const tmp = mkTmp();
  try {
    const p = project(tmp, 'proj');
    const evil = project(tmp, 'proj', 'evil');
    const projectsDir = project(tmp, 'projects');
    const folder = encodeProjectPath(p);
    writeTranscript(projectsDir, folder, 'genuine', p);
    const state = makeStatefulDb({ folderMeta: new Map([[folder, { folder, projectPath: evil, indexMtimeMs: 1 }]]) });
    initCache(projectsDir, state.db);
    const projects = sessionCache.buildProjectsFromCache(false);
    assert.deepEqual(projects.map(x => x.projectPath), [p]);
    assert.equal(state.folderMeta.get(folder).projectPath, p);
  } finally { cleanup(tmp); }
});

test('reconcileCacheFromFilesystem: a folder whose stored projectPath does not verify is refreshed even when its mtime is current', async () => {
  const tmp = mkTmp();
  try {
    const p = project(tmp, 'proj');
    const evil = project(tmp, 'proj', 'evil');
    const projectsDir = project(tmp, 'projects');
    const folder = encodeProjectPath(p);
    writeTranscript(projectsDir, folder, 'genuine', p);
    const current = getFolderIndexMtimeMs(path.join(projectsDir, folder));
    const state = makeStatefulDb({ folderMeta: new Map([[folder, { folder, projectPath: evil, indexMtimeMs: current }]]) });
    initCache(projectsDir, state.db);
    await sessionCache.reconcileCacheFromFilesystem();
    assert.equal(state.folderMeta.get(folder).projectPath, p);
  } finally { cleanup(tmp); }
});

test('refreshFolder: an unchanged cached row carrying a forged projectPath is rewritten with the verified one', () => {
  const tmp = mkTmp();
  try {
    const p = project(tmp, 'proj');
    const evil = project(tmp, 'proj', 'evil');
    const projectsDir = project(tmp, 'projects');
    const folder = encodeProjectPath(p);
    writeTranscript(projectsDir, folder, 'genuine', p);
    const file = path.join(projectsDir, folder, 'genuine.jsonl');
    const rows = [{
      sessionId: 'genuine', folder, projectPath: evil, fileMtime: fs.statSync(file).mtime.toISOString(),
      modified: '2026-01-01T00:00:00.000Z', filePath: file, parentSessionId: null, agentId: null, messageCount: 1,
    }];
    const state = makeStatefulDb({ rows });
    initCache(projectsDir, state.db);
    sessionCache.refreshFolder(folder);
    assert.equal(state.rows[0].projectPath, p);
  } finally { cleanup(tmp); }
});

test('refreshFolder: a folder with no verifiable transcript loses its cached rows and warns once, naming the folder and the first rejected cwd', () => {
  const tmp = mkTmp();
  try {
    const p = project(tmp, 'warnproj');
    const evil = project(tmp, 'warnproj', 'evil');
    const projectsDir = project(tmp, 'projects');
    const folder = encodeProjectPath(p);
    writeTranscript(projectsDir, folder, 'forged', evil);
    const warnings = [];
    const state = makeStatefulDb();
    initCache(projectsDir, state.db, { info() {}, error() {}, warn: (m) => warnings.push(m) });
    sessionCache.refreshFolder(folder);
    sessionCache.refreshFolder(folder);
    assert.deepEqual(state.calls.deletedFolders, [folder, folder]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^\[session-cache\]/);
    assert.ok(warnings[0].includes(folder));
    assert.ok(warnings[0].includes(JSON.stringify(evil)));
  } finally { cleanup(tmp); }
});

test('remap: a folder with a recorded path still refuses a cwd that differs from the recorded one', () => {
  const tmp = mkTmp();
  try {
    const oldP = path.join(tmp, 'gone');
    const newP = project(tmp, 'moved');
    const evil = project(tmp, 'moved', 'evil');
    const projectsDir = project(tmp, 'projects');
    const folder = encodeProjectPath(oldP);
    writeTranscript(projectsDir, folder, 'forged', evil);
    const state = makeStatefulDb({ settings: { projectRemaps: { [folder]: newP } } });
    initCache(projectsDir, state.db);
    assert.equal(deriveProjectPath(path.join(projectsDir, folder), folder), null);
  } finally { cleanup(tmp); }
});

test('cold scan: a local folder with no verified path loses its cached rows, and a newline in the rejected cwd cannot forge a log line', async () => {
  const tmp = mkTmp();
  try {
    const p = project(tmp, 'coldproj');
    const forgedCwd = path.join(p, 'evil') + '\n[session-cache] forged line';
    const projectsDir = project(tmp, 'projects');
    const folder = encodeProjectPath(p);
    writeTranscript(projectsDir, folder, 'forged', forgedCwd);
    const warnings = [];
    const state = makeStatefulDb({ scanComplete: false });
    initCache(projectsDir, state.db, { info() {}, error() {}, warn: (m) => warnings.push(m) });
    await sessionCache.populateCacheViaWorker();
    assert.deepEqual(state.calls.deletedFolders, [folder]);
    assert.equal(warnings.length, 1);
    assert.ok(!warnings[0].includes('\n'));
  } finally { cleanup(tmp); }
});
