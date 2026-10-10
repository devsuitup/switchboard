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
  const rows = new Map(), meta = new Map(), metrics = new Map(), search = new Map();
  const db = {
    getCachedByFolder: key => [...rows.values()].filter(r => r.folder === key),
    getAllCached: () => [...rows.values()], getAllMeta: () => new Map(), getAllFolderMeta: () => meta,
    getFolderMeta: key => meta.get(key), getSetting: () => null, getMeta: () => null, setName() {},
    setFolderMeta: (key, projectPath, indexMtimeMs) => meta.set(key, { projectPath, indexMtimeMs }),
    upsertCachedSessions: fresh => fresh.forEach(r => rows.set(r.sessionId, { ...r })),
    deleteCachedSession: id => { rows.delete(id); metrics.delete(id); },
    deleteCachedFolder: key => { for (const r of rows.values()) if (r.folder === key) { rows.delete(r.sessionId); metrics.delete(r.sessionId); } },
    deleteSearchFolder: key => { for (const r of search.values()) if (r.folder === key) search.delete(r.id); },
    deleteSearchSession: id => search.delete(id),
    upsertSearchEntries: entries => entries.forEach(e => search.set(e.id, e)),
    replaceSessionMetrics: (id, daily) => metrics.set(id, daily), touchCachedModified() {},
  };
  cache.init({ PROJECTS_DIR: root, activeSessions: new Map(), getMainWindow: () => null, log: console, db });
  cache.setRemoteRoots(new Map());
  t.after(() => cache.setRemoteRoots(new Map()));
  return { root, folder, dir, write, msg, reread, rows, meta, db, metrics, search };
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

test('bridge refresh after parent activity agrees with a full scan and performs no main-thread body reads', { timeout: 9000 }, async t => {
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
  try { await cache.refreshFolder(f.folder, { files: new Set(['a.jsonl']) }); }
  finally { fs.readFileSync = original; }
  assert.equal(f.rows.get('c').mergedIntoSessionId, null);
  const compact = rows => rows.map(r => [r.sessionId, r.messageCount, r.mergedIntoSessionId || null]).sort();
  assert.deepEqual(compact([...f.rows.values()]), compact(cache.readFolderFromFilesystem(f.folder).sessions));
  assert.deepEqual(reads, [], 'bridge bodies belong to the worker');
});

test('deleting A restores the shared UUIDs of independent B promoted to first member', { timeout: 9000 }, async t => {
  const f = fixture(t);
  f.write('a', [f.msg('shared', '01'), f.msg('a-late', '09')]);
  f.write('b', [f.msg('shared', '01'), f.msg('b-own', '04')]);
  await cache.scanFoldersViaWorker({ projectsDir: f.root, folders: [f.folder] });
  assert.equal(f.rows.get('b').messageCount, 1);
  assert.equal(f.rows.get('b').mergedIntoSessionId, null);
  fs.unlinkSync(path.join(f.dir, 'a.jsonl'));
  await cache.refreshFolder(f.folder, { files: new Set(['a.jsonl']) });
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

test('discovering another bridge member reads predecessors in the worker and drops transient evidence before persistence', { timeout: 9000 }, async t => {
  const f = fixture(t);
  f.write('a', [f.msg('shared', '01'), f.msg('a-own', '02')]);
  f.write('b', [f.msg('b-own', '03')]);
  await cache.scanFoldersViaWorker({ projectsDir: f.root, folders: [f.folder] });
  f.write('c', [f.msg('b-own', '03'), f.msg('c-own', '04')]);
  const reads = [], original = fs.readFileSync;
  fs.readFileSync = (file, ...args) => { if (String(file).startsWith(f.dir) && String(file).endsWith('.jsonl')) reads.push(file); return original(file, ...args); };
  try { await cache.refreshFolder(f.folder, { files: new Set(['c.jsonl']) }); }
  finally { fs.readFileSync = original; }
  assert.deepEqual(reads, []);
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

test('warm worker reconciliation drops a cached local folder whose transcripts now reject its cwd', { timeout: 9000 }, async t => {
  const f = fixture(t);
  f.write('a', [f.msg('a-own', '01')]);
  await cache.scanFoldersViaWorker({ projectsDir: f.root, folders: [f.folder] });
  assert.ok(f.rows.has('a'));
  f.write('a', [{ ...f.msg('a-own', '01'), cwd: path.join(f.root, 'wrong-project') }]);
  await cache.reconcileCacheFromFilesystem();
  assert.ok(!f.rows.has('a'));
  assert.ok(!f.search.has('a'));
});

test('warm repair reconciliation returns before reading bridged transcript bodies', { timeout: 9000 }, async t => {
  const f = fixture(t);
  f.write('a', [f.msg('a-open', '01')]);
  f.write('b', [f.msg('b-own', '02')]);
  const reads = [], original = fs.readFileSync;
  fs.readFileSync = (file, ...args) => { if (String(file).startsWith(f.dir) && String(file).endsWith('.jsonl')) reads.push(file); return original(file, ...args); };
  try { await cache.reconcileCacheFromFilesystem(); }
  finally { fs.readFileSync = original; }
  assert.deepEqual(reads, []);
  assert.equal(f.rows.size, 2);
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
});
