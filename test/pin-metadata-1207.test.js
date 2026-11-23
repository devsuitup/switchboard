'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const openStore = require('./fixtures/conversation-store.cjs');
const { createWriterWorkerClient } = require('../session-index-writer-client');
const supported = { skip: !openStore.supported && 'SQLite fixture requires a compatible native ABI or Node 22' };
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function isolated(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-1207-'));
  const previous = process.env.SWITCHBOARD_DATA_DIR;
  process.env.SWITCHBOARD_DATA_DIR = dir;
  return () => {
    if (previous === undefined) delete process.env.SWITCHBOARD_DATA_DIR;
    else process.env.SWITCHBOARD_DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  };
}

async function harness(t) {
  const cleanup = isolated(t);
  const lines = [];
  let db;
  const worker = new EventEmitter(), port = new EventEmitter();
  port.postMessage = message => worker.emit('message', message);
  worker.postMessage = message => port.emit('message', message);
  worker.terminate = async () => {};
  const filename = require.resolve('../workers/session-index-writer');
  const nativeRequire = createRequire(filename);
  const client = createWriterWorkerClient({ workerFactory: () => {
    queueMicrotask(() => vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      require: name => name === 'node:worker_threads' ? { parentPort: port }
        : name === '../session-index-store' ? { openSessionIndexStore: options => (db = openStore(options)) } : nativeRequire(name),
      Buffer, setInterval: () => ({ unref() {} }), clearInterval() {},
    }, { filename }));
    return worker;
  }, log: { info: line => lines.push(line), warn() {} } });
  await client.ready;
  t.after(async () => { await client.close(); cleanup(); });
  return { client, db, lines };
}

test('pin icon changes emit one committed line per change, with only short ids', supported, async t => {
  const { client, db, lines } = await harness(t);
  await client.request('setStarred', [A, B, A], true);
  await client.request('setStarred', [A, B], true);
  await client.request('setStarred', [A, B], false);
  await client.request('toggleStar', A);
  assert.equal(db.getMeta(A).starred, 1);
  assert.deepEqual(lines, [
    '[pin] ids=11111111,22222222 0→1 source=icon',
    '[pin] ids=11111111,22222222 1→0 source=icon',
    '[pin] ids=11111111 0→1 source=icon',
  ], 'each committed pin transition must reach the main logger exactly once');
});

test('background rekey and project metadata erasure log their actual transitions', supported, async t => {
  const { client, db, lines } = await harness(t);
  await client.request('setStarred', A, true);
  await client.request('rekeySessionMeta', A, B);
  await client.request('rekeySessionMeta', A, B);
  db.transact(() => db.projectDeletion.eraseMetadata(B));
  db.transact(() => db.projectDeletion.eraseMetadata(B));
  assert.equal(db.getMeta(B), null);
  assert.equal(db.getMeta(A).starred, 1);
  assert.deepEqual(lines, [
    '[pin] ids=11111111 0→1 source=icon',
    '[pin] ids=11111111,22222222 0→1 source=rekey',
    '[pin] ids=22222222 1→0 source=delete',
  ], 'rekey and deletion share the committed logging path');
});

test('rollback and deferred savepoint units never produce phantom pin logs', supported, async t => {
  const { client, db, lines } = await harness(t);
  await client.request('setStarred', A, true);
  lines.length = 0;
  assert.throws(() => db.transact(() => { db.setStarred(A, false); throw new Error('rollback'); }), /rollback/);
  db.transact(() => {
    const unit = db.chunkUnit(() => db.setStarred(A, false), 1, { rows: 32, bytes: 65536 });
    assert.equal(unit.deferred, true);
  });
  await client.request('setStarred', B, true);
  assert.equal(db.getMeta(A).starred, 1);
  assert.deepEqual(lines, ['[pin] ids=22222222 0→1 source=icon']);
});

test('fresh metadata schema keeps db_version 9', supported, t => {
  const cleanup = isolated(t);
  const db = openStore();
  t.after(() => { db.closeDb(); cleanup(); });
  assert.equal(db.getSetting('db_version'), 9, 'adding updatedAt must not bump db_version');
});

for (const version of [9, 10, 42]) test(`metadata column reconciliation preserves db_version ${version} and old rows`, supported, t => {
  const cleanup = isolated(t);
  let db = openStore();
  t.after(() => { db.closeDb(); cleanup(); });
  const columns = db.connection.prepare('PRAGMA table_info(session_meta_fields)').all();
  const hasTimestamp = columns.some(column => column.name === 'updatedAt');
  if (hasTimestamp) db.connection.exec('ALTER TABLE session_meta_fields DROP COLUMN updatedAt');
  db.setSetting('db_version', version);
  db.connection.prepare('INSERT INTO session_meta(sessionId, starred) VALUES (?, 1)').run(A);
  db.connection.prepare("INSERT INTO session_meta_fields(sessionId, field, revision, source) VALUES (?, 'starred', 42, 'user')").run(A);
  db.upsertCachedSessions([{ sessionId: A, folder: 'project', summary: 'Keep cached data' }]);
  db.setFolderMeta('project', '/project', 123);
  db.setInitialScanComplete();
  db.closeDb();
  db = openStore();
  assert.ok(db.connection.prepare('PRAGMA table_info(session_meta_fields)').all().some(column => column.name === 'updatedAt'),
    'column reconciliation adds updatedAt even when db_version is already current or higher');
  assert.equal(db.getSetting('db_version'), version, 'column reconciliation preserves db_version');
  const field = (id, name) => db.connection.prepare('SELECT * FROM session_meta_fields WHERE sessionId=? AND field=?').get(id, name);
  const legacy = { ...field(A, 'starred') };
  assert.deepEqual(legacy, { sessionId: A, field: 'starred', revision: 42, source: 'user', transcriptTitle: null, updatedAt: null });
  assert.equal(db.getMeta(A).starred, 1);
  assert.equal(db.getCachedSession(A).summary, 'Keep cached data');
  assert.equal(db.getFolderMeta('project').indexMtimeMs, 123);
  assert.equal(db.isInitialScanComplete(), true);
  db.closeDb();
  db = openStore();
  assert.equal(db.getSetting('db_version'), version, 'writable reopen keeps the version');
  assert.deepEqual({ ...field(A, 'starred') }, legacy, 'writable reopen is idempotent');
  const start = Date.now();
  db.transact(() => { db.setStarred(A, false); db.setName(A, 'private title'); db.setArchived(A, true); });
  for (const name of ['starred', 'name', 'archived']) {
    assert.ok(field(A, name).updatedAt >= start && field(A, name).updatedAt <= Date.now(), `${name} has a wall-clock timestamp`);
  }
  const revision = field(A, 'starred').revision;
  db.transact(() => db.setStarred(A, true));
  assert.ok(field(A, 'starred').revision > revision);
  const original = field(A, 'starred');
  db.transact(() => db.rekeySessionMeta(A, B));
  assert.equal(field(B, 'starred').updatedAt, original.updatedAt, 'rekey preserves the original revision timestamp');
  db.closeDb();
  db = openStore({ readonly: true });
  assert.equal(field(B, 'starred').updatedAt, original.updatedAt, 'timestamp survives a readonly reopen');
});
