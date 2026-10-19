'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const cache = require('../session-cache');
const { mergeLocalBackgroundSessions } = require('../sidebar-bg-sessions');
const { createWriterCommands } = require('../session-index-commands');
const openStore = require('./fixtures/conversation-store.cjs');
const storeOptions = { skip: !openStore.supported && 'native SQLite ABI differs; node:sqlite requires Node 22' };

function fixture(t, background = false, missingHead = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-564-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rows = ['a', 'b', 'c'].map((sessionId, i) => ({ sessionId, folder: 'project', projectPath: dir,
    summary: sessionId, modified: `2026-10-19T00:00:0${i}Z`, messageCount: 1,
    mergedIntoSessionId: i && !background ? 'a' : null }));
  if (background) {
    rows[0].continuationIndex = JSON.stringify({ format: 3, complete: true, ids: ['b'] });
    rows[1].continuationIndex = JSON.stringify({ format: 3, complete: true, ids: ['c'] });
    if (missingHead) rows.pop();
  }
  const descriptors = background ? [{ sessionId: 'c', kind: 'bg', jobId: 'job', cwd: dir }] : [];
  const jobs = new Map([['job', { state: 'working' }]]);
  const meta = new Map();
  const activeSessions = new Map();
  cache.init({ PROJECTS_DIR: dir, activeSessions, getMainWindow: () => null, log: console,
    getLocalDescriptors: () => descriptors, getLocalJobs: () => jobs,
    db: { getAllCached: () => rows, getAllMeta: () => meta, getAllFolderMeta: () => new Map(), getSetting: () => null } });
  return { rows, meta, descriptors, jobs, activeSessions,
    list: (all = false) => cache.buildProjectsFromCache(all).flatMap(p => p.sessions) };
}

test('16: an archived root stays visible until every existing merged part is archived', t => {
  for (const bg of [false, true]) {
    const h = fixture(t, bg);
    h.meta.set('a', { archived: 1 });
    assert.equal(h.list().length, 1);
    h.meta.set('b', { archived: 1 }); h.meta.set('c', { archived: 1 });
    assert.equal(h.list().length, 0);
    assert.equal(h.list(true)[0].archived, 1);
  }
});

test('metadata-only mirror builds prefilter indexes without parsing empty values', t => {
  const h = fixture(t);
  let reads = 0;
  Object.defineProperty(h.rows[0], 'continuationIndex', { get() { reads++; return null; } });
  assert.equal(h.list().length, 1);
  assert.equal(reads, 1);
});

test('a live background build shares the rollup between display and metadata', t => {
  const h = fixture(t, true);
  let reads = 0;
  for (const row of h.rows) {
    const index = row.continuationIndex;
    Object.defineProperty(row, 'continuationIndex', { get() { reads++; return index; } });
  }
  assert.equal(h.list().length, 1);
  assert.equal(reads, 2 * h.rows.length + 2);
});

test('a live background row has identical Delete and Archive targets and checks its guard before removal', async t => {
  const h = fixture(t, true);
  h.rows.push({ ...h.rows[1], sessionId: 'm', mergedIntoSessionId: 'b', continuationIndex: null });
  const filename = path.join(__dirname, '../main.js');
  const source = fs.readFileSync(filename, 'utf8');
  const handlers = new Map();
  let archived;
  const sandbox = { getAllCached: () => h.rows, sessionCache: cache, activeSessions: h.activeSessions,
    cliSessionState: { getSidebarDescriptors: () => h.descriptors },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    setArchived: ids => { archived = Array.from(ids); } };
  vm.createContext(sandbox);
  for (const name of ['getConversationPartIds', 'getMergedMemberIds']) {
    const start = source.indexOf(`function ${name}(`);
    vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), sandbox, { filename });
  }
  const start = source.indexOf("ipcMain.handle('archive-session'");
  vm.runInContext(source.slice(start, source.indexOf('\n});', start) + 4), sandbox, { filename });
  const folder = path.join(h.rows[0].projectPath, 'project');
  fs.mkdirSync(folder);
  for (const row of h.rows) fs.writeFileSync(path.join(folder, row.sessionId + '.jsonl'), '{}\n');
  const { loadDeletionHandlers } = require('./delete-session-harness');
  let guarded;
  const deletion = loadDeletionHandlers({ PROJECTS_DIR: h.rows[0].projectPath,
    getCachedFolder: () => 'project', getMergedMemberIds: sandbox.getMergedMemberIds, getCachedByParent: () => [],
    deleteSessionGuard: async (_id, ids) => { guarded = Array.from(ids); return 'live background'; } });
  for (const id of ['a', 'b', 'c', 'm']) {
    await handlers.get('archive-session')(null, id, true);
    const preview = deletion.get('delete-session-preview')(null, id);
    assert.equal(preview.ok, true);
    assert.deepEqual(Array.from(preview.partIds).sort(), archived.slice().sort());
    const result = await deletion.get('delete-session')(null, id, preview.partIds);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'live background');
    assert.deepEqual(guarded.sort(), archived.slice().sort());
    for (const row of h.rows) assert.ok(fs.existsSync(path.join(folder, row.sessionId + '.jsonl')));
  }
});

test('24: any pinned part pins the conversation and no pinned part clears it', t => {
  const h = fixture(t);
  h.meta.set('c', { starred: 1 });
  assert.equal(h.list()[0].starred, 1);
  h.meta.clear();
  assert.equal(h.list()[0].starred, 0);
});

test('25: newest user rename wins across all parts, else the root name', t => {
  const h = fixture(t);
  h.meta.set('a', { name: 'root', nameSource: 'user', nameRevision: 5 });
  h.meta.set('b', { name: 'middle', nameSource: 'user', nameRevision: 7 });
  h.meta.set('c', { name: 'head', nameSource: 'user', nameRevision: 9, starred: 0 });
  assert.equal(h.list()[0].name, 'head');
  h.meta.set('a', { name: 'root', nameSource: 'transcript' });
  h.meta.set('b', { name: 'middle', nameSource: 'transcript' });
  h.meta.set('c', { name: 'head', nameSource: 'transcript' });
  assert.equal(h.list()[0].name, 'root');
});

test('28: subagents of any part follow the whole conversation archive state', t => {
  for (const bg of [false, true]) {
    const h = fixture(t, bg);
    h.rows.push({ ...h.rows[0], sessionId: 'sub:a:x', parentSessionId: 'a', mergedIntoSessionId: null, continuationIndex: null });
    h.meta.set('a', { archived: 1 });
    assert.ok(h.list().some(row => row.sessionId === 'sub:a:x'));
    h.meta.set('b', { archived: 1 }); h.meta.set('c', { archived: 1 });
    assert.equal(h.list().length, 0);
  }
});

test('29: a mirror supplies pin and keeps an archived representative visible', t => {
  const h = fixture(t);
  h.meta.set('a', { archived: 1 }); h.meta.set('b', { archived: 1 });
  h.meta.set('c', { starred: 1 });
  assert.equal(h.list()[0].starred, 1);
  assert.equal(h.list()[0].archived, 0);
});

test('30: live background metadata reads root, middle, head and mirrors alike', t => {
  const h = fixture(t, true, true);
  h.rows.push({ ...h.rows[1], sessionId: 'm', mergedIntoSessionId: 'b', continuationIndex: null });
  h.meta.set('a', { name: 'latest root', nameSource: 'user', nameRevision: 10, starred: 1 });
  h.meta.set('c', { name: 'head', nameSource: 'user', nameRevision: 9, starred: 0 });
  assert.equal(h.list()[0].name, 'latest root');
  assert.equal(h.list()[0].starred, 1);
  h.meta.set('b', { name: 'latest middle', nameSource: 'user', nameRevision: 11 });
  assert.equal(h.list()[0].name, 'latest middle');
  h.meta.set('m', { name: 'latest mirror', nameSource: 'user', nameRevision: 12 });
  assert.equal(h.list()[0].name, 'latest mirror');
});

test('25: clearing the latest background rename restores the original title', () => {
  const row = { sessionId: 'a', folder: 'project', projectPath: '/project', name: 'older rename',
    customTitle: 'Original title', continuationIndex: JSON.stringify({ format: 3, complete: true, ids: ['b'] }) };
  mergeLocalBackgroundSessions([{ projectPath: '/project', sessions: [row] }], [row],
    [{ sessionId: 'b', kind: 'bg', jobId: 'job', nameSource: 'collision' }], {
      hiddenProjects: new Set(), showArchived: true, jobs: new Map([['job', { state: 'working' }]]),
      metaMap: new Map([['a', { name: 'older rename', nameSource: 'user', nameRevision: 1 }],
        ['b', { name: null, nameSource: 'user', nameRevision: 3 }]]),
    });
  assert.equal(row.name, 'Original title');
});

test('30: a filtered SDK mirror still supplies pin and archive to the background conversation', t => {
  const h = fixture(t, true, true);
  h.rows[1].entrypoint = 'sdk-ts';
  h.rows.push({ ...h.rows[1], sessionId: 'm', mergedIntoSessionId: 'b', continuationIndex: null });
  for (const id of ['a', 'b', 'c']) h.meta.set(id, { archived: 1 });
  h.rows[0].customTitle = 'launch title';
  Object.assign(h.descriptors[0], { name: 'registry overlay', nameSource: 'user' });
  h.meta.set('m', { archived: 0, starred: 1, name: 'mirror rename', nameSource: 'user', nameRevision: 1 });
  assert.equal(h.list().length, 1);
  assert.equal(h.list()[0].starred, 1);
  assert.equal(h.list()[0].archived, 0);
  assert.equal(h.list()[0].name, 'mirror rename');
});

function storeFixture(t) {
  const previous = process.env.SWITCHBOARD_DATA_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-store-564-'));
  process.env.SWITCHBOARD_DATA_DIR = dir;
  const db = openStore();
  t.after(() => { db.closeDb(); if (previous === undefined) delete process.env.SWITCHBOARD_DATA_DIR;
    else process.env.SWITCHBOARD_DATA_DIR = previous; fs.rmSync(dir, { recursive: true, force: true }); });
  for (const id of ['a', 'b', 'c']) {
    db.setName(id, 'old');
    db.upsertCachedSessions([{ sessionId: id, folder: 'project', projectPath: dir, summary: id,
      firstPrompt: null, created: null, modified: null }]);
    db.upsertSearchEntries([{ id, type: 'session', folder: 'project', title: 'old ' + id, body: 'text' }]);
  }
  return db;
}

for (const [method, value, field] of [['setArchived', true, 'archived'], ['setStarred', true, 'starred'], ['setName', 'new', 'name']]) {
  test(`23: ${method} rolls back all metadata and revisions on the second part failure`, storeOptions, t => {
    const db = storeFixture(t);
    const before = JSON.stringify([...db.getAllMeta(true)]);
    db.connection.exec(`CREATE TRIGGER fail_part BEFORE UPDATE OF ${field} ON session_meta WHEN NEW.sessionId = 'b'
      BEGIN SELECT RAISE(ABORT, 'second part failed'); END`);
    assert.throws(() => db[method](['a', 'b', 'c'], value), /second part failed/);
    assert.equal(JSON.stringify([...db.getAllMeta(true)]), before);
    assert.equal(db.searchByType('session', 'old').length, 3);
  });
}

test('27: explicitly pinning twice keeps every part pinned, then unpin clears every part', storeOptions, t => {
  const db = storeFixture(t);
  db.toggleStar('b');
  db.setStarred(['a', 'b', 'c'], true);
  db.setStarred(['a', 'b', 'c'], true);
  assert.deepEqual(['a', 'b', 'c'].map(id => db.getMeta(id).starred), [1, 1, 1]);
  db.setStarred(['a', 'b', 'c'], false);
  assert.deepEqual(['a', 'b', 'c'].map(id => db.getMeta(id).starred), [0, 0, 0]);
});

for (const attached of [false, true]) test(`26: main resolves every part and ignores renderer membership (${attached ? 'attach fallback' : 'registry'})`, storeOptions, async t => {
  const db = storeFixture(t);
  const h = fixture(t, true, true);
  h.rows.push({ ...h.rows[1], sessionId: 'm', mergedIntoSessionId: 'b', continuationIndex: null });
  if (attached) {
    h.descriptors.length = 0;
    h.activeSessions.set('c', { isAttach: true, attachJobId: 'job', cwd: h.rows[0].projectPath });
  }
  const commands = createWriterCommands(db);
  const handlers = new Map();
  const filename = path.join(__dirname, '../main.js');
  const source = fs.readFileSync(filename, 'utf8');
  const sandbox = { ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    sessionCache: cache, getAllCached: () => h.rows, activeSessions: h.activeSessions,
    cliSessionState: { getSidebarDescriptors: () => h.descriptors }, bgAgents: { getCachedJobs: () => h.jobs },
    setStarred: (...args) => db.setStarred(...args), setArchived: (...args) => db.setArchived(...args),
    writer: { renameSession: (...args) => db.transact(() => commands.renameSession(...args)) } };
  vm.createContext(sandbox);
  const start = source.indexOf('function getConversationPartIds(');
  assert.notEqual(start, -1, 'main-side part resolver');
  vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), sandbox, { filename });
  for (const name of ['archive-session', 'set-star', 'rename-session']) {
    const offset = source.indexOf(`ipcMain.handle('${name}'`);
    assert.notEqual(offset, -1, name);
    vm.runInContext(source.slice(offset, source.indexOf('\n});', offset) + 4), sandbox, { filename });
  }
  for (const id of ['a', 'b', 'c', 'm', 'A']) {
    await handlers.get('archive-session')(null, id, true, ['unrelated']);
    assert.ok(['a', 'b', 'c', 'm'].every(part => db.getMeta(part).archived));
    await handlers.get('archive-session')(null, id, false);
    assert.ok(['a', 'b', 'c', 'm'].every(part => !db.getMeta(part).archived));
    await handlers.get('set-star')(null, id, true, ['unrelated']);
    assert.ok(['a', 'b', 'c', 'm'].every(part => db.getMeta(part).starred));
    await handlers.get('set-star')(null, id, false);
    assert.ok(['a', 'b', 'c', 'm'].every(part => !db.getMeta(part).starred));
    await handlers.get('rename-session')(null, id, 'conversation', ['unrelated']);
    assert.ok(['a', 'b', 'c', 'm'].every(part => db.getMeta(part).name === 'conversation'));
    assert.equal(db.searchByType('session', 'conversation').length, 3);
    assert.equal(db.getMeta('unrelated'), null);
    assert.equal(db.getMeta('A'), null);
  }
});

test('27: preload exposes an explicit set and the sidebar sends the desired value', () => {
  const filename = path.join(__dirname, '../preload.js');
  const calls = [];
  let api;
  const sandbox = { process, require: () => ({ contextBridge: { exposeInMainWorld: (_key, value) => { api = value; } },
    ipcRenderer: { invoke: (...args) => calls.push(args), on() {} } }) };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  assert.equal(typeof api.setStar, 'function');
  api.setStar('a', true); api.setStar('a', false);
  assert.deepEqual(calls, [['set-star', 'a', true], ['set-star', 'a', false]]);
});
