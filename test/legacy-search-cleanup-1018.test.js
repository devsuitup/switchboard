'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const openStore = require('./fixtures/conversation-store.cjs');

test('startup cleanup removes retired search rows and preserves Memory and sessions', {
  skip: !openStore.supported && 'Requires a compatible SQLite binding or Node 22 node:sqlite',
}, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-search-1018-'));
  const previous = process.env.SWITCHBOARD_DATA_DIR;
  process.env.SWITCHBOARD_DATA_DIR = dir;
  const store = openStore();
  t.after(() => {
    store.closeDb();
    if (previous === undefined) delete process.env.SWITCHBOARD_DATA_DIR;
    else process.env.SWITCHBOARD_DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const entries = ['work-file', 'plan', 'memory', 'session'].map(type => ({
    id: type, type, folder: 'project', title: type,
    body: type === 'work-file' || type === 'plan' ? 'retiredneedle' : 'retainedneedle',
  }));
  store.upsertSearchEntries(entries);
  const count = (table, where = '') => store.connection.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get().n;
  assert.equal(count('search_fts', "WHERE search_fts MATCH 'retiredneedle'"), 2);

  const filename = path.join(__dirname, '../main.js');
  const source = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('const legacySearchCleanup =');
  const end = source.indexOf('\n\n', start);
  assert.ok(start >= 0 && end > start, 'startup cleanup exists');
  const cleanup = () => {
    const context = vm.createContext({ deleteSearchType: async type => store.deleteSearchType(type) });
    vm.runInContext(source.slice(start, end), context, { filename });
    return vm.runInContext('legacySearchCleanup', context, { filename });
  };
  await cleanup();

  for (const type of ['work-file', 'plan']) {
    assert.equal(store.getSearchFileIds(type).length, 0, `${type} rows must be purged by startup cleanup`);
  }
  for (const table of ['search_map', 'search_content', 'search_fts']) {
    assert.equal(count(table), 2, `${table} retains only active types`);
  }
  assert.equal(count('search_fts', "WHERE search_fts MATCH 'retiredneedle'"), 0);
  assert.equal(count('search_fts', "WHERE search_fts MATCH 'retainedneedle'"), 2);
  for (const type of ['memory', 'session']) assert.equal(store.getSearchFileIds(type)[0], type);
  store.connection.prepare("INSERT INTO search_fts(search_fts, rank) VALUES ('integrity-check', 1)").run();
  await cleanup();
  assert.equal(count('search_content'), 2, 'cleanup is idempotent');
});
