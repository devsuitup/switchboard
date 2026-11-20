'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const openStore = require('./fixtures/conversation-store.cjs');
const { createWriterWorkerClient } = require('../session-index-writer-client');

const supported = { skip: !openStore.supported && 'native SQLite ABI differs; node:sqlite requires Node 22' };
const fixture = path.join(__dirname, 'fixtures', 'writer-busy-short-retry.cjs');

test('a BUSY retry whose chunk closes earlier than the failed attempt still commits every buffered unit once, in order', supported, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-busy-short-retry-'));
  const previous = process.env.SWITCHBOARD_DATA_DIR;
  process.env.SWITCHBOARD_DATA_DIR = dir;
  const client = createWriterWorkerClient({ workerFactory: () => new Worker(fixture), log: { info() {}, warn() {} } });
  t.after(async () => {
    await client.close();
    if (previous === undefined) delete process.env.SWITCHBOARD_DATA_DIR;
    else process.env.SWITCHBOARD_DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await client.ready;
  const rows = Array.from({ length: 5 }, (_, i) => ({ sessionId: 'row-' + i, folder: 'fixture', projectPath: '/fixture', modified: 1 }));
  await client.request('upsertCachedSessions', rows);
  const db = openStore({ readonly: true });
  try {
    assert.deepEqual(db.getAllCached().map(row => row.sessionId).sort(), rows.map(row => row.sessionId),
      'a successful ACK means every row survived the BUSY retry');
    assert.equal(db.getSetting('applied'), 'row-0,row-1,row-2,row-3,row-4,', 'each unit is committed exactly once, in iterator order');
  } finally { db.closeDb(); }
});
