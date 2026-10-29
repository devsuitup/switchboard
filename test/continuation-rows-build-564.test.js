'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const cache = require('../session-cache');
const { encodeProjectPath } = require('../encode-project-path');

function fixture(t, { active = new Map(), global = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollup-564-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const folder = encodeProjectPath(dir);
  const rows = ['a', 'b', 'c'].map((sessionId, i) => ({ sessionId, folder, projectPath: dir,
    modified: `2026-10-19T00:00:0${i}.000Z`, summary: 'prompt', firstPrompt: 'prompt', messageCount: i + 1,
    fileMtime: 'now', continuationIndex: JSON.stringify({ format: 3, complete: true, mtime: 'now', ids: i < 2 ? [['b', 'c'][i]] : [] }) }));
  const meta = new Map();
  cache.init({ PROJECTS_DIR: dir, activeSessions: active, getMainWindow: () => null, log: console,
    db: { getAllCached: () => rows, getAllMeta: () => meta, getAllFolderMeta: () => new Map(), getSetting: key => key === 'global' ? global : null,
      getMeta: id => meta.get(id), getCachedByFolder: () => rows,
      getFolderMeta: () => ({ projectPath: dir }), setFolderMeta() {},
      upsertCachedSessions: updated => { for (const r of updated) Object.assign(rows.find(old => old.sessionId === r.sessionId), r); },
      upsertSearchEntries() {}, setName() {} } });
  return { dir, folder, rows, meta, list: (all = false) => cache.buildProjectsFromCache(all).flatMap(p => p.sessions) };
}
test('14: build preserves root identity, newest head, counts and own parts', t => {
  const h = fixture(t);
  const rows = h.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sessionId, 'a');
  assert.equal(rows[0].headSessionId, 'c');
  assert.deepEqual(rows[0].mergedMemberIds, ['c', 'b']);
  assert.equal(rows[0].messageCount, 6);
  assert.deepEqual(rows[0].conversationParts.map(p => p.sessionId), ['a', 'c', 'b']);
  assert.equal(rows[0].conversationParts[0].modified, h.rows[0].modified);
});
test('15: a changed edge splits a previously linear row', t => {
  const h = fixture(t);
  h.rows.pop();
  h.rows[1].continuationIndex = null;
  h.rows.push({ ...h.rows[1], sessionId: 'd' });
  assert.equal(h.list().length, 2);
  h.rows[0].continuationIndex = JSON.stringify({ format: 3, complete: true, mtime: 'now', ids: ['b', 'd'] });
  assert.equal(h.list().length, 3);
});
test('16: metadata union and archived subagents include rolled parts', t => {
  const h = fixture(t);
  h.rows.push({ ...h.rows[0], sessionId: 'sub:b:1', parentSessionId: 'b', continuationIndex: null });
  h.meta.set('a', { archived: 1 });
  h.meta.set('c', { starred: 1 });
  assert.deepEqual(h.list().map(r => r.sessionId).sort(), ['a', 'sub:b:1']);
  assert.equal(h.list()[0].starred, 1);
  h.meta.set('b', { archived: 1 }); h.meta.set('c', { archived: 1 });
  assert.equal(h.list().length, 0);
  assert.equal(h.list(true).length, 2);
});
test('19: member resolution from every part includes rolled parts and their mirrors', t => {
  const h = fixture(t);
  h.rows.pop(); h.rows[1].continuationIndex = null;
  h.rows.push({ ...h.rows[1], sessionId: 'm', mergedIntoSessionId: 'b' });
  for (const id of ['a', 'b', 'm']) {
    assert.deepEqual(cache.conversationMemberIds(h.rows, id).sort(), ['a', 'b', 'm'].filter(p => p !== id));
  }
});
test('21: main Delete and metadata resolver use the same rolled member set', t => {
  const h = fixture(t);
  const filename = path.join(__dirname, '../main.js');
  const source = fs.readFileSync(filename, 'utf8');
  const sandbox = { getAllCached: () => h.rows, sessionCache: cache, cliSessionState: { getSidebarDescriptors: () => [] }, activeSessions: new Map() };
  vm.createContext(sandbox);
  for (const name of ['getConversationPartIds', 'getMergedMemberIds']) {
    const start = source.indexOf(`function ${name}(`);
    vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), sandbox, { filename });
  }
  assert.deepEqual(Array.from(sandbox.getConversationPartIds('B')).sort(), ['a', 'b', 'c']);
  assert.deepEqual(Array.from(sandbox.getMergedMemberIds('a')).sort(), ['b', 'c']);
});
test('22: refresh reports a multi-id continuation change with unchanged display fields', t => {
  const h = fixture(t);
  h.rows.splice(1);
  const r = h.rows[0];
  const dir = path.join(h.dir, h.folder);
  fs.mkdirSync(dir);
  const file = path.join(dir, 'a.jsonl');
  const contents = target => [{ type: 'user', sessionId: 'a', cwd: h.dir, message: { content: 'prompt' } },
    ...['m', target].map(id => ({ type: 'continued-in', sessionId: 'a', continuedInSessionId: id }))].map(JSON.stringify).join('\n') + '\n';
  fs.writeFileSync(file, contents('b'));
  const stat = fs.statSync(file);
  r.fileMtime = stat.mtime.toISOString();
  r.continuationIndex = JSON.stringify({ format: 3, complete: true, mtime: r.fileMtime, ids: ['m', 'b'] });
  fs.writeFileSync(file, contents('d'));
  r.fileMtime = 'old';
  assert.equal(cache.refreshFolder(h.folder, { files: new Set(['a.jsonl']) }), true);
  assert.deepEqual(JSON.parse(r.continuationIndex).ids, ['m', 'd']);
});

for (const [name, options] of [
  ['P1: a running SDK continuation part keeps its row listed', { active: new Map([['b', { exited: false }]]) }],
  ['P1b: a saved SDK continuation part keeps its row listed', { global: { openWorkingSet: [{ sessionId: 'b' }] } }],
]) {
  test(name, t => {
    const h = fixture(t, options);
    for (const r of h.rows) r.entrypoint = 'sdk-py';
    const sessions = h.list();
    assert.deepEqual(sessions.map(s => s.sessionId), ['a']);
    assert.deepEqual(sessions[0].mergedMemberIds, ['c', 'b']);
  });
}

test('P12: subagents of SDK rolled parts and mirrors follow their visible root', t => {
  const h = fixture(t);
  h.rows[0].entrypoint = 'cli';
  h.rows[1].entrypoint = 'sdk-py';
  h.rows[2].entrypoint = 'sdk-py';
  h.rows.push({ ...h.rows[2], sessionId: 'm', mergedIntoSessionId: 'c' });
  for (const parentSessionId of ['b', 'c', 'm']) {
    h.rows.push({ ...h.rows[1], sessionId: `sub:${parentSessionId}:1`, parentSessionId, continuationIndex: null });
  }
  assert.deepEqual(h.list().map(s => s.sessionId).sort(), ['a', 'sub:b:1', 'sub:c:1', 'sub:m:1']);
  h.rows[0].entrypoint = 'sdk-py';
  assert.deepEqual(h.list(), []);
});

test('notification: reordering continuation ids does not refresh the sidebar', t => {
  const h = fixture(t);
  h.rows.splice(1);
  const r = h.rows[0];
  const dir = path.join(h.dir, h.folder);
  fs.mkdirSync(dir);
  const file = path.join(dir, 'a.jsonl');
  fs.writeFileSync(file, [
    { type: 'user', sessionId: 'a', cwd: h.dir, message: { content: 'prompt' } },
    ...['b', 'm'].map(id => ({ type: 'continued-in', sessionId: 'a', continuedInSessionId: id })),
  ].map(JSON.stringify).join('\n') + '\n');
  r.fileMtime = fs.statSync(file).mtime.toISOString();
  r.fileSize = fs.statSync(file).size;
  r.continuationIndex = JSON.stringify({ format: 3, complete: true, mtime: r.fileMtime, ids: ['m', 'b'], stamp: { size: '0' } });
  assert.equal(cache.refreshFolder(h.folder, { files: new Set(['a.jsonl']) }), 'activity');
  assert.deepEqual(JSON.parse(r.continuationIndex).ids, ['b', 'm']);
});
