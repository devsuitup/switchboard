'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const reference = require('../../db');
const cache = require('../../session-cache');
const { createRemoteIndexer } = require('../../remote-index');

function snapshot(api) {
  const sql = new Database(api.DB_PATH, { readonly: true });
  try {
    return { rows: sql.prepare('SELECT * FROM session_cache ORDER BY sessionId').all(),
      meta: sql.prepare('SELECT * FROM session_meta ORDER BY sessionId').all(),
      folders: sql.prepare('SELECT * FROM cache_meta ORDER BY folder').all(),
      metrics: sql.prepare('SELECT * FROM session_metrics ORDER BY sessionId, date, model').all(),
      search: sql.prepare('SELECT m.id, m.type, m.folder, c.title, c.body FROM search_map m JOIN search_content c ON c.rowid = m.rowid ORDER BY m.type, m.id').all() };
  } finally { sql.close(); }
}

async function run() {
  const root = process.env.SWITCHBOARD_DATA_DIR;
  const projectsDir = path.join(root, 'mirror');
  const folder = '-remote-repo';
  const key = 'host::' + folder;
  const dir = path.join(projectsDir, folder);
  fs.mkdirSync(path.join(dir, 'a', 'subagents'), { recursive: true });
  const user = (uuid, day, text) => ({ type: 'user', cwd: '/remote/repo', uuid,
    timestamp: `2026-10-${day}T00:00:00.000Z`, message: { content: text } });
  const write = (id, records) => fs.writeFileSync(path.join(dir, id + '.jsonl'), records.map(row => JSON.stringify(row)).join('\n') + '\n');
  write('a', [user('first', '01', 'First remote prompt'), user('shared', '02', 'Shared remote prompt'), { type: 'bridge-session', bridgeSessionId: 'bridge' }]);
  write('b', [user('shared', '02', 'Shared remote prompt'), user('next', '03', 'New remote prompt'), { type: 'bridge-session', bridgeSessionId: 'bridge' }]);
  write('a/subagents/agent-child', [user('child', '02', 'Child remote prompt')]);
  reference.setSetting('bridge_uuid_reindex_folders', [key]);
  reference.setName('a', 'User rename');
  const copy = path.join(root, 'actual');
  fs.mkdirSync(copy);
  const originalSql = new Database(reference.DB_PATH);
  await originalSql.backup(path.join(copy, 'switchboard.db'));
  originalSql.close();
  process.env.SWITCHBOARD_DATA_DIR = copy;
  delete require.cache[require.resolve('../../db')];
  const actual = require('../../db');
  const config = { PROJECTS_DIR: path.join(root, 'local'), activeSessions: new Map(), getMainWindow: () => null, log: console };
  let mainReads = 0;
  const actualDb = { ...actual, getCachedByFolder: (...args) => { mainReads++; return actual.getCachedByFolder(...args); } };
  const init = (api, production) => {
    cache.init({ ...config, db: production ? actualDb : { ...api, DB_PATH: undefined } });
    cache.setRemoteRoots(new Map([['host', projectsDir]]));
  };
  const scan = fileSubsets => cache.scanFoldersViaWorker({ projectsDir, folderPrefix: 'host', folders: [folder], fileSubsets });
  try {
    init(reference, false);
    assert.equal((await scan()).ok, true);
    const expected = snapshot(reference);
    init(actual, true);
    assert.equal((await scan()).ok, true);
    assert.deepEqual(snapshot(actual), expected);
    assert.deepEqual(actual.getSetting('bridge_uuid_reindex_folders'), []);
    fs.appendFileSync(path.join(dir, 'a.jsonl'), JSON.stringify(user('resume', '05', 'Appended remote body')) + '\n');
    fs.unlinkSync(path.join(dir, 'a', 'subagents', 'agent-child.jsonl'));
    const subset = new Map([[folder, new Set(['a.jsonl', 'a/subagents/agent-child.jsonl'])]]);
    init(reference, false);
    assert.equal((await scan(subset)).ok, true);
    const expectedSubset = snapshot(reference);
    init(actual, true);
    assert.equal((await scan(subset)).ok, true);
    assert.deepEqual(snapshot(actual), expectedSubset);
    actual.setSetting('bridge_uuid_reindex_folders', [key]);
    const indexer = createRemoteIndexer({ dataDir: root, getHosts: () => [{ alias: 'other' }], transport: {},
      sync: async () => ({ changedFolders: [], sessions: [], fetched: 0, failed: 0, unchanged: 0, removed: 0 }),
      listIndexedFolderKeys: () => cache.queryCache({ kind: 'folder-keys' }),
      listMirrorFolders: projectsDir => cache.queryCache({ kind: 'mirror-folders', projectsDir }),
      dropFolder: folder => cache.dropFolderViaWorker(folder) });
    try {
      assert.deepEqual((await indexer.refreshNow()).errors, []);
      assert.equal(actual.getCachedByFolder(key).length, 0);
      assert.deepEqual(actual.getSetting('bridge_uuid_reindex_folders'), []);
      assert.equal(snapshot(actual).metrics.length, 0);
      assert.equal(snapshot(actual).search.length, 0);
    } finally { indexer.dispose(); }
    assert.equal(mainReads, 0, 'remote full/subset scans must not materialise folder rows on main');
    console.log('remote full and subset equivalence verified');
  } finally { cache.shutdownIndexing(); reference.closeDb(); actual.closeDb(); }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
