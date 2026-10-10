const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { readSessionFile, mergeBridgeGroups } = require('../read-session-file');
const sessionCache = require('../session-cache');
const { encodeProjectPath } = require('../encode-project-path');

function fixture(t, shared = false, withoutUuids = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-524-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = encodeProjectPath(root);
  const dir = path.join(root, folder);
  fs.mkdirSync(dir);
  const user = (uuid, timestamp, text) => ({ type: 'user', uuid, timestamp, cwd: root, message: { content: text } });
  const assistant = (uuid, timestamp, tokens) => ({ type: 'assistant', uuid, timestamp,
    message: { model: 'claude-sonnet-4-6', usage: { input_tokens: tokens }, content: [{ type: 'text', text: uuid }] } });
  const prefix = [user('shared-user', '2026-10-01T10:00:00.000Z', 'Synthetic opening'),
    assistant('shared-answer', '2026-10-02T10:00:00.000Z', 100)];
  const records = {
    a: [...prefix, assistant('a-late', '2026-10-09T10:00:00.000Z', 7)],
    b: [...(shared ? [prefix[1]] : []), user('b-user', '2026-10-03T10:00:00.000Z', 'Synthetic independent work'),
      assistant('b-answer', '2026-10-04T10:00:00.000Z', 9)],
    mirror: [assistant('a-late', '2026-10-09T10:00:00.000Z', 7),
      user('mirror-user', '2026-10-10T10:00:00.000Z', 'Synthetic continuation'),
      assistant('mirror-answer', '2026-10-10T10:00:01.000Z', 4)],
  };
  for (const [id, entries] of Object.entries(records)) {
    if (withoutUuids) for (const entry of entries) delete entry.uuid;
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), entries.concat({ type: 'bridge-session', bridgeSessionId: 'cse_fixture' })
      .map(e => JSON.stringify(e)).join('\n') + '\n');
  }
  const reread = (id, cutoff, excludedMessageUuids) => readSessionFile(path.join(dir, `${id}.jsonl`), folder, root,
    { dedupeSinceTimestamp: cutoff, excludedMessageUuids });
  return { root, folder, dir, reread };
}

test('an empty cutoff cannot drop distinct legacy messages without UUIDs', { timeout: 9000 }, t => {
  const f = fixture(t, false, true);
  const fresh = ['a', 'b', 'mirror'].map(id => f.reread(id, null));
  const { toUpsert, toDelete } = mergeBridgeGroups([], fresh, f.reread);
  const b = toUpsert.find(row => row.sessionId === 'b');
  assert.ok(b, 'distinct legacy messages must survive an empty cutoff');
  assert.equal(b.messageCount, 2);
  assert.equal(b.mergedIntoSessionId, null);
  assertRows(toUpsert);
  assert.deepEqual(toDelete, []);
});

function assertRows(rows) {
  const b = rows.find(r => r.sessionId === 'b');
  assert.ok(b, 'B must survive even though all its entries precede A.modified');
  assert.equal(b.messageCount, 2, 'B keeps both own messages and excludes shared UUIDs');
  assert.equal(b.mergedIntoSessionId, null, 'the divergent member remains a visible independent row');
  assert.equal(b.dailyMetrics.reduce((n, r) => n + r.inputTokens, 0), 9);
  assert.ok(b.textContent.includes('Synthetic independent work'));
  assert.ok(!b.textContent.includes('shared-answer'));
  const mirror = rows.find(r => r.sessionId === 'mirror');
  assert.ok(mirror, 'a genuine continuing compaction mirror retains its row');
  assert.equal(mirror.mergedIntoSessionId, 'a');
  assert.equal(mirror.messageCount, 2);
  assert.equal(mirror.dailyMetrics.reduce((n, r) => n + r.inputTokens, 0), 4);
  assert.equal(rows.reduce((n, r) => n + r.messageCount, 0), 7, 'shared UUIDs count only once across the group');
}

function memoryDb(cached = []) {
  const store = new Map(cached.map(r => [r.sessionId, { ...r }]));
  const deleted = [];
  const metrics = new Map();
  const search = new Map();
  const db = {
    getCachedByFolder: folder => [...store.values()].filter(r => r.folder === folder),
    getAllCached: () => [...store.values()], getAllMeta: () => new Map(), getAllFolderMeta: () => new Map(),
    getSetting: () => null, getMeta: () => null, setName() {}, setFolderMeta() {}, touchCachedModified() {},
    deleteCachedFolder() {}, deleteSearchFolder() {},
    upsertCachedSessions: rows => rows.forEach(r => {
      const persisted = { ...r };
      delete persisted.messageUuids;
      delete persisted.messageUuidsComplete;
      delete persisted.messageSignatures;
      store.set(r.sessionId, persisted);
    }),
    deleteCachedSession: id => { deleted.push(id); store.delete(id); },
    replaceSessionMetrics: (id, rows) => metrics.set(id, rows),
    upsertSearchEntries: rows => rows.forEach(r => search.set(r.id, r)),
    deleteSearchSession: id => search.delete(id),
  };
  return { db, store, deleted, metrics, search };
}

function init(f, db) {
  sessionCache.init({ PROJECTS_DIR: f.root, activeSessions: new Map(), getMainWindow: () => null, log: console, db });
}

for (const shared of [false, true]) {
  test(`full merge preserves old unique messages, shared UUIDs=${shared}, and a genuine mirror`, { timeout: 9000 }, t => {
    const f = fixture(t, shared);
    const fresh = ['a', 'b', 'mirror'].map(id => f.reread(id, null));
    assert.ok(fresh.every(Boolean));
    const { toUpsert, toDelete } = mergeBridgeGroups([], fresh, f.reread);
    assertRows(toUpsert);
    assert.deepEqual(toDelete, []);
  });

  test(`incremental cached member survives parent discovery, shared UUIDs=${shared}`, { timeout: 9000 }, t => {
    const f = fixture(t, shared);
    const m = memoryDb();
    init(f, m.db);
    sessionCache.refreshFolder(f.folder, { files: new Set(['b.jsonl']) });
    assert.ok(m.store.has('b'));
    sessionCache.refreshFolder(f.folder, { files: new Set(['a.jsonl', 'mirror.jsonl']) });
    assertRows([...m.store.values()]);
    assert.ok(!m.deleted.includes('b'), 'the cached member must never be sent to deleteCachedSession');
    assert.equal(m.metrics.get('b').reduce((n, r) => n + r.inputTokens, 0), 9);
    assert.ok(m.search.get('b').body.includes('Synthetic independent work'));
    const project = sessionCache.buildProjectsFromCache(false).find(p => p.projectPath === f.root);
    assert.deepEqual(project.sessions.map(s => s.sessionId).sort(), ['a', 'b']);
    const originalRead = fs.readFileSync;
    const bodyReads = [];
    fs.readFileSync = (file, ...args) => {
      if (path.dirname(String(file)) === f.dir && String(file).endsWith('.jsonl')) bodyReads.push(file);
      return originalRead(file, ...args);
    };
    try { sessionCache.refreshFolder(f.folder); }
    finally { fs.readFileSync = originalRead; }
    assertRows([...m.store.values()]);
    assert.deepEqual(bodyReads, [], 'an unchanged bridge group does not repeatedly read full transcripts');
  });
}

test('full session-cache scan preserves a divergent member and deduplicates the mirror', { timeout: 9000 }, t => {
  const f = fixture(t, true);
  init(f, memoryDb().db);
  assertRows(sessionCache.readFolderFromFilesystem(f.folder).sessions);
});

test('shared opening prompt does not hide an older member with only its own assistant reply', { timeout: 9000 }, t => {
  const f = fixture(t, true);
  const opening = JSON.parse(fs.readFileSync(path.join(f.dir, 'a.jsonl'), 'utf8').split('\n')[0]);
  fs.writeFileSync(path.join(f.dir, 'b.jsonl'), [opening,
    { type: 'assistant', uuid: 'b-only-reply', timestamp: '2026-10-04T10:00:00.000Z',
      message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 9 }, content: [{ type: 'text', text: 'Own reply' }] } },
    { type: 'bridge-session', bridgeSessionId: 'cse_fixture' },
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const { toUpsert } = mergeBridgeGroups([], ['a', 'b'].map(id => f.reread(id, null)), f.reread);
  const b = toUpsert.find(row => row.sessionId === 'b');
  assert.ok(b, 'an own assistant reply must survive exclusion of the shared opening prompt');
  assert.equal(b.messageCount, 1);
  assert.equal(b.summary, 'Synthetic opening');
  assert.equal(b.mergedIntoSessionId, null);
  assert.ok(!b.textContent.includes('Synthetic opening'));
  assert.equal(b.dailyMetrics.reduce((n, row) => n + row.inputTokens, 0), 9);
});

for (const partial of [false, true]) {
  test(`scan worker preserves the member, partial=${partial}`, { timeout: 9000 }, async t => {
    const f = fixture(t, true);
    const workerData = partial
      ? { projectsDir: f.root, folders: [], targets: [{ folder: f.folder, files: ['a.jsonl', 'mirror.jsonl'], existingRows: [f.reread('b', null)] }] }
      : { projectsDir: f.root };
    const worker = new Worker(path.join(__dirname, '..', 'workers', 'scan-projects.js'), { workerData });
    t.after(() => worker.terminate());
    const messages = [];
    await new Promise((resolve, reject) => {
      worker.on('message', msg => messages.push(msg));
      worker.on('error', reject);
      worker.on('exit', code => code === 0 ? resolve() : reject(new Error(`worker exit ${code}`)));
    });
    const result = messages.find(msg => msg.type === 'folder').result;
    const rows = partial ? [f.reread('b', null), ...result.sessions.filter(r => r.sessionId !== 'b')] : result.sessions;
    if (partial) {
      const b = result.sessions.find(r => r.sessionId === 'b');
      assert.ok(b, 'the cached B must be re-upserted rather than deleted');
      rows[0] = b;
      assert.ok(!result.toDelete.includes('b'));
    }
    assertRows(rows);
  });
}
