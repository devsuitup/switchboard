const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const APP_DIR = path.join(__dirname, '..');
const electronBin = require('electron');

function runInElectronNode(code, dataDir) {
  return spawnSync(electronBin, ['-e', code], {
    cwd: APP_DIR,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: dataDir },
    encoding: 'utf8', timeout: 9000,
  });
}

test('UUID repair removes only bridged cache, metrics, FTS and affected folder gates once', { timeout: 20000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-bridge-repair-'));
  try {
    const seed = runInElectronNode(`
      const api = require(${JSON.stringify(path.join(APP_DIR, 'db.js'))});
      api.deleteSetting('bridge_uuid_index_version');
      api.setSetting('global', { test: 'kept' });
      api.upsertCachedSessions([
        { sessionId: 'bridge', folder: 'local', summary: 'stale bridge', bridgeSessionId: 'cse_one' },
        { sessionId: 'remote', folder: 'vps::remote', summary: 'stale remote', bridgeSessionId: 'cse_two' },
        { sessionId: 'unrelated', folder: 'other', summary: 'retained' },
        { sessionId: 'sub:bridge:agent', folder: 'local', summary: 'subagent', parentSessionId: 'bridge', agentId: 'agent', bridgeSessionId: 'cse_one' },
      ]);
      for (const id of ['bridge', 'remote', 'unrelated', 'sub:bridge:agent']) {
        api.replaceSessionMetrics(id, [{ date: '2026-10-01', model: 'fixture', messageCount: 1, toolCallCount: 1, inputTokens: 7, outputTokens: 3 }]);
        api.upsertSearchEntries([{ id, type: 'session', folder: id === 'remote' ? 'vps::remote' : id === 'unrelated' ? 'other' : 'local', title: id, body: 'synthetic repair fixture' }]);
        api.setName(id, 'User name ' + id); api.toggleStar(id); api.setArchived(id, true);
      }
      for (const folder of ['local', 'vps::remote', 'other']) api.setFolderMeta(folder, '/fixture', 123);
      api.closeDb();
    `, dir);
    assert.equal(seed.status, 0, seed.stderr);
    const inspect = () => {
      const r = runInElectronNode(`
        const api = require(${JSON.stringify(path.join(APP_DIR, 'db.js'))});
        const sql = new (require('better-sqlite3'))(api.DB_PATH);
        console.log(JSON.stringify({
          rows: api.getAllCached().map(r => r.sessionId).sort(),
          metrics: sql.prepare('SELECT sessionId FROM session_metrics ORDER BY sessionId').all().map(r => r.sessionId),
          search: api.searchByType('session', 'synthetic', 20).map(r => r.id).sort(),
          map: sql.prepare('SELECT id FROM search_map ORDER BY id').all().map(r => r.id),
          content: sql.prepare('SELECT COUNT(*) n FROM search_content').get().n,
          folders: [...api.getAllFolderMeta().keys()].sort(), meta: [...api.getAllMeta().values()],
          global: api.getSetting('global'), version: api.getSetting('bridge_uuid_index_version'), pending: api.getSetting('bridge_uuid_reindex_folders')
        }));
        sql.close(); api.closeDb();
      `, dir);
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout.trim().split('\n').pop());
    };
    const repaired = inspect();
    const kept = ['sub:bridge:agent', 'unrelated'];
    assert.deepEqual(repaired.rows, kept);
    assert.deepEqual(repaired.metrics, kept);
    assert.deepEqual(repaired.search, kept);
    assert.deepEqual(repaired.map, kept);
    assert.equal(repaired.content, 2);
    assert.deepEqual(repaired.folders, ['other']);
    assert.equal(repaired.meta.length, 4);
    assert.ok(repaired.meta.every(r => r.name === 'User name ' + r.sessionId && r.starred === 1 && r.archived === 1));
    assert.deepEqual(repaired.global, { test: 'kept' });
    assert.equal(repaired.version, 1);
    assert.deepEqual(repaired.pending.sort(), ['local', 'vps::remote']);
    const restore = runInElectronNode(`
      const api = require(${JSON.stringify(path.join(APP_DIR, 'db.js'))});
      api.upsertCachedSessions([{ sessionId: 'bridge', folder: 'local', summary: 'reindexed', bridgeSessionId: 'cse_one' }]);
      api.setFolderMeta('local', '/fixture', 456); api.closeDb();
    `, dir);
    assert.equal(restore.status, 0, restore.stderr);
    const second = inspect();
    assert.deepEqual(second.rows, ['bridge', ...kept]);
    assert.deepEqual(second.folders, ['local', 'other']);
    assert.deepEqual(inspect(), second, 'second open does not invalidate reindexed bridge rows');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('UUID repair failure rolls back invalidation and retries on next database open', { timeout: 20000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-bridge-retry-'));
  try {
    const seed = runInElectronNode(`
      const api = require(${JSON.stringify(path.join(APP_DIR, 'db.js'))});
      api.deleteSetting('bridge_uuid_index_version');
      api.upsertCachedSessions([{ sessionId: 'failure', folder: 'failure-folder', bridgeSessionId: 'cse_fail', summary: 'synthetic' }]);
      api.setFolderMeta('failure-folder', '/fixture', 789);
      const sql = new (require('better-sqlite3'))(api.DB_PATH);
      sql.exec("CREATE TRIGGER block_bridge_repair BEFORE DELETE ON session_cache WHEN OLD.sessionId = 'failure' BEGIN SELECT RAISE(ABORT, 'injected repair failure'); END");
      sql.close(); api.closeDb();
    `, dir);
    assert.equal(seed.status, 0, seed.stderr);
    const failed = runInElectronNode(`
      const api = require(${JSON.stringify(path.join(APP_DIR, 'db.js'))});
      console.log(JSON.stringify({ row: !!api.getCachedSession('failure'), folder: !!api.getFolderMeta('failure-folder'), version: api.getSetting('bridge_uuid_index_version') }));
      api.closeDb();
    `, dir);
    assert.equal(failed.status, 0, failed.stderr);
    assert.match(failed.stderr, /bridge.*repair|repair.*bridge/i);
    assert.deepEqual(JSON.parse(failed.stdout.trim().split('\n').pop()), { row: true, folder: true, version: null });
    const unblock = runInElectronNode(`
      const sql = new (require('better-sqlite3'))(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'));
      sql.exec('DROP TRIGGER block_bridge_repair'); sql.close();
    `, dir);
    assert.equal(unblock.status, 0, unblock.stderr);
    const retried = runInElectronNode(`
      const api = require(${JSON.stringify(path.join(APP_DIR, 'db.js'))});
      console.log(JSON.stringify({ row: !!api.getCachedSession('failure'), version: api.getSetting('bridge_uuid_index_version') })); api.closeDb();
    `, dir);
    assert.equal(retried.status, 0, retried.stderr);
    assert.deepEqual(JSON.parse(retried.stdout.trim().split('\n').pop()), { row: false, version: 1 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

