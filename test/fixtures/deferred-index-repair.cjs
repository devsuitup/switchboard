'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let db = require('../../db');

async function run() {
  const rows = Array.from({ length: 121 }, (_, i) => ({ sessionId: `bridged-${i}`, folder: 'fixture',
    summary: 'obsolete', bridgeSessionId: 'bridge' }));
  db.upsertCachedSessions(rows);
  db.setFolderMeta('fixture', '/fixture', 123);
  db.deleteSetting('bridge_uuid_index_version');
  db.closeDb();
  delete require.cache[require.resolve('../../db')];
  db = require('../../db');
  assert.equal(db.getCachedByFolder('fixture').length, 121, 'requiring db must not synchronously read/invalidate bridged history');
  const cache = require('../../session-cache');
  const projectsDir = path.join(process.env.SWITCHBOARD_DATA_DIR, 'projects');
  fs.mkdirSync(projectsDir);
  let batches = 0;
  cache.init({ PROJECTS_DIR: projectsDir, activeSessions: new Map(), getMainWindow: () => null, log: console, db,
    trace: (event, data) => { if (event === 'indexing.apply') { batches++; assert.ok(data.entries <= 50); assert.ok(data.bytes <= 128 * 1024); } } });
  try {
    await cache.prepareIndexing();
    assert.equal(db.getCachedByFolder('fixture').length, 0);
    assert.equal(db.getSetting('bridge_uuid_index_version'), 1);
    assert.ok(batches > 2);
    console.log('deferred repair verified');
  } finally { cache.shutdownIndexing(); db.closeDb(); }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
