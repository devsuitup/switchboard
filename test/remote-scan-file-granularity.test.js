'use strict';

// Issue #216 (first half): the remote path must descend the rescan unit from
// folder to file. workers/scan-projects.js is shared with the local cold-start
// scan, so every property here is proven through session-cache.js's real
// entry point (scanFoldersViaWorker), spinning the actual worker thread --
// same pattern as test/remote-indexing-e2e.test.js and
// test/scan-projects-worker.test.js. See .ai/contexts/session-cache.md
// ("Remote hosts file-level rescan").

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sessionCache = require('../session-cache');

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-' + name + '-'));
}
function writeJsonl(filePath, lines) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

/** Fake DB that actually tracks a mutable session_cache-shaped store, plus a
 *  call log -- so a test can assert not just the end state but which rows
 *  were ever written to (proof that an untouched sibling was never re-read,
 *  not just that its final value happens to match). */
function makeFakeDb(cachedRows = []) {
  const store = new Map(cachedRows.map(r => [r.sessionId, { ...r }]));
  const deletedFolders = [];
  const deletedSessions = [];
  const upsertedSessionIds = [];
  const folderMeta = new Map();
  const db = {
    deleteCachedFolder: (f) => deletedFolders.push(f),
    getCachedByFolder: (folder) => Array.from(store.values()).filter(r => r.folder === folder),
    getAllCached: () => Array.from(store.values()),
    upsertCachedSessions: (rows) => {
      for (const r of rows) {
        upsertedSessionIds.push(r.sessionId);
        store.set(r.sessionId, { ...store.get(r.sessionId), ...r });
      }
    },
    touchCachedModified: () => {},
    deleteCachedSession: (id) => { deletedSessions.push(id); store.delete(id); },
    replaceSessionMetrics: () => {},
    deleteSearchFolder: () => {},
    deleteSearchSession: () => {},
    upsertSearchEntries: () => {},
    setFolderMeta: (folder, projectPath, indexMtimeMs) => folderMeta.set(folder, { projectPath, indexMtimeMs }),
    getFolderMeta: () => null,
    getAllFolderMeta: () => folderMeta,
    getAllMeta: () => new Map(),
    getSetting: () => ({}),
    getMeta: () => null,
    setName: () => {},
    isInitialScanComplete: () => true,
    setInitialScanComplete: () => {},
  };
  return { db, store, deletedFolders, deletedSessions, upsertedSessionIds };
}

function initCache(db) {
  sessionCache.init({
    PROJECTS_DIR: tmp('unused-local-root'),
    activeSessions: new Map(),
    getMainWindow: () => null,
    log: { info() {}, warn() {}, error() {} },
    db,
  });
}

test('property 1: a single changed file in a multi-file folder rereads only that file', async () => {
  const projectsDir = tmp('gran-single');
  try {
    const folderPath = path.join(projectsDir, '-srv-two');
    writeJsonl(path.join(folderPath, 'a.jsonl'), [
      { type: 'user', cwd: '/srv/two', timestamp: '2026-09-01T10:00:00.000Z', message: { role: 'user', content: 'session a' } },
    ]);
    writeJsonl(path.join(folderPath, 'b.jsonl'), [
      { type: 'user', cwd: '/srv/two', timestamp: '2026-09-01T11:00:00.000Z', message: { role: 'user', content: 'session b' } },
    ]);

    // Both already indexed from a prior cycle -- this folder is NOT new.
    const cachedRows = [
      { sessionId: 'a', folder: 'vps::-srv-two', projectPath: '/srv/two', created: '2026-09-01T10:00:00.000Z', modified: '2026-09-01T10:00:00.000Z', messageCount: 1 },
      { sessionId: 'b', folder: 'vps::-srv-two', projectPath: '/srv/two', created: '2026-09-01T11:00:00.000Z', modified: '2026-09-01T11:00:00.000Z', messageCount: 1 },
    ];
    const { db, store, deletedFolders, upsertedSessionIds } = makeFakeDb(cachedRows);
    initCache(db);

    // Only b.jsonl is named as changed this cycle -- see the mutated line below.
    console.log('[property1] mutated line under test: fileSubsets = Map { "-srv-two" => Set(["b.jsonl"]) } -- a.jsonl is deliberately absent');
    const fileSubsets = new Map([['-srv-two', new Set(['b.jsonl'])]]);

    const scan = await sessionCache.scanFoldersViaWorker({
      projectsDir, folderPrefix: 'vps', folders: ['-srv-two'], fileSubsets,
    });
    assert.equal(scan.ok, true, scan.error);

    assert.deepEqual(upsertedSessionIds, ['b'], 'only the named file was re-read and written back');
    assert.equal(deletedFolders.length, 0, 'a file-level rescan must never delete-then-reinsert the whole folder');
    assert.equal(store.get('a').messageCount, 1, 'the untouched sibling keeps its pre-existing cached row exactly');
    assert.ok(store.get('b'), 'the named file is present in the cache');
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});

test('property 2: with no fileSubsets, a folder is still scanned in full (local/default path unchanged)', async () => {
  const projectsDir = tmp('gran-full');
  try {
    const folderPath = path.join(projectsDir, 'proj');
    writeJsonl(path.join(folderPath, 'a.jsonl'), [
      { type: 'user', cwd: folderPath, timestamp: '2026-09-01T10:00:00.000Z', message: { role: 'user', content: 'session a' } },
    ]);
    writeJsonl(path.join(folderPath, 'b.jsonl'), [
      { type: 'user', cwd: folderPath, timestamp: '2026-09-01T11:00:00.000Z', message: { role: 'user', content: 'session b' } },
    ]);

    const { db, deletedFolders, upsertedSessionIds } = makeFakeDb();
    initCache(db);

    console.log('[property2] mutated line under test: scanFoldersViaWorker called with folders:["proj"] and NO fileSubsets key at all');
    const scan = await sessionCache.scanFoldersViaWorker({ projectsDir, folders: ['proj'] });
    assert.equal(scan.ok, true, scan.error);

    assert.deepEqual(upsertedSessionIds.sort(), ['a', 'b'], 'a whole-folder scan reads every file, exactly as before');
    assert.deepEqual(deletedFolders, ['proj'], 'the pre-existing delete-then-insert path is unchanged when no fileSubsets is given');
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});

test('property 3: a compaction-mirror merge on a file-subset rescan matches a full-folder rescan', async () => {
  const projectsDir = tmp('gran-bridge');
  try {
    const folderPath = path.join(projectsDir, '-srv-bridge');
    const projectPath = '/srv/bridge';
    const PARENT_USAGE = { input_tokens: 100, output_tokens: 50 };
    const MIRROR_NEW_USAGE = { input_tokens: 9, output_tokens: 4 };

    const parentLines = [
      { type: 'bridge-session', sessionId: 'parent', bridgeSessionId: 'cse_1', lastSequenceNum: 0 },
      { type: 'user', cwd: projectPath, timestamp: '2026-09-03T21:15:40.535Z', message: { role: 'user', content: 'New project' } },
      { type: 'assistant', timestamp: '2026-09-03T21:16:00.000Z', message: { model: 'claude-sonnet-4-6', usage: PARENT_USAGE } },
    ];
    // Mirror recopies the parent's last turn verbatim (same timestamp), then
    // receives genuinely new content -- same fixture shape as
    // test/session-cache-bridge-dedup.test.js.
    const mirrorLines = [
      { type: 'assistant', timestamp: '2026-09-03T21:16:00.000Z', message: { model: 'claude-sonnet-4-6', usage: PARENT_USAGE } },
      { type: 'user', cwd: projectPath, timestamp: '2026-09-05T22:15:00.000Z', message: { role: 'user', content: 'continue please' } },
      { type: 'assistant', timestamp: '2026-09-05T22:15:05.000Z', message: { model: 'claude-sonnet-4-6', usage: MIRROR_NEW_USAGE } },
      { type: 'bridge-session', sessionId: 'mirror', bridgeSessionId: 'cse_1', lastSequenceNum: 7481 },
    ];
    writeJsonl(path.join(folderPath, 'parent.jsonl'), parentLines);
    writeJsonl(path.join(folderPath, 'mirror.jsonl'), mirrorLines);

    // --- Reference: a full-folder scan (today's only remote behavior). ------
    const { db: dbFull, store: storeFull } = makeFakeDb();
    initCache(dbFull);
    const fullScan = await sessionCache.scanFoldersViaWorker({
      projectsDir, folderPrefix: 'vps', folders: ['-srv-bridge'],
    });
    assert.equal(fullScan.ok, true, fullScan.error);
    const parentFull = storeFull.get('parent');
    const mirrorFull = storeFull.get('mirror');
    assert.ok(parentFull && mirrorFull, 'both members of the bridge group are indexed by the full scan');
    assert.equal(mirrorFull.mergedIntoSessionId, 'parent', 'sanity: the mirror is merged into the parent');

    // --- Under test: only mirror.jsonl named changed, parent already cached. ---
    const seededParentRow = { ...parentFull };
    console.log('[property3] mutated line under test: fileSubsets = Map { "-srv-bridge" => Set(["mirror.jsonl"]) }, existingRows seeded from the full-scan parent row above');
    const { db: dbPartial, store: storePartial, upsertedSessionIds } = makeFakeDb([seededParentRow]);
    initCache(dbPartial);
    const partialScan = await sessionCache.scanFoldersViaWorker({
      projectsDir, folderPrefix: 'vps', folders: ['-srv-bridge'],
      fileSubsets: new Map([['-srv-bridge', new Set(['mirror.jsonl'])]]),
    });
    assert.equal(partialScan.ok, true, partialScan.error);

    assert.deepEqual(upsertedSessionIds, ['mirror'], 'the already-correct parent is never re-read on the restricted pass');
    const mirrorPartial = storePartial.get('mirror');
    assert.ok(mirrorPartial, 'the mirror is still indexed via the file-subset path');
    assert.equal(mirrorPartial.mergedIntoSessionId, mirrorFull.mergedIntoSessionId, 'same winner is computed either way');
    assert.equal(mirrorPartial.messageCount, mirrorFull.messageCount, 'same post-cutoff message count either way');
    assert.deepEqual(mirrorPartial.dailyMetrics, mirrorFull.dailyMetrics, 'same deduplicated metrics either way');
    assert.deepEqual(storePartial.get('parent'), seededParentRow, 'the parent row is byte-identical to what the full scan produced');
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});
