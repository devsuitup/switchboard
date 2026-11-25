'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const openStore = require('./fixtures/conversation-store.cjs');
const { readSessionFile } = require('../read-session-file');
const { encodeProjectPath } = require('../encode-project-path');
const { collectRefs, searchBody, mergeSearchBodyRefs, splitSearchBody, REFS_MAX_CHARS } = require('../src/main/session-index/session-refs');

const skip = !openStore.supported && 'Requires a compatible SQLite binding or Node 22 node:sqlite';
const SESSION = '7a1d2c3b-0000-4000-8000-000000001233';
const MENTIONED = '5190855a-a999-4843-962c-ea84cc36d4ee';

const refsOf = text => [...collectRefs(text, new Set(), SESSION)];

test('refs: issue, MR, forge URL and UUID forms are extracted and normalised', () => {
  assert.deepEqual(refsOf('see PR #1233 and MR !10'), ['#1233', '!10']);
  assert.deepEqual(refsOf('https://github.com/devsuitup/switchboard/pull/1243'), ['#1243', 'devsuitup/switchboard#1243']);
  assert.deepEqual(refsOf('https://github.com/o/r/issues/12'), ['#12', 'o/r#12']);
  assert.deepEqual(refsOf('https://gitlab.example.com/product/example-project/-/merge_requests/25629'),
    ['!25629', 'product/example-project!25629']);
  assert.deepEqual(refsOf(`resume ${MENTIONED.toUpperCase()} later`), [MENTIONED]);
  assert.deepEqual(refsOf(`own id ${SESSION}`), [], "a session's own id is not a ref");
  for (const noise of ['&#1233;', 'page#12', 'color #12ab', '#1', '#1234567', 'a/#123']) assert.deepEqual(refsOf(noise), [], noise);
});

test('refs: newest first, deduplicated and bounded', () => {
  const refs = new Set();
  collectRefs('#11 #22', refs);
  collectRefs('#11', refs);
  const body = searchBody('text', require('../src/main/session-index/session-refs').newestFirst(refs));
  assert.deepEqual(splitSearchBody(body), { text: 'text', refs: ['#11', '#22'] });
  const many = new Set();
  for (let i = 0; i < 2000; i++) collectRefs('#' + (10000 + i), many);
  const kept = require('../src/main/session-index/session-refs').newestFirst(many);
  assert.ok(kept.join(' ').length <= REFS_MAX_CHARS);
  assert.equal(kept[0], '#11999', 'the most recent ref survives the cap');
  assert.deepEqual(splitSearchBody(mergeSearchBodyRefs(body, ['#33', '#22'])).refs, ['#33', '#22', '#11']);
});

function transcript(dir, lines) {
  const file = path.join(dir, SESSION + '.jsonl');
  fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  return file;
}

const user = (text, cwd) => ({ type: 'user', cwd, timestamp: '2026-11-20T10:00:00.000Z', uuid: 'u-' + text.length + Math.random(),
  message: { role: 'user', content: text } });
const assistant = (content, cwd) => ({ type: 'assistant', cwd, timestamp: '2026-11-20T10:00:01.000Z', uuid: 'a-' + Math.random(),
  message: { role: 'assistant', model: 'claude', content } });

function longSession(cwd) {
  const filler = 'x'.repeat(600);
  const lines = [user('Start the release work', cwd)];
  for (let i = 0; i < 30; i++) lines.push(assistant([{ type: 'text', text: filler }], cwd), user(filler, cwd));
  lines.push(assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'gh pr view 1233 --repo o/r' } }], cwd));
  lines.push({ type: 'user', cwd, timestamp: '2026-11-20T10:05:00.000Z', uuid: 'tr', message: { role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'title: fix search (#1233)' }] }] } });
  return lines;
}

test('readSessionFile collects refs from the whole transcript, past the indexed text', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refs-1255-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const row = readSessionFile(transcript(dir, longSession(dir)), 'folder', dir);
  assert.ok(!row.textContent.includes('1233'), 'the reference lies beyond the indexed opening');
  assert.ok(row.refs.includes('#1233'), 'tool results are scanned');
});

function withCache(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refs-cache-1255-'));
  const projectsDir = path.join(root, 'projects');
  const projectPath = path.join(root, 'repo');
  fs.mkdirSync(projectPath, { recursive: true });
  const folder = encodeProjectPath(projectPath);
  const folderPath = path.join(projectsDir, folder);
  fs.mkdirSync(folderPath, { recursive: true });
  const previous = process.env.SWITCHBOARD_DATA_DIR;
  process.env.SWITCHBOARD_DATA_DIR = path.join(root, 'data');
  const store = openStore();
  t.after(() => {
    store.closeDb();
    if (previous === undefined) delete process.env.SWITCHBOARD_DATA_DIR;
    else process.env.SWITCHBOARD_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const cache = require('../session-cache');
  cache.init({ PROJECTS_DIR: projectsDir, activeSessions: new Map(), getMainWindow: () => null,
    log: { info() {}, warn() {}, error() {}, debug() {} }, db: store });
  cache.setRemoteRoots(new Map());
  return { store, cache, folder, folderPath, projectPath };
}

test('a session that discussed #1233 is found by "#1233", "1233" and "PR 1233"', { skip }, t => {
  const { store, cache, folder, folderPath, projectPath } = withCache(t);
  transcript(folderPath, longSession(projectPath));
  cache.refreshFolder(folder, { files: new Set([SESSION + '.jsonl']) });
  for (const query of ['#1233', '1233', 'PR 1233']) {
    assert.deepEqual(store.searchByType('session', query).map(r => r.id), [SESSION], query);
  }
});

test('an appended reference reaches the index through the incremental refresh', { skip }, t => {
  const { store, cache, folder, folderPath, projectPath } = withCache(t);
  const file = transcript(folderPath, [user('Start the release work for #1233', projectPath), assistant([{ type: 'text', text: 'ok' }], projectPath)]);
  cache.refreshFolder(folder, { files: new Set([SESSION + '.jsonl']) });
  assert.deepEqual(store.searchByType('session', '4321').map(r => r.id), []);
  fs.appendFileSync(file, JSON.stringify(assistant([{ type: 'text', text: 'appended words, merged !4321' }], projectPath)) + '\n');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  cache.refreshFolder(folder, { files: new Set([SESSION + '.jsonl']) });
  assert.deepEqual(store.searchByType('session', '!4321').map(r => r.id), [SESSION], 'the new ref is searchable');
  assert.deepEqual(store.searchByType('session', '1233').map(r => r.id), [SESSION], 'earlier refs are kept');
  assert.deepEqual(store.searchByType('session', 'appended words').map(r => r.id), [], 'the header-only refresh merged refs, not text');
});

test('a PR number that only a Codex tool returned is searchable', { skip }, t => {
  require('./fixtures/isolated-codex-home.cjs')(t);
  const { store } = withCache(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refs-codex-1255-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const id = '00000000-0000-4000-8000-000000004242';
  const file = path.join(dir, `rollout-2026-11-20T10-00-00-${id}.jsonl`);
  const lines = [
    { type: 'session_meta', timestamp: '2026-11-20T10:00:00.000Z', payload: { id, cwd: dir } },
    { type: 'response_item', timestamp: '2026-11-20T10:00:01.000Z', payload: { type: 'message', role: 'user', content: 'Find the open pull request' } },
    { type: 'response_item', timestamp: '2026-11-20T10:00:02.000Z', payload: { type: 'function_call', name: 'shell', arguments: '{"command":["gh","pr","list"]}', call_id: 'c1' } },
    { type: 'response_item', timestamp: '2026-11-20T10:00:03.000Z', payload: { type: 'function_call_output', call_id: 'c1',
      output: '{"output":"https://github.com/o/r/pull/4242\topen"}' } },
    { type: 'response_item', timestamp: '2026-11-20T10:00:04.000Z', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: 'merged !777' } },
  ];
  fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  const row = require('../harnesses/codex').readSessionFile(file, 'codex/2026/11/20');
  assert.ok(row, 'the rollout parses');
  store.upsertSearchEntries([{ id: row.sessionId, type: 'session', folder: row.folder, title: row.summary, body: searchBody(row.textContent, row.refs) }]);
  for (const query of ['4242', 'o/r#4242', '!777']) assert.deepEqual(store.searchByType('session', query).map(r => r.id), [row.sessionId], query);
});
