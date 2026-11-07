'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const openStore = require('./fixtures/conversation-store.cjs');

test('writer reconcile adds runtime/sessionFile without losing old rows or scan state; readonly never migrates',
  { skip: !openStore.supported && 'native SQLite ABI differs; node:sqlite requires Node 22' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-schema-'));
  const previous = process.env.SWITCHBOARD_DATA_DIR;
  process.env.SWITCHBOARD_DATA_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.SWITCHBOARD_DATA_DIR;
    else process.env.SWITCHBOARD_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  let db = openStore({ readonly: false });
  db.upsertCachedSessions([{ sessionId: 'old', folder: 'folder', summary: 'kept', messageCount: 3 }]);
  db.setFolderMeta('folder', '/project', 42);
  db.setSetting('initial_scan_complete', true);
  const old = db.connection;
  const names = old.prepare('PRAGMA table_info(session_cache)').all().map(c => c.name);
  for (const name of ['runtime', 'sessionFile']) if (names.includes(name)) old.exec(`ALTER TABLE session_cache DROP COLUMN ${name}`);
  const before = old.prepare('SELECT * FROM session_cache').get();
  db.closeDb();
  db = openStore({ readonly: true });
  assert.equal(db.connection.prepare('PRAGMA table_info(session_cache)').all().some(c => c.name === 'runtime'), false);
  db.closeDb();
  db = openStore({ readonly: false });
  try {
    const cols = db.connection.prepare('PRAGMA table_info(session_cache)').all();
    assert.equal(cols.find(c => c.name === 'runtime')?.dflt_value, "'claude'", 'runtime defaults to Claude');
    assert.equal(cols.find(c => c.name === 'sessionFile')?.type, 'TEXT');
    const row = db.connection.prepare('SELECT * FROM session_cache').get();
    assert.ok(row, 'legacy session row must survive reconciliation');
    assert.equal(row.runtime, 'claude');
    assert.equal(row.sessionFile, null);
    for (const [key, value] of Object.entries(before)) assert.equal(row[key], value, key);
    assert.equal(db.getSetting('initial_scan_complete'), true);
    assert.equal(db.connection.prepare('SELECT COUNT(*) AS n FROM cache_meta').get().n, 1);
    db.connection.prepare('UPDATE session_cache SET runtime = ?, sessionFile = ? WHERE sessionId = ?').run('future', '/explicit.jsonl', 'old');
    db.upsertCachedSessions([{ sessionId: 'old', folder: 'folder', summary: 'updated' }, { sessionId: 'new', folder: 'folder' }]);
    assert.equal(db.getCachedSession('old').summary, 'updated');
    assert.equal(db.getCachedSession('old').runtime, 'future');
    assert.equal(db.getCachedSession('old').sessionFile, '/explicit.jsonl');
    assert.equal(db.getCachedSession('new').runtime, 'claude');
  } finally { db.closeDb(); }
  db = openStore({ readonly: false });
  try {
    assert.equal(db.getAllCached().length, 2);
    assert.equal(db.getCachedSession('old').sessionFile, '/explicit.jsonl');
  } finally { db.closeDb(); }
});
