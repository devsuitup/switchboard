'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { loadAppFunctions } = require('./app-source');
const cache = require('../session-cache');
const { encodeProjectPath } = require('../encode-project-path');

function setup(t, graph, { live = {}, answer = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-continuations-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = encodeProjectPath(root);
  fs.mkdirSync(path.join(root, folder));
  for (const [id, children] of Object.entries(graph)) {
    const records = [
      { type: 'user', cwd: root, timestamp: '2026-10-09T12:00:00Z', message: { content: 'hello' } },
      ...children.map(child => ({ type: 'continued-in', sessionId: id, continuedInSessionId: child, timestamp: '2026-10-09T12:01:00Z' })),
      { type: 'assistant', timestamp: '2026-10-09T12:02:00Z', message: { content: 'after continuation' } },
    ];
    fs.writeFileSync(path.join(root, folder, id + '.jsonl'), records.map(JSON.stringify).join('\n') + '\n');
  }
  const rows = new Map();
  const db = {
    getSetting: () => ({}), getAllFolderMeta: () => new Map(), getAllMeta: () => new Map(),
    getCachedByFolder: () => [...rows.values()], getCachedSession: id => rows.get(id),
    upsertCachedSessions: entries => entries.forEach(row => rows.set(row.sessionId, row)),
    setFolderMeta() {}, getMeta() {}, setName() {}, upsertSearchEntries() {}, replaceSessionMetrics() {},
    deleteCachedFolder() {}, deleteCachedSession() {}, deleteSearchFolder() {}, deleteSearchSession() {},
  };
  cache.init({ PROJECTS_DIR: root, db, activeSessions: new Map(), getMainWindow: () => null, log: console });
  cache.refreshFolder(folder);
  const dom = new JSDOM('<body></body>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const ctx = dom.getInternalVMContext();
  const settingsFile = path.join(root, 'settings.json');
  const saved = [{ sessionId: 'old', projectPath: root, active: true }];
  fs.writeFileSync(settingsFile, JSON.stringify({ openWorkingSet: saved }));
  const spawned = [], prompts = [];
  dom.window.confirm = message => { prompts.push(message); return typeof answer === 'function' ? answer(message) : answer; };
  dom.window.api = {
    getSetting: async () => JSON.parse(fs.readFileSync(settingsFile, 'utf8')),
    setSetting: async (_, value) => fs.writeFileSync(settingsFile, JSON.stringify(value)),
    getSessionContinuations: async id => typeof cache.resolveSessionContinuations === 'function'
      ? cache.resolveSessionContinuations(id) : { candidates: [], unresolved: false },
    getSessionLiveElsewhere: async id => live[id] || null,
    getSessionsLiveElsewhere: async ids => Object.fromEntries(ids.filter(id => live[id]).map(id => [id, live[id]])),
    openTerminal: async (id, project, isNew, options) => { spawned.push({ id, project, options }); return { ok: true }; },
  };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/resume-guard.js'), 'utf8'), ctx);
  vm.runInContext(`
    var openSessions = new Map(), sessionMap = new Map();
    var activeSessionId = null, restoringWorkingSet = true, restorePlanner = null;
    var sessionOpenedOutsideRestore = false, _persistChain = Promise.resolve();
    var RESTORE_STAGGER_MS = 0;
    function createTerminalEntry(session) {
      const entry = { session, terminal: { write() {} }, initialSize: {} };
      openSessions.set(session.sessionId, entry); return entry;
    }
    function showSession(id) { activeSessionId = id; }
    function destroySession(id) { openSessions.delete(id); }
    async function resolveDefaultSessionOptions() { return {}; }
    function syncPtySizeAfterOpen() {} function setSessionSandboxed() {}
    function forgetSessionExit() {} function beginPtyOpen() {} function settlePtyOpen() {}
    function schedulePersistWorkingSet() {} function pollActiveSessions() {}
    function showLiveElsewhereNotice() {}
  `, ctx);
  ctx.rows = [...rows.values()];
  vm.runInContext('rows.forEach(row => sessionMap.set(row.sessionId, row));', ctx);
  const app = loadAppFunctions(ctx, {
    declarations: ['skippedWorkingSetEntries', 'restoreSavedIndex', 'restoreAwaitingConsent', 'restoreInFlight'],
    functions: ['runRestore', 'openSession', 'persistWorkingSet', 'pendingRestoreEntries'],
  });
  return {
    spawned, prompts, rows, root, db, folder, ctx,
    restore: async () => { await app.runRestore(saved); await app.persistWorkingSet(); },
    click: async () => { await app.openSession(rows.get('old')); await app.persistWorkingSet(); },
    settings: () => JSON.parse(fs.readFileSync(settingsFile, 'utf8')),
  };
}

for (const [name, graph, expected] of [
  ['one continuation', { old: ['new'], new: [] }, 'new'],
  ['a chain old to mid to new', { old: ['mid'], mid: ['new'], new: [] }, 'new'],
  ['no continued-in record', { old: [] }, 'old'],
  ['converging branches', { old: ['mid', 'new'], mid: ['new'], new: [] }, 'new'],
]) {
  test(`restore resolves ${name} and persists the final id`, { timeout: 9000 }, async t => {
    const h = setup(t, graph);
    await h.restore();
    assert.deepEqual(h.spawned.map(call => call.id), [expected]);
    assert.equal(h.spawned[0].project, h.root);
    assert.deepEqual(h.settings().openWorkingSet, [{ sessionId: expected, projectPath: h.root, active: true }]);
    assert.equal(h.prompts.length, 0);
  });
}

for (const [name, graph] of [
  ['two terminal continuations', { old: ['a', 'b'], a: [], b: [] }],
  ['a cycle', { old: ['mid'], mid: ['old'] }],
  ['a missing continuation', { old: ['missing'] }],
]) {
  test(`restore asks before ${name} and spawns nothing on dismissal`, { timeout: 9000 }, async t => {
    const h = setup(t, graph);
    await h.restore();
    assert.deepEqual(h.spawned, []);
    assert.ok(h.prompts.length > 0);
    assert.equal(h.settings().openWorkingSet[0].sessionId, 'old');
    if (name === 'two terminal continuations') {
      assert.match(h.prompts[0], /a/);
      assert.match(h.prompts[0], /b/);
      assert.match(h.prompts[0], /2026-10-09T12:02:00Z/);
    }
  });
}

test('manual click offers the continuation before opening it', { timeout: 9000 }, async t => {
  const h = setup(t, { old: ['new'], new: [] }, { answer: true });
  await h.click();
  assert.deepEqual(h.spawned.map(call => call.id), ['new']);
  assert.match(h.prompts[0], /new/);
});

test('choosing the second continuation opens only that candidate and persists it', { timeout: 9000 }, async t => {
  const h = setup(t, { old: ['a', 'b'], a: [], b: [] }, { answer: message => /Open b\?/.test(message) });
  await h.restore();
  assert.deepEqual(h.spawned.map(call => call.id), ['b']);
  assert.equal(h.settings().openWorkingSet[0].sessionId, 'b');
});

test('a fresh continuation index resolves without reading transcript contents again', { timeout: 9000 }, async t => {
  const h = setup(t, { old: ['new'], new: [] });
  const read = t.mock.method(fs, 'readSync');
  const full = t.mock.method(fs, 'readFileSync');
  const result = await h.ctx.api.getSessionContinuations('old');
  assert.deepEqual(result.candidates.map(candidate => candidate.sessionId), ['new']);
  assert.equal(read.mock.callCount(), 0);
  assert.equal(full.mock.callCount(), 0);
});

test('a malformed continuation target asks rather than resuming the old id', { timeout: 9000 }, async t => {
  const h = setup(t, { old: [] });
  const file = path.join(h.root, h.folder, 'old.jsonl');
  fs.appendFileSync(file, '{"type":"continued-in","sessionId":"old","continuedInSessionId":"../escape"}\n');
  delete h.rows.get('old').continuationIndex;
  await h.restore();
  assert.deepEqual(h.spawned, []);
  assert.ok(h.prompts.length);
});

test('restore attaches to the continued background job', { timeout: 9000 }, async t => {
  const h = setup(t, { old: ['new'], new: [] }, { live: { new: { kind: 'bg', jobId: '1234abcd', cwd: '/bg', pid: 1 } } });
  await h.restore();
  assert.deepEqual(h.spawned.map(call => call.id), ['new']);
  assert.equal(h.spawned[0].options.type, 'attach');
  assert.equal(h.spawned[0].options.jobId, '1234abcd');
  assert.equal(h.settings().openWorkingSet[0].sessionId, 'new');
  assert.equal(h.settings().openWorkingSet[0].active, true);
});

test('reopening a closed old tab still offers its continuation', { timeout: 9000 }, async t => {
  const h = setup(t, { old: ['new'], new: [] }, { answer: true });
  vm.runInContext('openSessions.set("old", { session: sessionMap.get("old"), closed: true });', h.ctx);
  await h.click();
  assert.deepEqual(h.spawned.map(call => call.id), ['new']);
  assert.match(h.prompts[0], /new/);
});

test('a held old entry is rekeyed when manual continuation opening meets a live schedule', { timeout: 9000 }, async t => {
  const h = setup(t, { old: ['new'], new: [] }, { answer: true, live: { new: { kind: 'schedule', pid: 2 } } });
  vm.runInContext(`skippedWorkingSetEntries.set('old', { item: { sessionId: 'old', projectPath: ${JSON.stringify(h.root)} }, index: 0 });`, h.ctx);
  await h.click();
  assert.deepEqual(h.spawned, []);
  assert.equal(h.settings().openWorkingSet[0].sessionId, 'new');
});

test('manual continuation attach preserves the rekeyed held working-set entry', { timeout: 9000 }, async t => {
  const h = setup(t, { old: ['new'], new: [] }, { answer: true, live: { new: { kind: 'bg', jobId: '1234abcd', pid: 2 } } });
  vm.runInContext(`skippedWorkingSetEntries.set('old', { item: { sessionId: 'old', projectPath: ${JSON.stringify(h.root)} }, index: 0 });`, h.ctx);
  await h.click();
  assert.equal(h.spawned[0].options.type, 'attach');
  assert.equal(h.settings().openWorkingSet[0]?.sessionId, 'new');
  assert.equal(h.settings().openWorkingSet[0]?.active, true);
});

for (const size of [2, 5]) test(`legacy cache fallback streams a ${size} MiB ordinary record before continued-in`, { timeout: 9000 }, async t => {
  const h = setup(t, { old: [], new: [] });
  const file = path.join(h.root, h.folder, 'old.jsonl');
  fs.appendFileSync(file, JSON.stringify({ sessionId: 'old', type: 'assistant', message: { content: 'x'.repeat(size * 1024 * 1024) } }) + '\n');
  fs.appendFileSync(file, JSON.stringify({ type: 'continued-in', sessionId: 'old', continuedInSessionId: 'new' }) + '\n');
  delete h.rows.get('old').continuationIndex;
  await h.restore();
  assert.deepEqual(h.spawned.map(call => call.id), ['new']);
});

test('a partial continuation recovers once the CLI finishes its record', { timeout: 9000 }, async t => {
  const h = setup(t, { old: [], new: [] });
  const file = path.join(h.root, h.folder, 'old.jsonl');
  fs.appendFileSync(file, '{"type":"continued-in","sessionId":"old",');
  await h.restore();
  assert.deepEqual(h.spawned, []);
  fs.appendFileSync(file, '"continuedInSessionId":"new"}\n');
  await h.restore();
  assert.deepEqual(h.spawned.map(call => call.id), ['new']);
});

test('depth limit asks without resuming the original id', { timeout: 9000 }, async t => {
  const graph = { old: ['n0'] };
  for (let i = 0; i < 35; i++) graph['n' + i] = i === 34 ? [] : ['n' + (i + 1)];
  const h = setup(t, graph);
  await h.restore();
  assert.deepEqual(h.spawned, []);
  assert.ok(h.prompts.length);
});

test('refresh indexes a continuation appended beyond the display header', { timeout: 9000 }, async t => {
  const h = setup(t, { old: [], new: [] });
  const file = path.join(h.root, h.folder, 'old.jsonl');
  fs.appendFileSync(file, JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(300000) } }) + '\n');
  fs.appendFileSync(file, JSON.stringify({ type: 'continued-in', sessionId: 'old', continuedInSessionId: 'new' }) + '\n{}\n');
  fs.utimesSync(file, new Date('2030-01-01'), new Date('2030-01-01'));
  cache.refreshFolder(h.folder, { files: new Set(['old.jsonl']) });
  await h.restore();
  assert.deepEqual(h.spawned.map(call => call.id), ['new']);
});
