'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createRemoteIndexer } = require('../remote-index');

test('remote refresh accepts worker inventories and awaits asynchronous folder removal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-worker-inventory-'));
  const dropped = [];
  const scanned = [];
  const indexer = createRemoteIndexer({
    dataDir: dir, getHosts: () => [{ alias: 'host', enabled: true }],
    listIndexedFolderKeys: async () => ['old::gone', 'host::gone'],
    listMirrorFolders: async () => ['fresh'],
    dropFolder: async key => { await new Promise(resolve => setImmediate(resolve)); dropped.push(key); },
    scanFolders: async args => scanned.push(args),
    sync: async () => ({ sessions: [], changedFolders: [], fetched: 0, unchanged: 0, removed: 0, failed: 0 }),
    transport: {},
  });
  try {
    const result = await indexer.refreshNow();
    assert.deepEqual(result.errors, []);
    assert.deepEqual(dropped, ['old::gone', 'host::gone']);
    assert.deepEqual(scanned[0].folders, ['fresh']);
  } finally { indexer.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});
