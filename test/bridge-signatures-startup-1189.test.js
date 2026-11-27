'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = require('./fixtures/warm-start-1144.cjs');
const codex = require('./fixtures/warm-start-1152.cjs');
require('./fixtures/isolated-codex-home.cjs')(test);
const options = { skip: !base.supported && 'SQLite requires native binding or Node 22' };

test('a startup merge whose predecessor signatures cannot be re-read converges on the next start (#1189)', options, async t => {
  const f = await base.fixture(t);
  const bridge = { type: 'bridge-session', bridgeSessionId: 'cse_1189' };
  const copied = { type: 'user', cwd: f.root, timestamp: '2024-01-01T00:00:00.000Z', message: { content: 'Copied payload' } };
  const predecessor = f.write('a', 'Copied payload', [bridge]);
  assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
  f.write('b', 'own', [copied, bridge]);
  const inventory = [{ folder: f.folder, meta: f.db.getFolderMeta(f.folder), rows: f.db.getCachedByFolder(f.folder), metadata: [] }];
  const open = fs.openSync;
  let injected = 0;
  const patch = t.mock.method(fs, 'openSync', function (target, ...args) {
    if (target === predecessor && /at Object\.get \([^)]*read-session-file\.js/.test(new Error().stack)) { injected++; throw Object.assign(new Error('synthetic lock'), { code: 'EBUSY' }); }
    return open.call(this, target, ...args);
  });
  const messages = codex.scan({ projectsDir: f.projects, inventory, scope: [f.folder], disabledHarnesses: [] });
  patch.mock.restore();
  assert.ok(injected > 0, 'the failure reaches the lazy signature read');
  const result = messages.find(msg => msg.result)?.result;
  assert.ok(result.deferred.includes('b.jsonl'), 'the group is deferred');
  await (result.partial ? f.writer.writeScannedFolderPartial(result) : f.writer.writeScannedFolder(result));
  assert.equal(f.db.getCachedSession('b')?.fullReadStamp ?? null, null, 'the member is not certified');
  await f.reopen();
  assert.equal((await f.restart()).ok, true);
  assert.equal(f.db.getCachedSession('b').messageCount, 1, 'the copied payload is excluded once signatures are readable');
  assert.ok(f.db.getCachedSession('b').fullReadStamp);
});
