'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const openStore = require('./fixtures/conversation-store.cjs');
const { buildFtsMatch, idLookupTerm, searchTerms, createSessionSearch } = require('../fts-match');

const skip = !openStore.supported && 'Requires a compatible SQLite binding or Node 22 node:sqlite';
const PARENT = '22d3a9d7-1b2c-4d5e-8f90-a1b2c3d4e5f6';
const OTHER = '5190855a-a999-4843-962c-ea84cc36d4ee';
const AGENT = 'a00a65f2d8ebaaa0a';
const SUB = `sub:${PARENT}:${AGENT}`;

function withStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-1255-'));
  const previous = process.env.SWITCHBOARD_DATA_DIR;
  process.env.SWITCHBOARD_DATA_DIR = dir;
  const store = openStore();
  t.after(() => {
    store.closeDb();
    if (previous === undefined) delete process.env.SWITCHBOARD_DATA_DIR;
    else process.env.SWITCHBOARD_DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const row = (sessionId, extra = {}) => ({ sessionId, folder: 'proj', projectPath: '/proj', summary: 'summary ' + sessionId,
    firstPrompt: 'p', created: '2026-11-01T00:00:00.000Z', modified: '2026-11-01T00:00:00.000Z', messageCount: 2, ...extra });
  store.upsertCachedSessions([row(PARENT), row(OTHER), row(SUB, { parentSessionId: PARENT, agentId: AGENT })]);
  store.upsertSearchEntries([
    { id: PARENT, type: 'session', folder: 'proj', title: 'release work', body: 'Opened PR #1243 for the fix' },
    { id: OTHER, type: 'session', folder: 'proj', title: 'mentions the parent', body: `see ${PARENT} for context` },
    { id: SUB, type: 'session', folder: 'proj', title: 'subagent', body: 'explored facade code' },
  ]);
  return store;
}

test('terms: whitespace split, leading # and ! stripped, terms under 3 characters dropped', () => {
  assert.deepEqual(searchTerms('PR 1243'), ['1243']);
  assert.deepEqual(searchTerms('#1243'), ['1243']);
  assert.deepEqual(searchTerms('!1243'), ['1243']);
  assert.deepEqual(searchTerms('  release   notes '), ['release', 'notes']);
  assert.equal(buildFtsMatch('release notes'), '"release" AND "notes"');
  assert.equal(buildFtsMatch('release notes', true), 'title:("release" AND "notes")');
  assert.equal(buildFtsMatch('spec.md', true), 'title:"spec.md"');
  assert.equal(buildFtsMatch('say "hello"'), '"say" AND """hello"""');
  assert.equal(buildFtsMatch('PR'), null, 'a query of only short terms has no FTS expression');
});

test('id lookup runs for UUIDs, hex prefixes with a digit, agent and sub: ids, never for ordinary words', () => {
  assert.deepEqual(idLookupTerm(PARENT.toUpperCase()), { sessionPrefix: PARENT, agentPrefix: PARENT });
  assert.deepEqual(idLookupTerm('22d3a9'), { sessionPrefix: '22d3a9', agentPrefix: '22d3a9' });
  assert.deepEqual(idLookupTerm('agent-' + AGENT), { sessionPrefix: AGENT, agentPrefix: AGENT });
  assert.deepEqual(idLookupTerm(SUB), { sessionPrefix: SUB, agentPrefix: null });
  for (const word of ['facade', 'decade', 'deadbeef', '22d3a', 'release notes', 'planifiées', '#1243', '']) {
    assert.equal(idLookupTerm(word), null, `${JSON.stringify(word)} must not take the id path`);
  }
});

test('store search: a session is found by its full id and by an id prefix', { skip }, t => {
  const store = withStore(t);
  const full = store.searchByType('session', PARENT);
  assert.equal(full[0].id, PARENT, 'the session itself comes first');
  assert.equal(full[0].idMatch, true);
  assert.ok(full.some(r => r.id === OTHER), 'a session whose text quotes the id still matches');
  assert.equal(new Set(full.map(r => r.id)).size, full.length, 'id and FTS hits are merged without duplicates');
  assert.deepEqual(store.searchByType('session', '22d3a9d7').map(r => r.id).slice(0, 1), [PARENT]);
  assert.deepEqual(store.searchByType('session', AGENT.slice(0, 8)).map(r => r.id), [SUB]);
  assert.deepEqual(store.searchByType('session', SUB).map(r => r.id), [SUB]);
});

test('store search: "PR 1243", "1243", "#1243" and "!1243" all match "PR #1243"', { skip }, t => {
  const store = withStore(t);
  for (const query of ['PR 1243', '1243', '#1243', '!1243']) {
    assert.deepEqual(store.searchByType('session', query).map(r => r.id), [PARENT], query);
  }
  assert.deepEqual(store.searchByType('session', 'release 1243').map(r => r.id), [PARENT], 'terms AND across title and body');
  assert.deepEqual(store.searchByType('session', 'release 9999').map(r => r.id), [], 'every term must match');
  assert.match(store.searchByType('session', '1243')[0].snippet, /<mark>1243<\/mark>/);
});

test('store search: an ordinary hex-letter word does not hit the id path', { skip }, t => {
  const store = withStore(t);
  const results = store.searchByType('session', 'facade');
  assert.deepEqual(results.map(r => r.id), [SUB]);
  assert.equal(results[0].idMatch, undefined);
});

test('worker and fallback share one search implementation over the same database', { skip }, t => {
  const store = withStore(t);
  const source = fs.readFileSync(path.join(__dirname, '..', 'workers', 'search-query.js'), 'utf8');
  assert.match(source, /createSessionSearch\(db\)/, 'the worker builds its search from fts-match.js');
  const workerSearch = createSessionSearch(store.connection);
  for (const query of [PARENT, '22d3a9d7', 'PR 1243', 'facade', 'release notes']) {
    assert.deepEqual(workerSearch('session', query, 50, false), store.searchByType('session', query), query);
  }
});

test('a pre-subagent database without agentId opens and gains the column and its index', { skip }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-1255-legacy-'));
  const previous = process.env.SWITCHBOARD_DATA_DIR;
  process.env.SWITCHBOARD_DATA_DIR = dir;
  let store;
  t.after(() => {
    store?.closeDb();
    if (previous === undefined) delete process.env.SWITCHBOARD_DATA_DIR;
    else process.env.SWITCHBOARD_DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const legacy = openStore();
  legacy.connection.exec('DROP INDEX IF EXISTS idx_session_cache_agent');
  legacy.connection.exec('ALTER TABLE session_cache DROP COLUMN agentId');
  legacy.connection.exec("UPDATE settings SET value = '3' WHERE key = 'db_version'");
  legacy.closeDb();
  store = openStore();
  const columns = store.connection.prepare('PRAGMA table_info(session_cache)').all().map(c => c.name);
  assert.ok(columns.includes('agentId'));
  assert.ok(store.connection.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_session_cache_agent'").get());
});
