'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { createWriterCommands } = require('../session-index-commands');
const { createSessionIndexWriter } = require('../session-index-writer');
const os = require('node:os');
const openStore = require('./fixtures/conversation-store.cjs');
require('./fixtures/isolated-codex-home.cjs')(test);

function durableFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-1144-'));
  const previous = process.env.SWITCHBOARD_DATA_DIR;
  process.env.SWITCHBOARD_DATA_DIR = root;
  let store = openStore();
  t.after(() => {
    store.closeDb();
    process.env.SWITCHBOARD_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, get store() { return store; }, reopen() { store.closeDb(); store = openStore(); return store; } };
}

const sqliteSkip = !openStore.supported && 'SQLite requires native binding or Node 22';

for (const held of ['beginFullIndex', 'effects', 'certifyFullReads', 'sealFullIndex']) {
  test('Codex publication interruption cannot create a false seal: held ' + held, { skip: sqliteSkip }, async t => {
    const f = await require('./fixtures/warm-start-1152.cjs').fixture(t), file = f.codexWrite(0);
    assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
    fs.appendFileSync(file, '\n');
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const request = f.worker.client.request, order = [];
    f.worker.client.request = async (name, ...args) => {
      const affected = name === 'effects' ? args[0].some(effect => effect.name === 'setFolderMeta' && effect.args[0] === f.codexFolder) : args[0] === f.codexFolder;
      if (affected) order.push(name);
      const reply = await request(name, ...args);
      if (name === held && affected) { entered(); await gate; }
      return reply;
    };
    const pending = f.restart();
    assert.equal(await Promise.race([started.then(() => true), pending.then(() => false)]), true, 'publication cannot finish before the requested ACK stage');
    try {
      assert.ok(!f.logs.some(line => line.includes('[status] (done)')), 'no done status precedes the held ACK');
      if (held !== 'sealFullIndex') {
        assert.ok(!order.includes('sealFullIndex'), 'no seal request precedes the held effect or certificate ACK');
        assert.ok(f.db.getFolderMeta(f.codexFolder).fullIndexPending, 'held ACK leaves a conservative pending publication');
      }
    } finally { release(); }
    assert.equal((await pending).ok, true);
  });
}

for (const mode of ['full', 'partial', 'deletion']) for (const lost of ['beginFullIndex', 'effects', 'certifyFullReads', 'sealFullIndex']) {
  if (mode === 'deletion' && lost === 'certifyFullReads') continue;
  test('Codex publication interruption cannot create a false seal: ' + mode + ' ' + lost, { skip: sqliteSkip }, async t => {
    const f = await require('./fixtures/warm-start-1152.cjs').fixture(t);
    const file = f.codexWrite(0);
    assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
    assert.equal((await f.restart()).ok, true);
    assert.equal(f.codexScans()[0].mode, 'partial', 'Codex ACK qualification uses the startup subset route');
    if (mode === 'deletion') fs.unlinkSync(file); else fs.appendFileSync(file, '\n');
    const request = f.worker.client.request, order = [];
    f.worker.client.request = async (name, ...args) => {
      const affected = name === 'effects' ? args[0].some(effect => effect.name === 'setFolderMeta' && effect.args[0] === f.codexFolder) : args[0] === f.codexFolder;
      if (affected) order.push(name);
      const reply = await request(name, ...args);
      if (name === lost && affected) throw Object.assign(new Error('lost ACK'), { code: 'WRITER_TIMEOUT' });
      return reply;
    };
    assert.equal((await f.restart({ force: mode === 'full' })).ok, false, 'lost publication ACK cannot report successful qualification');
    if (lost !== 'sealFullIndex') assert.ok(!order.includes('sealFullIndex'), 'seal cannot precede all materialization ACKs');
    else if (mode !== 'deletion') assert.ok(order.indexOf('effects') < order.indexOf('certifyFullReads') && order.indexOf('certifyFullReads') < order.indexOf('sealFullIndex'), 'effects then certificates then seal');
    else assert.ok(order.indexOf('effects') < order.indexOf('sealFullIndex'), 'deletion effects precede the seal');
    const reader = openStore({ readonly: true });
    try {
      if (lost !== 'sealFullIndex') assert.ok(reader.getFolderMeta(f.codexFolder).fullIndexPending, 'pending state survives a new connection');
      else assert.equal(reader.getFolderMeta(f.codexFolder).fullIndexVersion, 1, 'committed seal followed only acknowledged effects');
    } finally { reader.closeDb(); }
    f.worker.client.request = request;
    await f.reopen();
    assert.equal((await f.restart({ force: true })).ok, true);
  });
}

test('full folder publication uses one certificate request for all rows', { skip: sqliteSkip }, async t => {
  const f = durableFixture(t), calls = [];
  const worker = require('./fixtures/project-deletion-worker.cjs')(f.store);
  const writer = createSessionIndexWriter({ readonlyBackend: f.store, client: {
    ready: Promise.resolve(), request: (name, ...args) => { calls.push(name); return worker.client.request(name, ...args); },
  } });
  await writer.ready;
  writer.initializeCache({ PROJECTS_DIR: f.root, activeSessions: new Map(), getMainWindow: () => null, log: console });
  const file = path.join(f.root, 'source.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { content: 'batch body' } }) + '\n');
  const row = require('../read-session-file').readSessionFile(file, 'folder', f.root);
  const sessions = Array.from({ length: 80 }, (_, i) => ({ ...row, sessionId: 'session-' + i }));
  await writer.writeScannedFolder({ folder: 'folder', projectPath: f.root, sessions, indexMtimeMs: 1 });
  assert.equal(calls.filter(name => name.startsWith('certifyFullRead')).length, 1, 'one certificate request per folder, independent of row count');
  assert.equal(f.store.getAllCached().filter(row => row.fullReadStamp).length, sessions.length);
  assert.equal(f.store.getFolderMeta('folder').fullIndexVersion, 1);
});

test('no-summary header refresh discards the previous full-read certificate', { skip: sqliteSkip }, async t => {
  const f = await publicationFixture(t);
  await f.writer.writeScannedFolder(f.result());
  fs.writeFileSync(f.file, JSON.stringify({ type: 'system', cwd: f.root, message: 'no display summary' }) + '\n');
  fs.utimesSync(f.file, new Date('2030-01-01'), new Date('2030-01-01'));
  await f.writer.refreshFolder(f.folder);
  const cached = f.db.getCachedSession('source');
  assert.equal(cached.modified, '2030-01-01T00:00:00.000Z');
  assert.equal(cached.fullReadStamp, null, 'no-summary header merge cannot retain a full-read certificate');
});

test('batched certificates retain rejection across bounded transactions and report revision gaps', { skip: sqliteSkip }, async t => {
  const f = durableFixture(t), db = f.store;
  const worker = require('./fixtures/project-deletion-worker.cjs')(db);
  const rows = Array.from({ length: 80 }, (_, i) => ({ sessionId: 'row-' + i, folder: 'folder', summary: 'body' }));
  db.upsertCachedSessions(rows);
  db.beginFullIndex('folder', 'token');
  const { rowWitness } = require('../src/main/session-index/full-read-state');
  const certificates = rows.map(row => ({ sessionId: row.sessionId, stamp: 'certificate', witness: rowWitness(db.getCachedSession(row.sessionId)) }));
  certificates[0].witness = 'stale';
  const measuredBefore = db.measurements().length;
  const original = db.certifyFullRead;
  const revisions = new Map();
  let interleaved;
  db.certifyFullRead = (...args) => {
    const revision = db.getSetting('_writer_revision') || 0;
    revisions.set(revision, (revisions.get(revision) || 0) + 1);
    if (!interleaved) interleaved = worker.client.request('setSetting', 'unrelated', true);
    return original(...args);
  };
  const results = await Promise.allSettled([worker.client.request('certifyFullReads', 'folder', 'token', certificates, { receipt: true })]);
  assert.equal(results[0].status, 'fulfilled', 'worker accepts one bounded certificate command');
  await interleaved;
  const ack = results[0].value;
  assert.equal(ack.certified, false, 'later successful rows cannot erase an earlier witness rejection');
  assert.equal(ack.continuous, false, 'receipt exposes an unrelated revision between chunks without rejecting certificates');
  assert.ok(revisions.size > 1, 'large folder certificates split across transactions');
  assert.ok(db.measurements().slice(measuredBefore).every(sample => sample.rows <= 32 && sample.bytes <= 65536), 'certificate transactions obey the row and byte budgets');
  assert.equal(db.getAllCached().filter(row => row.fullReadStamp).length, 79);
  db.beginFullIndex('folder', 'new-token');
  assert.equal(await worker.client.request('certifyFullReads', 'folder', 'token', certificates), false, 'superseded folder token rejects the batch');
});

test('facade returns the body acknowledgment when real certificate chunks contain an unrelated revision', { skip: sqliteSkip }, async t => {
  const f = durableFixture(t), db = f.store;
  const worker = require('./fixtures/project-deletion-worker.cjs')(db);
  let bodyAck, certificateAck, interleaved;
  const writer = createSessionIndexWriter({ readonlyBackend: db, client: { ready: Promise.resolve(), request: async (name, ...args) => {
    const ack = await worker.client.request(name, ...args);
    if (name === 'effects') bodyAck = ack;
    if (name === 'certifyFullReads') certificateAck = ack;
    return ack;
  } } });
  await writer.ready;
  writer.initializeCache({ PROJECTS_DIR: f.root, activeSessions: new Map(), getMainWindow: () => null, log: console });
  const original = db.certifyFullRead;
  db.certifyFullRead = (...args) => {
    if (!interleaved) interleaved = worker.client.request('setSetting', 'during-first-certificate-chunk', true);
    return original(...args);
  };
  const rows = Array.from({ length: 80 }, (_, i) => ({ sessionId: 'facade-' + i, folder: 'folder', projectPath: f.root,
    summary: 'body', fullReadStamp: 'candidate' }));
  const result = await writer.applyProjectsWorkerEffects({ keptLiveRows: [], effects: [
    { name: 'upsertCachedSessions', args: [rows] },
    ...rows.map(row => ({ name: 'replaceSessionMetrics', args: [row.sessionId, []] })),
  ] });
  await interleaved;
  assert.equal(certificateAck.continuous, false, 'real worker detects the interleaved setting between certificate chunks');
  assert.deepEqual(result, bodyAck, 'facade returns exactly the body receipt when certificate continuity is false');
  assert.notDeepEqual(result, certificateAck);
});

async function publicationFixture(t, intercept = () => {}) {
  const f = durableFixture(t), db = f.store, calls = [], notifications = [], warnings = [];
  const commands = createWriterCommands(db);
  const { commitTransaction } = require('../src/main/projects/project-delete-progress');
  const apply = (name, args) => commitTransaction(db, () => (commands[name] || db[name])(...args));
  const writer = createSessionIndexWriter({ readonlyBackend: db,
    onSessionsChanged: ids => notifications.push(ids), log: { warn: value => warnings.push(value) },
    client: { ready: Promise.resolve(), request: async (name, ...args) => {
      calls.push({ name, args });
      intercept(name, args, db);
      if (name !== 'effects') return apply(name, args).result;
      if (args[1] !== (db.getSetting('_writer_revision') || 0)) throw Object.assign(new Error('interleaved revision'), { code: 'WRITER_STALE' });
      let ack;
      for (const effect of args[0]) ack = apply(effect.name, effect.args);
      return ack;
    } } });
  await writer.ready;
  writer.initializeCache({ PROJECTS_DIR: f.root, activeSessions: new Map(), getMainWindow: () => null, log: { info() {}, warn() {}, error() {} } });
  const folder = require('../encode-project-path').encodeProjectPath(f.root), dir = path.join(f.root, folder);
  fs.mkdirSync(dir);
  const file = path.join(dir, 'source.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd: f.root, timestamp: '2024-01-01T00:00:00.000Z', message: { content: 'complete body' } }) + '\n');
  const row = require('../read-session-file').readSessionFile(file, folder, f.root);
  return { ...f, db, writer, folder, file, row, calls, notifications, warnings,
    result: () => ({ folder, projectPath: f.root, sessions: [row], indexMtimeMs: 1 }) };
}

test('unchanged watcher refresh updates folder metadata and leaves pending repair uncertified', { skip: sqliteSkip }, async t => {
  const f = await publicationFixture(t);
  await f.writer.writeScannedFolder(f.result());
  f.calls.length = 0;
  await f.writer.refreshFolder(f.folder);
  assert.deepEqual(f.calls.map(call => call.name), ['effects']);
  assert.deepEqual(f.calls[0].args[0].map(effect => effect.name), ['setFolderMeta']);
  f.db.setSetting('bridge_uuid_reindex_folders', [f.folder]);
  f.calls.length = 0;
  await f.writer.refreshFolder(f.folder);
  assert.deepEqual(f.calls.map(call => call.name), ['effects']);
  assert.deepEqual(f.calls[0].args[0].map(effect => effect.name), ['invalidateFullIndex', 'setFolderMeta']);
  assert.equal(f.db.getFolderMeta(f.folder).fullIndexVersion, null);
  assert.deepEqual(Array.from(f.db.getSetting('bridge_uuid_reindex_folders')), [f.folder]);
});

test('header refresh clears certificate even when the source stamp has not changed', { skip: sqliteSkip }, async t => {
  const f = await publicationFixture(t);
  f.db.upsertCachedSessions([{ ...f.row, projectPath: f.root + '-old' }]);
  f.db.setFolderMeta(f.folder, f.root, 1);
  await f.writer.refreshFolder(f.folder);
  const row = f.db.getCachedSession('source');
  assert.equal(row.projectPath, f.root);
  assert.equal(row.fileMtime, f.row.fileMtime);
  assert.equal(row.fullReadStamp, null, 'header-only refresh must clear the full-read certificate');
});

test('full folder replacement preserves the broad session invalidation notification', { skip: sqliteSkip }, async t => {
  const f = await publicationFixture(t);
  f.db.upsertCachedSessions([{ sessionId: 'old', folder: f.folder }]);
  await f.writer.writeScannedFolder(f.result());
  assert.deepEqual(f.notifications, [null], 'folder replacement invalidates linked and merged memos');
});

for (const fault of ['interleaved-header', 'certificate-timeout', 'unrelated-write']) {
  test('certificate stage does not fail committed body: ' + fault, { skip: sqliteSkip }, async t => {
    let interleaved = false;
    const f = await publicationFixture(t, (name, args, db) => {
      const certificate = name === 'certifyFullReads';
      if (!certificate) return;
      if (fault === 'certificate-timeout') throw Object.assign(new Error('certificate outcome unknown'), { code: 'WRITER_TIMEOUT' });
      if (!interleaved) {
        interleaved = true;
        if (fault === 'interleaved-header') db.touchCachedModified('source', '2030-01-01T00:00:00.000Z');
        db.setSetting('_writer_revision', (db.getSetting('_writer_revision') || 0) + 1);
      }
    });
    await assert.doesNotReject(f.writer.writeScannedFolder(f.result()), 'committed body resolves despite certificate failure');
    assert.equal(f.db.getCachedSession('source').summary, f.row.summary);
    if (fault === 'unrelated-write') assert.equal(f.db.getFolderMeta(f.folder).fullIndexVersion, 1);
    else {
      assert.equal(f.db.getFolderMeta(f.folder).fullIndexVersion, null, 'failed or superseded certificate leaves folder unsealed');
      assert.equal(f.calls.some(call => call.name === 'sealFullIndex'), false);
    }
    if (fault === 'certificate-timeout') assert.ok(f.warnings.some(value => value.includes('outcome unknown')));
  });
}

test('deletion counters include folder drops when begin failed', { skip: sqliteSkip }, async t => {
  const f = await publicationFixture(t, name => { if (name === 'beginFullIndex') throw new Error('begin failed'); });
  f.db.upsertCachedSessions([{ sessionId: 'old', folder: f.folder }]);
  const result = f.result();
  await f.writer.writeScannedFolder(result);
  assert.equal(result.counters.filesDeleted, 1);
});

test('deletion-only subset counts removals without beginning a full read', { skip: sqliteSkip }, async t => {
  const f = await publicationFixture(t);
  f.db.upsertCachedSessions([{ sessionId: 'old', folder: f.folder }]);
  const result = { ...f.result(), sessions: [], toDelete: ['old'], partial: true };
  await f.writer.writeScannedFolderPartial(result);
  assert.equal(result.counters?.filesDeleted, 1, 'subset counts deleted files even without full reads');
  assert.deepEqual(f.calls.map(call => call.name), ['effects']);
});

test('null subset scan target retains the guarded folder field', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'null-target-1144-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.join(__dirname, '../workers/scan-projects.js'), native = createRequire(filename), messages = [];
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { Buffer, console, process,
    require: name => name === 'worker_threads' ? { workerData: { projectsDir: root, folders: [], targets: [null] }, parentPort: { postMessage: msg => messages.push(msg) } }
      : name === '../src/main/session-index/read-counters' ? { ...native(name), measureFolder: () => ({ result: null, counters: {} }) } : native(name),
  }, { filename });
  assert.equal(messages.at(-1).ok, true, 'null target must not abort the scan');
});

test('memory backend implements full-read publication commands', async t => {
  const h = require('./fixtures/continuation-718.cjs').fixture(t);
  h.write('source');
  const writer = require('./fixtures/writer-memory.cjs').memoryWriter(h.db, require('../session-cache'));
  await writer.ready;
  writer.initializeCache({ PROJECTS_DIR: h.root, activeSessions: h.activeSessions, getMainWindow: () => null, log: h.log });
  await assert.doesNotReject(writer.refreshFolder(h.folder), 'memory publication accepts certificate commands');
  assert.ok(h.rows.get('source').fullReadStamp, 'memory publication persists the full-read certificate');
});

test('certificate statements are prepared once per store', { skip: sqliteSkip }, t => {
  const { store: db } = durableFixture(t);
  db.setFolderMeta('folder', '/project', 1);
  db.upsertCachedSessions([{ sessionId: 'source', folder: 'folder' }]);
  const witness = require('../src/main/session-index/full-read-state').rowWitness(db.getCachedSession('source'));
  const prepare = t.mock.method(db.connection, 'prepare');
  for (let n = 0; n < 2; n++) {
    db.beginFullIndex('folder', 'token');
    db.certifyFullRead('folder', 'token', 'source', 'stamp', witness);
    db.invalidateFullRead('source');
    db.sealFullIndex('folder', 'token', 1, 'config');
    db.invalidateFullIndex('folder');
  }
  assert.equal(prepare.mock.callCount(), 0, 'certificate hot path reuses prepared statements');
});

test('real writer queue preserves folder token through drop and certifies after unrelated revision', { skip: sqliteSkip }, async t => {
  const { store: db } = durableFixture(t), port = new EventEmitter(), replies = new Map();
  let id = 0;
  port.postMessage = message => { if (message.id && !message.started) replies.get(message.id)?.(message); };
  const filename = require.resolve('../workers/session-index-writer'), native = createRequire(filename);
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: name => name === 'node:worker_threads' ? { parentPort: port }
      : name === '../session-index-store' ? { openSessionIndexStore: () => db } : native(name),
    setInterval: () => ({ unref() {} }),
  }, { filename });
  const send = (command, ...args) => new Promise((resolve, reject) => {
    const token = ++id, timer = setTimeout(() => reject(new Error('writer queue deadline')), 3000);
    replies.set(token, message => {
      clearTimeout(timer); replies.delete(token);
      if (message.error) reject(Object.assign(new Error(message.error.message), message.error));
      else resolve(message.result);
    });
    port.emit('message', { id: token, command, args });
  });
  db.upsertCachedSessions([{ sessionId: 'old', folder: 'folder' }]);
  await send('beginFullIndex', 'folder', 'token');
  await send('effects', [
    { name: 'deleteCachedFolder', args: ['folder', { preserveFullIndex: true }] },
    { name: 'upsertCachedSessions', args: [[{ sessionId: 'source', folder: 'folder', summary: 'body' }]] },
  ], db.getSetting('_writer_revision'));
  assert.equal(db.getFolderMeta('folder')?.fullIndexPending, 'token', 'worker folder drop retains pending token');
  await send('setSetting', 'unrelated', true);
  const witness = require('../src/main/session-index/full-read-state').rowWitness(db.getCachedSession('source'));
  assert.equal(await send('certifyFullReads', 'folder', 'token', [{ sessionId: 'source', stamp: 'stamp', witness }]), true);
  assert.equal(await send('sealFullIndex', 'folder', 'token', 1, 'config'), true);
  assert.equal(db.getCachedSession('source').fullReadStamp, 'stamp');
  await send('drain');
});

test('additive certificates preserve existing database state', { skip: sqliteSkip }, t => {
  const f = durableFixture(t), db = f.store;
  db.upsertCachedSessions([{ sessionId: 'legacy', folder: 'folder', summary: 'retained' }]);
  db.setFolderMeta('folder', '/project', 123);
  db.setName('legacy', 'user name');
  db.setArchived(['legacy'], true);
  db.setSetting('initial_scan_complete', true);
  db.sessionRequests.insert({ stemKey: 'journal', suppliedHash: null, rawHash: 'hash', family: 'legacy', actualStem: 'journal', resultBytes: Buffer.from('retained'), createdAt: 1, completedAt: 2, revision: 3 });
  db.projectDeletion.setFence('retained-fence', 7, null, 1);
  db.upsertSearchEntries([{ id: 'memory', type: 'memory', folder: 'folder', title: 'Memory retained', body: 'Retained body' },
    { id: 'work', type: 'workfile', folder: 'folder', title: 'Work retained', body: 'Retained body' }]);
  assert.equal(db.getCachedSession('legacy').fullReadStamp, null, 'legacy row gets a nullable certificate');
  for (const column of ['fullIndexVersion', 'fullIndexConfig', 'fullIndexPending']) assert.equal(db.getFolderMeta('folder')[column], null);
  db.connection.exec('ALTER TABLE session_cache DROP COLUMN fullReadStamp');
  for (const column of ['fullIndexVersion', 'fullIndexConfig', 'fullIndexPending']) db.connection.exec('ALTER TABLE cache_meta DROP COLUMN ' + column);
  const reopened = f.reopen();
  assert.ok(reopened.getCachedSession('legacy'), 'adding certificate columns preserves the legacy cached row');
  assert.equal(reopened.getCachedSession('legacy').summary, 'retained', 'adding certificate columns must not force reindex');
  assert.equal(reopened.getMeta('legacy').name, 'user name');
  assert.equal(reopened.getMeta('legacy').archived, 1);
  assert.equal(reopened.isInitialScanComplete(), true);
  assert.equal(Buffer.from(reopened.sessionRequests.get('journal').resultBytes).toString(), 'retained');
  assert.equal(reopened.projectDeletion.fence('retained-fence').epoch, 7);
  assert.equal(reopened.connection.prepare('SELECT COUNT(*) AS n FROM search_map').get().n, 2);
  assert.equal(f.reopen().getFolderMeta('folder').indexMtimeMs, 123);
});

test('missing FTS durably invalidates folder seals across a second restart', { skip: sqliteSkip }, t => {
  const f = durableFixture(t), db = f.store;
  const columns = db.connection.prepare('PRAGMA table_info(cache_meta)').all().map(row => row.name);
  assert.ok(columns.includes('fullIndexVersion'), 'folder seals have durable columns');
  db.setFolderMeta('folder', '/project', 1);
  db.connection.exec("UPDATE cache_meta SET fullIndexVersion = 1, fullIndexConfig = 'config'; DROP TABLE search_fts");
  const reopened = f.reopen();
  assert.equal(reopened.getFolderMeta('folder').fullIndexVersion, null, 'FTS absence invalidates a prior seal');
  assert.equal(f.reopen().getFolderMeta('folder').fullIndexVersion, null, 'invalidation survives loss of the bootstrap flag');
});

test('full-read certificates survive only complete publication and the scan own folder drop', { skip: sqliteSkip }, async t => {
  const f = durableFixture(t), db = f.store, calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let staged;
  const entered = new Promise(resolve => { staged = resolve; });
  const commands = createWriterCommands(db);
  const writer = createSessionIndexWriter({ readonlyBackend: db, client: { ready: Promise.resolve(), request: async (name, ...args) => {
    calls.push(name);
    if (name === 'effects') {
      for (const effect of args[0]) {
        if (effect.name === 'upsertSearchEntries') { staged(); await gate; }
        (commands[effect.name] || db[effect.name])(...effect.args);
      }
      return;
    }
    return (commands[name] || db[name])(...args);
  } } });
  await writer.ready;
  writer.initializeCache({ PROJECTS_DIR: f.root, activeSessions: new Map(), getMainWindow: () => null, log: { info() {}, warn() {}, error() {} } });
  const file = path.join(f.root, 'source.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: 'searchable content' } }) + '\n');
  const row = require('../read-session-file').readSessionFile(file, 'folder', f.root);
  const operation = writer.writeScannedFolder({ folder: 'folder', projectPath: f.root, sessions: [row], indexMtimeMs: 1 });
  await entered;
  try {
    assert.equal(db.getCachedSession('source').fullReadStamp, null, 'staged FTS is not complete publication');
    assert.ok(db.getFolderMeta('folder')?.fullIndexPending, 'the folder drop preserves pending ownership');
  } finally { release(); await operation; }
  assert.equal(db.getCachedSession('source').fullReadStamp, row.fullReadStamp);
  assert.equal(db.getFolderMeta('folder').fullIndexVersion, 1);
  assert.equal(db.getFolderMeta('folder').fullIndexPending, null);
  assert.equal(calls[0], 'beginFullIndex');
  assert.equal(calls.at(-1), 'sealFullIndex');
});

test('publication boundary preserves safe durable states for failures and unknown ACKs', { skip: sqliteSkip }, async t => {
  for (const fault of ['begin-before', 'begin-after', 'metrics', 'fts', 'fts-after', 'seal-before', 'seal-after', 'superseded', 'header', 'config']) {
    await t.test(fault, async t => {
      const f = durableFixture(t), db = f.store, commands = createWriterCommands(db), calls = [], warnings = [];
      db.setFolderMeta('folder', f.root, 1);
      db.connection.exec("UPDATE cache_meta SET fullIndexVersion = 1, fullIndexConfig = 'prior'");
      const timeout = () => { throw Object.assign(new Error('outcome unknown'), { code: 'WRITER_TIMEOUT' }); };
      const apply = async (name, args) => {
        calls.push(name);
        if (name === 'beginFullIndex' && fault === 'begin-before') timeout();
        if (name === 'replaceSessionMetrics' && fault === 'metrics') timeout();
        if (name === 'upsertSearchEntries' && fault === 'fts') timeout();
        if (name === 'sealFullIndex' && fault === 'seal-before') timeout();
        if (name === 'certifyFullReads' && fault === 'superseded') db.beginFullIndex('folder', 'newer-token');
        if (name === 'certifyFullReads' && fault === 'header') db.touchCachedModified('source', '2030-01-01T00:00:00.000Z');
        if (name === 'certifyFullReads' && fault === 'config') db.setSetting('projectRemaps', { changed: '/different' });
        const value = (commands[name] || db[name])(...args);
        if (name === 'upsertSearchEntries' && fault === 'fts-after') timeout();
        if (name === 'beginFullIndex' && fault === 'begin-after') timeout();
        if (name === 'sealFullIndex' && fault === 'seal-after') timeout();
        return value;
      };
      const writer = createSessionIndexWriter({ readonlyBackend: db, log: { warn: value => warnings.push(value) },
        client: { ready: Promise.resolve(), request: async (name, ...args) => {
          if (name !== 'effects') return apply(name, args);
          for (const effect of args[0]) await apply(effect.name, effect.args);
        } } });
      await writer.ready;
      writer.initializeCache({ PROJECTS_DIR: f.root, activeSessions: new Map(), getMainWindow: () => null, log: { info() {}, warn() {}, error() {} } });
      const file = path.join(f.root, 'source.jsonl');
      fs.writeFileSync(file, JSON.stringify({ type: 'user', timestamp: '2024-01-01T00:00:00.000Z', message: { content: 'complete body' } }) + '\n');
      const row = require('../read-session-file').readSessionFile(file, 'folder', f.root);
      const result = { folder: 'folder', projectPath: f.root, sessions: [row], indexMtimeMs: 1 };
      if (fault === 'metrics' || fault.startsWith('fts')) await assert.rejects(writer.writeScannedFolder(result), { code: 'WRITER_TIMEOUT' });
      else await writer.writeScannedFolder(result);
      const reopened = f.reopen(), meta = reopened.getFolderMeta('folder'), cached = reopened.getCachedSession('source');
      if (fault === 'seal-after') {
        assert.equal(meta.fullIndexVersion, 1);
        assert.equal(meta.fullIndexPending, null);
        assert.equal(cached.fullReadStamp, row.fullReadStamp);
        assert.equal(cached.summary, row.summary);
        assert.equal(reopened.searchByType('session', 'complete', 10).length, 1);
        const currentDir = process.env.SWITCHBOARD_DATA_DIR;
        process.env.SWITCHBOARD_DATA_DIR = path.join(f.root, 'reference');
        const reference = openStore();
        process.env.SWITCHBOARD_DATA_DIR = currentDir;
        try {
          const cache = require('../session-cache');
          cache.init({ PROJECTS_DIR: f.root, activeSessions: new Map(), getMainWindow: () => null, log: console, db: reference });
          cache.writeScannedFolder(result);
          for (const sql of ['SELECT * FROM session_cache ORDER BY sessionId', 'SELECT * FROM session_metrics ORDER BY sessionId, date, model',
            'SELECT m.id, m.type, m.folder, c.title, c.body FROM search_map m JOIN search_content c USING(rowid) ORDER BY m.id']) {
            assert.equal(JSON.stringify(reopened.connection.prepare(sql).all()), JSON.stringify(reference.connection.prepare(sql).all()), 'committed lost seal ACK equals full rebuild: ' + sql);
          }
        } finally { reference.closeDb(); }
      } else if (fault === 'header') {
        assert.equal(cached.fullReadStamp, null, 'a concurrent header overwrite cannot certify the full-read row');
      } else {
        assert.equal(meta.fullIndexVersion, null, fault + ' cannot leave a valid full-folder seal');
        if (!fault.startsWith('seal-') && fault !== 'config') assert.equal(cached.fullReadStamp, null);
      }
      if (fault.startsWith('begin-')) assert.ok(calls.includes('upsertSearchEntries'), 'begin failure never withholds existing publication');
      if (fault.startsWith('seal-')) {
        assert.equal(calls.filter(name => name === 'sealFullIndex').length, 1, 'unknown seal is never retried');
        assert.ok(warnings.some(value => value.includes('seal outcome unknown')));
      }
    });
  }
});

test('partial publication invalidates every affected row before changing the first row', { skip: sqliteSkip }, async t => {
  const f = durableFixture(t), db = f.store, commands = createWriterCommands(db);
  const rows = ['first', 'second'].map(sessionId => ({ sessionId, folder: 'folder', summary: 'before', fullReadStamp: 'old', dailyMetrics: [] }));
  db.upsertCachedSessions(rows);
  db.setFolderMeta('folder', f.root, 1);
  let witnessed = false;
  const writer = createSessionIndexWriter({ readonlyBackend: db, client: { ready: Promise.resolve(), request: async (name, ...args) => {
    if (name !== 'effects') return (commands[name] || db[name])(...args);
    for (const effect of args[0]) {
      if (effect.name === 'upsertCachedSessions' && !witnessed) {
        witnessed = true;
        assert.equal(db.getCachedSession('second').fullReadStamp, null, 'all dependency members are invalid before materialized replacement');
      }
      (commands[effect.name] || db[effect.name])(...effect.args);
    }
  } } });
  await writer.ready;
  writer.initializeCache({ PROJECTS_DIR: f.root, activeSessions: new Map(), getMainWindow: () => null, log: { info() {}, warn() {}, error() {} } });
  await writer.writeScannedFolderPartial({ folder: 'folder', projectPath: f.root, sessions: rows.map(row => ({ ...row, summary: 'after', fullReadStamp: null })), toDelete: [], indexMtimeMs: 2 });
  assert.equal(witnessed, true);
  assert.equal(db.getFolderMeta('folder').fullIndexVersion, null, 'a partial write cannot invent a full-folder baseline');
});

test('certificate commands retain project-deletion producer fencing', { skip: sqliteSkip }, t => {
  const f = durableFixture(t), db = f.store;
  db.setFolderMeta('folder', f.root, 1);
  const { bindDeletionProducer } = require('../src/main/projects/project-delete-writer');
  const baseline = bindDeletionProducer(db, 'setFolderMeta', ['folder', f.root, 1], true);
  assert.ok(baseline.length > 0);
  for (const name of ['beginFullIndex', 'sealFullIndex', 'invalidateFullIndex', 'certifyFullReads']) {
    assert.deepEqual(bindDeletionProducer(db, name, ['folder', 'token', 'source'], true), baseline, name + ' binds the same project owner');
  }
});

test('Projects reconciliation full reads are certified only after their complete operation ACK', { skip: sqliteSkip }, async t => {
  const f = durableFixture(t), db = f.store, commands = createWriterCommands(db);
  const folder = require('../encode-project-path').encodeProjectPath(f.root), dir = path.join(f.root, folder);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'source.jsonl'), JSON.stringify({ type: 'user', cwd: f.root, message: { content: 'reconcile body' } }) + '\n');
  db.setInitialScanComplete();
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const { commitTransaction } = require('../src/main/projects/project-delete-progress');
  const writer = createSessionIndexWriter({ readonlyBackend: db, client: { ready: Promise.resolve(), request: async (name, ...args) => {
    if (name !== 'effects') return commitTransaction(db, () => (commands[name] || db[name])(...args)).result;
    assert.equal(args[1], db.getSetting('_writer_revision') || 0, 'publication carries the revision owned by the preceding ACK');
    let acknowledgment;
    for (const effect of args[0]) {
      if (effect.name === 'upsertSearchEntries') { entered(); await gate; }
      acknowledgment = commitTransaction(db, () => (commands[effect.name] || db[effect.name])(...effect.args));
    }
    return acknowledgment;
  } } });
  await writer.ready;
  const cache = require('../session-cache'), recorder = require('../cache-effects').createCacheEffects(db);
  recorder.begin();
  cache.init({ PROJECTS_DIR: f.root, activeSessions: new Map(), getMainWindow: () => null, log: console, db: recorder.adapter });
  await cache.reconcileCacheFromFilesystemAsync({ throttle: false });
  const computed = { effects: recorder.finish(), keptLiveRows: [] };
  writer.initializeCache({ PROJECTS_DIR: f.root, activeSessions: new Map(), getMainWindow: () => null, log: { info() {}, warn() {}, error() {} } });
  const operation = writer.applyProjectsWorkerEffects(computed);
  await started;
  let acknowledgment;
  try { assert.equal(db.getCachedSession('source').fullReadStamp, null, 'Projects producer cannot certify before its search ACK'); }
  finally { release(); acknowledgment = await operation; }
  assert.ok(db.getCachedSession('source').fullReadStamp);
  assert.equal(acknowledgment.committedRevision, db.getSetting('_writer_revision'), 'Projects receives the final owned ACK rather than its pre-certificate revision');
});

test('all journal producers reject transport failure without reconstructing or retrying their candidate', async () => {
  const commands = createWriterCommands({}), calls = [];
  const writer = createSessionIndexWriter({ readonlyBackend: {}, client: { ready: Promise.resolve(),
    request: async name => { calls.push(name); throw Object.assign(new Error('unknown commit outcome'), { code: 'WRITER_TIMEOUT' }); } } }, {});
  await writer.ready;
  for (const name of ['querySessionRequestOutcome', 'recordConsumedSessionStatusRequest', 'recordSessionRequestConflict',
    'claimSessionResultNamespace', 'recordSessionResultPublication']) {
    assert.equal(typeof commands[name], 'function', `${name} is registered in the production command registry`);
    assert.equal(typeof writer[name], 'function', `${name} is forwarded by the production facade`);
    await assert.rejects(writer[name]({ stemKey: 'a' }), { code: 'WRITER_TIMEOUT' });
    assert.equal(calls.filter(value => value === name).length, 1, 'unknown outcomes require an explicit ordered query');
  }
});

function fixture(writer, db = {}) {
  let worker;
  let workerStarted;
  const ready = new Promise(resolve => { workerStarted = resolve; });
  const errors = [], sent = [], logs = [];
  let terminated = false;
  class ScanWorker extends EventEmitter {
    constructor() { super(); worker = this; workerStarted(); }
    terminate() { terminated = true; return Promise.resolve(); }
  }
  const filename = path.join(__dirname, '../session-cache.js');
  const localRequire = createRequire(filename);
  const context = {
    module: { exports: {} }, __dirname: path.dirname(filename), console, Buffer,
    require: name => name === 'worker_threads' ? { Worker: ScanWorker } : localRequire(name),
    setTimeout: () => 1, clearTimeout() {}, setImmediate,
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const cache = context.module.exports;
  cache.init({ PROJECTS_DIR: 'fixture', activeSessions: new Map(), getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (...args) => sent.push(args) } }),
    log: { warn() {}, info: value => logs.push(value), error: (...args) => errors.push(args.join(' ')) },
    db: { getSetting: () => null, getAllCached: () => [], getAllMeta: () => new Map(), getAllFolderMeta: () => new Map(),
      isInitialScanComplete: () => false, setInitialScanComplete() {}, ...db }, writer });
  return { cache, ready, worker: () => worker, errors, sent, logs, terminated: () => terminated };
}

test('population drains folder acknowledgments before done and exit can complete the scan', async () => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const calls = [];
  const f = fixture({
    async writeScannedFolder() { calls.push('folder'); started(); await gate; calls.push('ack'); return 2; },
    async setInitialScanComplete() { calls.push('complete'); },
  });
  const populated = f.cache.populateCacheViaWorker();
  await f.ready;
  f.worker().emit('message', { type: 'folder', result: {}, current: 1, total: 1 });
  f.worker().emit('message', { type: 'done', ok: true });
  f.worker().emit('exit', 0);
  await entered;
  assert.deepEqual(calls, ['folder']);
  release();
  await populated;
  assert.deepEqual(calls, ['folder', 'ack', 'complete']);
});

test('full scan counts actual body bytes including filtered bridge rereads and auxiliary reads', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-counter-1144-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const folder = require('../encode-project-path').encodeProjectPath(project), dir = path.join(root, folder);
  fs.mkdirSync(dir);
  const user = (uuid, day) => ({ type: 'user', uuid, cwd: project, timestamp: `2024-01-${day}T00:00:00.000Z`, message: { content: uuid + ' é' } });
  const bridge = { type: 'bridge-session', bridgeSessionId: 'cse_counter' };
  const sources = new Set();
  for (const [name, entries] of [['parent', [user('shared', '01'), user('parent', '02'), bridge]], ['mirror', [user('shared', '01'), user('mirror', '03'), bridge]]]) {
    const file = path.join(dir, name + '.jsonl');
    sources.add(file);
    fs.writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  }
  const readFile = fs.readFileSync;
  let bytes = 0, operations = 0;
  t.mock.method(fs, 'readFileSync', function (file, ...args) {
    const value = readFile.call(this, file, ...args);
    if (sources.has(file)) { bytes += Buffer.isBuffer(value) ? value.length : Buffer.byteLength(value); operations++; }
    return value;
  });
  const filename = path.join(__dirname, '../workers/scan-projects.js'), native = createRequire(filename), messages = [];
  vm.runInNewContext(readFile(filename, 'utf8'), { Buffer, console, process,
    require: name => name === 'worker_threads' ? { workerData: { projectsDir: root, folders: [folder] }, parentPort: { postMessage: msg => messages.push(msg) } } : native(name),
  }, { filename });
  const result = messages.find(message => message.type === 'folder')?.result;
  assert.ok(result?.counters, 'worker carries measured folder counters');
  assert.ok(operations > 2, 'fixture exercises a real bridge reread');
  assert.equal(result.counters.readOperations, operations);
  assert.equal(result.counters.bytesRead, bytes, 'counts returned UTF-8 bytes, including repeated reads');
  assert.equal(result.counters.filesRead, 2);
  assert.equal(result.counters.filesEnumerated, 2);
  assert.ok(result.counters.auxiliaryBytesRead > 0, 'cwd discovery bytes are separate');
});

test('failed repair invalidates its full seal and retains the repair marker for coordinated retry', { skip: sqliteSkip }, async t => {
  const f = durableFixture(t), db = f.store;
  db.setFolderMeta('folder', f.root, 1);
  db.connection.exec("UPDATE cache_meta SET fullIndexVersion = 1, fullIndexConfig = 'old'");
  db.setSetting('bridge_uuid_reindex_folders', ['folder']);
  const scan = fixture({
    async invalidateFullIndex(folder) { db.invalidateFullIndex(folder); },
    async writeScannedFolder() { throw new Error('repair read failed'); },
    async completeRepairFolders() { db.setSetting('bridge_uuid_reindex_folders', []); },
  }, db);
  await new Promise(resolve => setImmediate(resolve));
  const completed = scan.cache.reindexRepairedFolders();
  await scan.ready;
  scan.worker().emit('message', { type: 'folder', result: { folder: 'folder', sessions: [] }, current: 1, total: 1 });
  scan.worker().emit('message', { type: 'done', ok: false, error: 'repair read failed' });
  scan.worker().emit('exit', 0);
  await completed;
  assert.equal(db.getFolderMeta('folder').fullIndexVersion, null, 'repair failure cannot retain a valid seal');
  assert.equal(db.getSetting('bridge_uuid_reindex_folders').length, 1, 'A2 clears repair markers only after successful publication');
});

test('full scan counters publish after ACK and report rejection once', async () => {
  for (const fail of [false, true]) {
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const f = fixture({ async writeScannedFolder() { entered(); await gate; if (fail) throw new Error('FTS rejected'); return 1; }, async setInitialScanComplete() {} });
    const populated = f.cache.populateCacheViaWorker();
    await f.ready;
    f.worker().emit('message', { type: 'folder', result: { folder: 'folder', sessions: [], counters: { bytesRead: 123, readOperations: 3 } }, current: 1, total: 1 });
    f.worker().emit('message', { type: 'done', ok: true });
    f.worker().emit('exit', 0);
    await started;
    assert.equal(f.logs.filter(line => line.includes('folder-indexed')).length, 0, 'no premature folder success');
    release();
    await populated;
    const records = f.logs.filter(line => line.startsWith('[session-cache] folder-indexed '));
    assert.equal(records.length, 1, 'exactly one diagnostic follows the writer outcome');
    const record = JSON.parse(records[0].slice('[session-cache] folder-indexed '.length));
    assert.equal(record.ok, !fail);
    assert.equal(record.bytesRead, 123);
    assert.equal(record.readOperations, 3);
    assert.ok(record.writeMs >= 0);
  }
});

test('a failed folder write prevents scan completeness while later folders still persist', async () => {
  let completed = false;
  const processed = [];
  const f = fixture({
    async writeScannedFolder(result) {
      processed.push(result.folder);
      if (result.folder === 'broken') throw new Error('write failed');
      return 2;
    },
    async setInitialScanComplete() { completed = true; },
  });
  const populated = f.cache.populateCacheViaWorker();
  await f.ready;
  f.worker().emit('message', { type: 'folder', result: { folder: 'broken' }, current: 1, total: 2 });
  f.worker().emit('message', { type: 'folder', result: { folder: 'healthy' }, current: 2, total: 2 });
  f.worker().emit('message', { type: 'done', ok: true });
  f.worker().emit('exit', 0);
  await populated;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  assert.deepEqual(processed, ['broken', 'healthy']);
  assert.equal(f.terminated(), false);
  assert.ok(f.errors.some(error => error.includes('write failed')));
  assert.equal(f.sent.some(([channel, status]) => channel === 'status-update' && String(status).includes('Scan failed')), true);
});
