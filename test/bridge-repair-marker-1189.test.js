'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const base = require('./fixtures/warm-start-1144.cjs');
require('./fixtures/isolated-codex-home.cjs')(test);
const options = { skip: !base.supported && 'SQLite requires native binding or Node 22' };

const key = 'vps::-srv-demo';
const remoteScan = extra => ({ folder: key, projectPath: '/srv/demo', sessions: [], indexMtimeMs: 1, counters: { filesFailed: 0 }, ...extra });
const marker = f => [...(f.db.getSetting('bridge_uuid_reindex_folders') || [])];

test('a remote scan with unknown bridge evidence persists its repair marker through the production writer (#1189)', options, async t => {
  const f = await base.fixture(t);
  await f.writer.writeScannedFolder(remoteScan({ bridgeDeferred: ['a', 'b'] }));
  assert.deepEqual(marker(f), [key], 'the deferral reaches SQLite as a repair marker');
  await f.writer.writeScannedFolderPartial(remoteScan({ partial: true, toDelete: [], bridgeDeferred: ['a', 'b'] }));
  assert.deepEqual(marker(f), [key], 'a repeated deferral does not duplicate the key');
});

test('a marked remote folder keeps its marker until a scan reads every member (#1189)', options, async t => {
  const f = await base.fixture(t);
  f.db.setSetting('bridge_uuid_reindex_folders', [key]);
  await f.writer.writeScannedFolder(remoteScan({ counters: { filesFailed: 1 } }));
  assert.deepEqual(marker(f), [key], 'a scan that could not read a member is not convergence');
  await f.writer.writeScannedFolder(remoteScan());
  assert.deepEqual(marker(f), [], 'a complete scan clears the marker');
});
