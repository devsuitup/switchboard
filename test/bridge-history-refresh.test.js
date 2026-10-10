const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cache = require('../session-cache');
const { readSessionFile, mergeBridgeGroups } = require('../read-session-file');
const { encodeProjectPath } = require('../encode-project-path');
const { createRemoteIndexer } = require('../remote-index');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-r2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = encodeProjectPath(root);
  const dir = path.join(root, folder);
  fs.mkdirSync(dir);
  const write = (id, entries) => fs.writeFileSync(path.join(dir, id + '.jsonl'), entries.concat(
    { type: 'bridge-session', bridgeSessionId: 'cse_test' }).map(e => JSON.stringify(e)).join('\n') + '\n');
  const msg = (uuid, day, text = uuid) => ({ type: 'user', uuid, timestamp: `2026-10-${day}T10:00:00.000Z`,
    cwd: root, message: { content: text } });
  const reread = (id, cutoff, excludedMessageUuids, excludedMessageSignatures) => readSessionFile(
    path.join(dir, id + '.jsonl'), folder, root,
    { dedupeSinceTimestamp: cutoff, excludedMessageUuids, excludedMessageSignatures });
  const rows = new Map(), meta = new Map(), metrics = new Map(), search = new Map(), settings = new Map(), activeSessions = new Map();
  const db = {
    getCachedByFolder: key => [...rows.values()].filter(r => r.folder === key),
    getAllCached: () => [...rows.values()], getAllMeta: () => new Map(), getAllFolderMeta: () => meta,
    getFolderMeta: key => meta.get(key), getSetting: key => settings.get(key), setSetting: (key, value) => settings.set(key, value), getMeta: () => null, setName() {},
    setFolderMeta: (key, projectPath, indexMtimeMs) => meta.set(key, { projectPath, indexMtimeMs }),
    upsertCachedSessions: fresh => fresh.forEach(r => rows.set(r.sessionId, { ...r })),
    deleteCachedSession: id => { rows.delete(id); metrics.delete(id); },
    deleteCachedFolder: key => { for (const r of rows.values()) if (r.folder === key) { rows.delete(r.sessionId); metrics.delete(r.sessionId); } },
    deleteSearchFolder: key => { for (const r of search.values()) if (r.folder === key) search.delete(r.id); },
    deleteSearchSession: id => search.delete(id),
    upsertSearchEntries: entries => entries.forEach(e => search.set(e.id, e)),
    replaceSessionMetrics: (id, daily) => metrics.set(id, daily), touchCachedModified() {},
  };
  cache.init({ PROJECTS_DIR: root, activeSessions, getMainWindow: () => null, log: console, db });
  cache.setRemoteRoots(new Map());
  t.after(() => cache.setRemoteRoots(new Map()));
  return { root, folder, dir, write, msg, reread, rows, meta, db, metrics, search, settings, activeSessions };
}

test('a three-member bridge attaches B continuation to B and keeps its sidebar activity there', { timeout: 9000 }, async t => {
  const f = fixture(t);
  f.write('a', [f.msg('opening', '01'), f.msg('a-own', '09')]);
  f.write('b', [f.msg('b-first', '03'), f.msg('b-tail', '04')]);
  f.write('c', [f.msg('b-tail', '04'), f.msg('c-own', '05')]);
  await cache.scanFoldersViaWorker({ projectsDir: f.root, folders: [f.folder] });
  assert.equal(f.rows.get('c').mergedIntoSessionId, 'b');
  assert.equal(f.rows.get('c').messageCount, 1);
  const project = cache.buildProjectsFromCache(false).find(p => p.projectPath === f.root);
  assert.equal(project.sessions.find(r => r.sessionId === 'b').messageCount, 3);
  assert.equal(project.sessions.find(r => r.sessionId === 'b').modified, '2026-10-05T10:00:00.000Z');
});

test('ordinary bridge flush uses only header reads and synchronously advances the folder gate', { timeout: 9000 }, async t => {
  const f = fixture(t);
  f.write('a', [f.msg('opening', '01'), f.msg('a-tail', '02')]);
  f.write('b', [f.msg('b-own', '03')]);
  f.write('c', [f.msg('a-tail', '02'), f.msg('c-own', '05')]);
  await cache.scanFoldersViaWorker({ projectsDir: f.root, folders: [f.folder] });
  assert.equal(f.rows.get('c').mergedIntoSessionId, 'a');
  fs.appendFileSync(path.join(f.dir, 'a.jsonl'), JSON.stringify(f.msg('a-new', '09')) + '\n');
  const reads = [];
  const original = fs.readFileSync;
  fs.readFileSync = (file, ...args) => { if (String(file).startsWith(f.dir) && String(file).endsWith('.jsonl')) reads.push(file); return original(file, ...args); };
  let result;
  try { result = cache.refreshFolder(f.folder, { files: new Set(['a.jsonl']) }); }
  finally { fs.readFileSync = original; }
  assert.equal(f.rows.get('a').messageCount, 2, 'cached body counts stay unchanged on header refresh');
  assert.equal(result, undefined, 'refreshFolder has a synchronous contract on every path');
  assert.deepEqual(reads, [], 'ordinary flush must not read transcript bodies');
  assert.equal(f.rows.get('c').mergedIntoSessionId, 'a', 'unchanged members are not re-evaluated on ordinary flushes');
  assert.equal(f.rows.get('a').fileMtime, fs.statSync(path.join(f.dir, 'a.jsonl')).mtime.toISOString());
});

test('deleting A restores the shared UUIDs of independent B promoted to first member', { timeout: 9000 }, async t => {
  const f = fixture(t);
  f.write('a', [f.msg('shared', '01'), f.msg('a-late', '09')]);
  f.write('b', [f.msg('shared', '01'), f.msg('b-own', '04')]);
  await cache.scanFoldersViaWorker({ projectsDir: f.root, folders: [f.folder] });
  assert.equal(f.rows.get('b').messageCount, 1);
  assert.equal(f.rows.get('b').mergedIntoSessionId, null);
  fs.unlinkSync(path.join(f.dir, 'a.jsonl'));
  cache.refreshFolder(f.folder, { files: new Set(['a.jsonl']) });
  assert.ok(!f.rows.has('a'));
  assert.equal(f.rows.get('b').messageCount, 2);
  assert.equal(f.metrics.get('b').reduce((n, r) => n + r.messageCount, 0), 2);
  assert.ok(f.search.get('b').body.includes('shared'));
});

test('mixed UUID coverage excludes a copied legacy tail while retaining its own earlier messages', { timeout: 9000 }, t => {
  const f = fixture(t);
  f.write('a', [f.msg('a-open', '01'), f.msg(undefined, '02', 'Copied legacy tail'), f.msg('a-late', '09')]);
  f.write('b', [f.msg(undefined, '02', 'Copied legacy tail'), f.msg('b-own', '04')]);
  const { toUpsert } = mergeBridgeGroups([], ['a', 'b'].map(id => f.reread(id)), f.reread);
  const b = toUpsert.find(r => r.sessionId === 'b');
  assert.equal(b.messageCount, 1);
  assert.ok(!b.textContent.includes('Copied legacy tail'));
  assert.equal(b.dailyMetrics.reduce((n, r) => n + r.messageCount, 0), 1);
  assert.equal(b.mergedIntoSessionId, null);
});

test('discovering another bridge member merges once and drops transient evidence before persistence', { timeout: 9000 }, async t => {
  const f = fixture(t);
  f.write('a', [f.msg('shared', '01'), f.msg('a-own', '02')]);
  f.write('b', [f.msg('b-own', '03')]);
  await cache.scanFoldersViaWorker({ projectsDir: f.root, folders: [f.folder] });
  f.write('c', [f.msg('b-own', '03'), f.msg('c-own', '04')]);
  const reads = [], original = fs.readFileSync;
  fs.readFileSync = (file, ...args) => { if (String(file).startsWith(f.dir) && String(file).endsWith('.jsonl')) reads.push(file); return original(file, ...args); };
  try { cache.refreshFolder(f.folder, { files: new Set(['c.jsonl']) }); }
  finally { fs.readFileSync = original; }
  assert.ok(reads.length > 0, 'rare discovery retains the incremental main-thread merge');
  assert.equal(f.rows.get('c').mergedIntoSessionId, 'b');
  assert.ok([...f.rows.values()].every(r => !('messageUuids' in r) && !('messageSignatures' in r)));
});

test('mixed UUID coverage keeps unique older turns even when the timestamp cutoff has a nonempty tail', { timeout: 9000 }, async t => {
  const f = fixture(t);
  f.write('a', [f.msg(undefined, '01', 'Copied legacy'), f.msg('a-late', '02')]);
  f.write('b', [f.msg(undefined, '01', 'Copied legacy'), f.msg('b-early', '01'), f.msg('b-late', '04')]);
  await cache.scanFoldersViaWorker({ projectsDir: f.root, folders: [f.folder] });
  const b = f.rows.get('b');
  assert.equal(b.messageCount, 2);
  assert.ok(b.textContent.includes('b-early'));
  assert.ok(b.textContent.includes('b-late'));
  assert.ok(!b.textContent.includes('Copied legacy'));
  assert.equal(f.metrics.get('b').reduce((n, row) => n + row.messageCount, 0), 2);
});

test('a file-subset worker deletion restores an independent promoted member without a local watcher', { timeout: 9000 }, async t => {
  const f = fixture(t);
  f.write('a', [f.msg('shared', '01'), f.msg('a-late', '09')]);
  f.write('b', [f.msg('shared', '01'), f.msg('b-own', '04')]);
  await cache.scanFoldersViaWorker({ projectsDir: f.root, folders: [f.folder] });
  assert.equal(f.rows.get('b').messageCount, 1);
  assert.equal(f.rows.get('b').mergedIntoSessionId, null);
  fs.unlinkSync(path.join(f.dir, 'a.jsonl'));
  await cache.scanFoldersViaWorker({ projectsDir: f.root, folders: [f.folder], fileSubsets: new Map([[f.folder, new Set(['a.jsonl'])]]) });
  assert.ok(!f.rows.has('a'));
  assert.equal(f.rows.get('b').messageCount, 2);
  assert.equal(f.metrics.get('b').reduce((n, row) => n + row.messageCount, 0), 2);
});

test('mixed evidence preserves repeated text with distinct known UUIDs', { timeout: 9000 }, async t => {
  const f = fixture(t);
  f.write('a', [f.msg('a-own', '01', 'Repeat this prompt'), f.msg(undefined, '02', 'Copied tail'), f.msg('a-late', '09')]);
  f.write('b', [f.msg(undefined, '02', 'Copied tail'), f.msg('b-own', '04', 'Repeat this prompt')]);
  await cache.scanFoldersViaWorker({ projectsDir: f.root, folders: [f.folder] });
  const b = f.rows.get('b');
  assert.ok(b, 'a distinct known UUID must survive repeated text');
  assert.equal(b.messageCount, 1);
  assert.ok(b.textContent.includes('Repeat this prompt'));
  assert.ok(!b.textContent.includes('Copied tail'));
});

test('warm incremental reconciliation drops a cached local folder with an invalid stored project path', { timeout: 9000 }, async t => {
  const f = fixture(t);
  f.write('a', [f.msg('a-own', '01')]);
  await cache.scanFoldersViaWorker({ projectsDir: f.root, folders: [f.folder] });
  assert.ok(f.rows.has('a'));
  f.write('a', [{ ...f.msg('a-own', '01'), cwd: path.join(f.root, 'wrong-project') }]);
  f.meta.set(f.folder, { projectPath: path.join(f.root, 'wrong-project'), indexMtimeMs: 0 });
  cache.reconcileCacheFromFilesystem();
  assert.ok(!f.rows.has('a'));
  assert.ok(!f.search.has('a'));
});

test('one-time repair indexes only repaired folders off-thread and cannot loop through reconcile', { timeout: 9000 }, async t => {
  const f = fixture(t);
  f.write('a', [f.msg('a-open', '01')]);
  f.write('b', [f.msg('b-own', '02')]);
  const other = encodeProjectPath(path.join(f.root, 'other'));
  fs.mkdirSync(path.join(f.root, other));
  fs.writeFileSync(path.join(f.root, other, 'untouched.jsonl'), JSON.stringify({ ...f.msg('other', '01'), cwd: path.join(f.root, 'other') }) + '\n');
  f.meta.set(other, { projectPath: path.join(f.root, 'other'), indexMtimeMs: require('../folder-index-state').getFolderIndexMtimeMs(path.join(f.root, other)) });
  f.settings.set('bridge_uuid_reindex_folders', [f.folder]);
  const upsert = f.db.upsertCachedSessions;
  let writes = 0;
  f.db.upsertCachedSessions = fresh => { writes++; upsert(fresh); };
  const reads = [], original = fs.readFileSync;
  fs.readFileSync = (file, ...args) => { if (String(file).startsWith(f.dir) && String(file).endsWith('.jsonl')) reads.push(file); return original(file, ...args); };
  try {
    cache.init({ PROJECTS_DIR: f.root, activeSessions: f.activeSessions, getMainWindow: () => null, log: console, db: f.db });
    const first = cache.reindexRepairedFolders?.();
    assert.equal(cache.refreshFolder(f.folder, { files: new Set(['a.jsonl']) }), undefined);
    assert.deepEqual(reads, [], 'watcher flush during repair must not recreate invalidated rows on the main thread');
    assert.equal(cache.reconcileCacheFromFilesystem(), undefined);
    await first;
    await cache.reindexRepairedFolders();
  }
  finally { fs.readFileSync = original; }
  assert.deepEqual(reads, []);
  assert.equal(f.rows.size, 2);
  assert.equal(writes, 1, 'startup repair writes its folder once; neither reconcile nor repeated calls restart it');
  assert.deepEqual(f.settings.get('bridge_uuid_reindex_folders'), []);
});

test('a failed repair write releases its gate so watcher and reconcile discover sessions without a restart', { timeout: 9000 }, async t => {
  const f = fixture(t);
  f.write('a', [f.msg('own', '01')]);
  f.settings.set('bridge_uuid_reindex_folders', [f.folder]);
  const upsert = f.db.upsertCachedSessions;
  let attempts = 0;
  let failWrite = true;
  f.db.upsertCachedSessions = fresh => {
    if (failWrite) { attempts++; throw new Error('injected repair write failure'); }
    upsert(fresh);
  };
  const ctx = { PROJECTS_DIR: f.root, activeSessions: f.activeSessions, getMainWindow: () => null, log: { warn() {} }, db: f.db };
  cache.init(ctx);
  assert.equal((await cache.reindexRepairedFolders()).ok, false);
  assert.deepEqual(f.settings.get('bridge_uuid_reindex_folders'), []);
  failWrite = false;
  f.write('new', [f.msg('new-own', '02')]);
  assert.equal(cache.refreshFolder(f.folder, { files: new Set(['new.jsonl']) }), undefined);
  assert.ok(f.rows.has('new'), 'watcher discovers a new session after repair failure');
  f.meta.get(f.folder).indexMtimeMs = 0;
  assert.equal(cache.reconcileCacheFromFilesystem(), undefined);
  assert.ok(f.rows.has('a'));
  assert.ok(f.search.has('a'));
  assert.equal(attempts, 1, 'incremental recovery does not restart the repair worker');
  assert.equal((await cache.reindexRepairedFolders()).folders, 0);
  assert.deepEqual(f.settings.get('bridge_uuid_reindex_folders'), []);
});

test('pruning an undeclared host clears its pending repair through the main dropFolder callback', { timeout: 9000 }, async t => {
  const f = fixture(t);
  const key = 'gone::-srv-old';
  f.rows.set('remote', { sessionId: 'remote', folder: key });
  f.search.set('remote', { id: 'remote', folder: key });
  f.meta.set(key, {});
  f.settings.set('bridge_uuid_reindex_folders', [key, f.folder, 'vps::-srv-demo']);
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const body = source.match(/dropFolder: \(folderKey\) => \{([\s\S]*?)\n?\s*\},/)[1];
  const drop = new Function('deleteCachedFolder', 'deleteSearchFolder', 'getSetting', 'setSetting', 'folderKey', body);
  const indexer = createRemoteIndexer({
    getHosts: () => [{ alias: 'vps' }], dataDir: f.root, transport: {},
    sync: async () => ({ fetched: 0, unchanged: 0, removed: 0, failed: 0, changedFolders: new Set(), sessions: [] }),
    listIndexedFolderKeys: () => [...f.meta.keys()],
    dropFolder: folder => drop(f.db.deleteCachedFolder, f.db.deleteSearchFolder, f.db.getSetting, f.db.setSetting, folder),
  });
  t.after(() => indexer.dispose());
  await indexer.refreshNow();
  assert.ok(!f.rows.has('remote'));
  assert.ok(!f.search.has('remote'));
  assert.deepEqual(f.settings.get('bridge_uuid_reindex_folders'), [f.folder, 'vps::-srv-demo']);
});

test('a UUID-complete bridge row gets signatures by re-reading instead of retaining original lines', { timeout: 9000 }, t => {
  const f = fixture(t);
  f.write('a', [f.msg('known', '01', 'Original synthetic payload')]);
  const row = f.reread('a');
  assert.equal(row.messageUuidsComplete, true);
  f.write('a', [f.msg('known', '01', 'Re-read synthetic payload')]);
  const reads = [], original = fs.readFileSync;
  fs.readFileSync = (file, ...args) => { reads.push(file); return original(file, ...args); };
  try {
    assert.ok(row.messageSignatures[0].signature.includes('Re-read synthetic payload'));
    assert.deepEqual(reads, [path.join(f.dir, 'a.jsonl')]);
    assert.equal(row.messageSignatures.length, 1);
    assert.equal(reads.length, 1, 'computed signatures are memoized');
  } finally { fs.readFileSync = original; }
});

test('mixed coverage still compares a complete predecessor with a legacy copied message', { timeout: 9000 }, t => {
  const f = fixture(t);
  f.write('a', [f.msg('known', '01', 'Copied payload')]);
  f.write('b', [f.msg(undefined, '01', 'Copied payload'), f.msg('own', '02')]);
  const merged = mergeBridgeGroups([], ['a', 'b'].map(id => f.reread(id)), f.reread);
  const b = merged.toUpsert.find(row => row.sessionId === 'b');
  assert.equal(b.messageCount, 1);
  assert.ok(!b.textContent.includes('Copied payload'));
});

test('reconcile keeps a running row whose transcript vanished and skips unchanged transcript bodies', { timeout: 9000 }, async t => {
  const f = fixture(t);
  f.write('a', [f.msg('a-own', '01')]);
  f.write('b', [f.msg('b-own', '02')]);
  await cache.scanFoldersViaWorker({ projectsDir: f.root, folders: [f.folder] });
  f.activeSessions.set('b', { exited: false });
  fs.unlinkSync(path.join(f.dir, 'b.jsonl'));
  f.meta.get(f.folder).indexMtimeMs = 0;
  const result = cache.reconcileCacheFromFilesystem();
  assert.ok(f.rows.has('b'), 'running session must stay in the sidebar');
  assert.ok(f.search.has('b'), 'running search entry survives reconciliation');
  assert.equal(result, undefined, 'reconcile retains its synchronous contract');
  f.activeSessions.delete('b');
  cache.releaseLiveSession('b');
  assert.ok(!f.rows.has('b'));
});

test('full and subset worker scans keep running missing rows until release', { timeout: 9000 }, async t => {
  const f = fixture(t);
  f.write('a', [f.msg('a-own', '01')]);
  f.write('b', [f.msg('b-own', '02')]);
  await cache.scanFoldersViaWorker({ projectsDir: f.root, folders: [f.folder] });
  f.activeSessions.set('b', { exited: false });
  fs.unlinkSync(path.join(f.dir, 'b.jsonl'));
  await cache.scanFoldersViaWorker({ projectsDir: f.root, folders: [f.folder], fileSubsets: new Map([[f.folder, new Set(['b.jsonl'])]]) });
  assert.ok(f.rows.has('b'), 'subset keeps a running missing row');
  await cache.scanFoldersViaWorker({ projectsDir: f.root, folders: [f.folder] });
  assert.ok(f.rows.has('b'), 'full repair keeps a running missing row');
});

test('complete UUID histories build no payload signatures, mixed coverage builds them lazily', { timeout: 9000 }, t => {
  const f = fixture(t);
  f.write('a', [f.msg('shared', '01')]);
  f.write('b', [f.msg('shared', '01'), f.msg('own', '02')]);
  const stringify = JSON.stringify;
  let signatures = 0;
  JSON.stringify = (value, ...args) => {
    if (Array.isArray(value) && ['user', 'assistant'].includes(value[0]) && value[1]?.content) signatures++;
    return stringify(value, ...args);
  };
  try {
    mergeBridgeGroups([], ['a', 'b'].map(id => f.reread(id)), f.reread);
    assert.equal(signatures, 0, 'fully identified messages need no payload serialization');
    f.write('a', [f.msg(undefined, '01', 'Copied legacy'), f.msg('known', '03')]);
    f.write('b', [f.msg(undefined, '01', 'Copied legacy'), f.msg('own', '02')]);
    const merged = mergeBridgeGroups([], ['a', 'b'].map(id => f.reread(id)), f.reread);
    assert.ok(signatures > 0);
    assert.equal(merged.toUpsert.find(row => row.sessionId === 'b').messageCount, 1);
  } finally { JSON.stringify = stringify; }
});

test('sidebar before the first SSH round trip cannot bless a dormant repaired remote folder', { timeout: 9000 }, async t => {
  const f = fixture(t);
  const remote = path.join(f.root, 'remote', 'vps', 'projects');
  const dir = path.join(remote, '-srv-demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'dormant.jsonl'), [
    { type: 'user', uuid: 'remote-own', cwd: '/srv/demo', timestamp: '2026-10-01T10:00:00.000Z', message: { content: 'Remote synthetic' } },
    { type: 'bridge-session', bridgeSessionId: 'cse_remote' },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  cache.setRemoteRoots(new Map([['vps', remote]]));
  f.settings.set('bridge_uuid_reindex_folders', ['vps::-srv-demo']);
  cache.buildProjectsFromCache(false);
  const scans = [];
  const indexer = createRemoteIndexer({
    getHosts: () => [{ alias: 'vps' }], dataDir: f.root, transport: {},
    listIndexedFolderKeys: () => [...f.meta.keys()],
    scanFolders: async args => { scans.push(args); return cache.scanFoldersViaWorker(args); },
    sync: async () => ({ fetched: 0, unchanged: 1, removed: 0, failed: 0, changedFolders: new Set(), sessions: [] }),
  });
  t.after(() => indexer.dispose());
  await indexer.refreshNow();
  assert.equal(scans.length, 1, 'dormant mirror must get a full scan despite no SSH file changes');
  assert.equal(scans[0].fileSubsets, undefined);
  assert.ok(f.rows.has('dormant'));
  assert.ok(f.meta.has('vps::-srv-demo'));
  assert.deepEqual(f.settings.get('bridge_uuid_reindex_folders'), []);
});
