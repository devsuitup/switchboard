'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cache = require('../session-cache');
const { readSessionFile } = require('../read-session-file');
const { scanContinuationIndex } = require('../session-continuations');
const { loadAppFunctions } = require('./app-source');
const { setup } = require('./continuations-harness');

for (const [name, line] of [
  ['oversized tool output quoting continued-in', JSON.stringify({ type: 'assistant', message: { content: 'continued-in ' + 'x'.repeat(1024 * 1024) } })],
  ['malformed ordinary line mentioning continued-in', '{"type":"assistant","message":"continued-in",broken}'],
]) {
  test(`R4 R1 ${name} agrees across indexers and append restore`, { timeout: 9000 }, async t => {
    const h = setup(t, { old: [] });
    const file = path.join(h.root, h.folder, 'old.jsonl');
    const previous = scanContinuationIndex(file, 'old');
    fs.appendFileSync(file, line + '\n');
    const full = JSON.parse(readSessionFile(file, h.folder, h.root).continuationIndex);
    const appended = JSON.parse(scanContinuationIndex(file, 'old', previous, 4 * 1024 * 1024));
    assert.equal(full.unresolved, false, 'full index ignores unrelated bytes');
    assert.equal(appended.unresolved, false, 'append index ignores unrelated bytes');
    assert.deepEqual(appended.ids, full.ids);
    h.db.setCachedContinuationIndex('old', JSON.stringify(appended));
    fs.appendFileSync(file, '{}\n');
    await h.restore();
    assert.deepEqual(h.spawned.map(call => call.id), ['old']);
    assert.deepEqual(h.prompts, []);
  });
}

test('R4 R1 oversized skip survives chunk boundary and later append without holding', { timeout: 9000 }, async t => {
  const h = setup(t, { old: [] });
  const file = path.join(h.root, h.folder, 'old.jsonl');
  fs.appendFileSync(file, '{"type":"assistant","padding":"' + 'x'.repeat(1024 * 1024) + 'continued-in');
  let index = scanContinuationIndex(file, 'old', undefined, 2 * 1024 * 1024);
  assert.equal(JSON.parse(index).unresolved, false);
  fs.appendFileSync(file, 'continued-in"}\n');
  index = scanContinuationIndex(file, 'old', index);
  assert.equal(JSON.parse(index).unresolved, false);
  h.db.setCachedContinuationIndex('old', index);
  await h.restore();
  assert.deepEqual(h.spawned.map(call => call.id), ['old']);
});

for (const type of ['"type":"continued-in"', '"type" \t: \t"continued-in"']) {
  test(`R4 R1 malformed actual continuation stays unresolved (${type})`, { timeout: 9000 }, t => {
    const h = setup(t, { old: [] });
    const file = path.join(h.root, h.folder, 'old.jsonl');
    fs.appendFileSync(file, '{' + type + ',"sessionId":"old",broken}\n');
    assert.equal(JSON.parse(readSessionFile(file, h.folder, h.root).continuationIndex).unresolved, true);
    assert.equal(JSON.parse(scanContinuationIndex(file, 'old')).unresolved, true);
  });
}

function indexingHarness(h, { settled = true } = {}) {
  vm.runInContext(`restoreIndexingDone = false; restorePlanner = { isSettled: () => ${settled}, pending: () => [] };`, h.ctx);
  h.ctx.loadProjects = async () => {
    cache.refreshFolder(h.folder);
    h.ctx.indexedRows = [...h.rows.values()];
    vm.runInContext('indexedRows.forEach(row => sessionMap.set(row.sessionId, row));', h.ctx);
  };
  h.ctx.tickRestorePlanner = async () => {};
  return loadAppFunctions(h.ctx, { functions: ['markRestoreIndexingDone'] });
}

for (const settled of [true, false]) {
  test(`R4 R2 indexing completion retries held unindexed continuation (planner settled=${settled})`, { timeout: 9000 }, async t => {
    const h = setup(t, { old: ['new'], new: [], other: [] }, {
      savedEntries: [{ sessionId: 'old', active: true }, { sessionId: 'other' }],
    });
    const app = indexingHarness(h, { settled });
    h.rows.delete('new');
    vm.runInContext('sessionMap.delete("new");', h.ctx);
    h.ctx._startupResumeResolutions = new Map();
    await h.restore();
    assert.deepEqual(h.spawned.map(call => call.id), ['other']);
    await app.markRestoreIndexingDone();
    await h.app.persistWorkingSet();
    assert.deepEqual(h.spawned.map(call => call.id), ['other', 'new']);
    assert.equal(vm.runInContext('activeSessionId', h.ctx), 'new');
    assert.deepEqual(h.settings().openWorkingSet.map(item => item.sessionId).sort(), ['new', 'other']);
    assert.equal(h.settings().openWorkingSet.find(item => item.sessionId === 'new').active, true);
    assert.deepEqual(h.prompts, []);
    await app.markRestoreIndexingDone();
    assert.equal(h.spawned.length, 2, 'a second completion does not spawn twice');
  });
}

test('R4 R2 an unindexed target notice says waiting for indexing', { timeout: 9000 }, async t => {
  const h = setup(t, { old: ['new'], new: [] });
  h.rows.delete('new');
  await h.restore();
  assert.match(h.dom.window.notice, /waiting for indexing/i);
  assert.doesNotMatch(h.dom.window.notice, /choose/i);
});

test('R4 R2 indexing completion during a continuation lookup still retries', { timeout: 9000 }, async t => {
  const h = setup(t, { old: ['new'], new: [] });
  const app = indexingHarness(h);
  h.rows.delete('new');
  vm.runInContext('sessionMap.delete("new");', h.ctx);
  const original = h.ctx.api.getSessionContinuations;
  let ready, release;
  const resolved = new Promise(resolve => { ready = resolve; });
  const paused = new Promise(resolve => { release = resolve; });
  let first = true;
  h.ctx.api.getSessionContinuations = async id => {
    const result = await original(id);
    if (first) {
      first = false;
      ready();
      await paused;
    }
    return result;
  };
  const restoring = h.restore();
  await resolved;
  await app.markRestoreIndexingDone();
  release();
  await restoring;
  assert.deepEqual(h.spawned.map(call => call.id), ['new']);
  assert.deepEqual(h.prompts, []);
});

test('R4 R2 ambiguous continuations still ask for a sidebar choice after indexing', { timeout: 9000 }, async t => {
  const h = setup(t, { old: ['a', 'b'], a: [], b: [] });
  const app = indexingHarness(h);
  await h.restore();
  await app.markRestoreIndexingDone();
  assert.deepEqual(h.spawned, []);
  assert.deepEqual(h.prompts, []);
  assert.match(h.dom.window.notice, /sidebar.*choose/i);
  assert.doesNotMatch(h.dom.window.notice, /waiting for indexing/i);
});

test('R4 R2 a manual open cancels automatic continuation retry', { timeout: 9000 }, async t => {
  const h = setup(t, { old: ['new'], new: [], other: [] });
  const app = indexingHarness(h);
  h.rows.delete('new');
  await h.restore();
  vm.runInContext('restoringWorkingSet = false;', h.ctx);
  await h.app.openSession(h.rows.get('other'));
  await app.markRestoreIndexingDone();
  assert.deepEqual(h.spawned.map(call => call.id), ['other']);
});

test('R4 R2 remembered automatic open does not cancel the indexing retry', { timeout: 9000 }, async t => {
  const h = setup(t, { old: ['new'], new: [] });
  const app = indexingHarness(h);
  h.rows.delete('new');
  vm.runInContext('sessionMap.delete("new"); activeSessionId = "old"; restoringWorkingSet = false;', h.ctx);
  h.ctx.restoreWorkingSet = async () => {
    vm.runInContext('restoringWorkingSet = true;', h.ctx);
    await h.restore();
    vm.runInContext('restoringWorkingSet = false;', h.ctx);
  };
  h.ctx.restoreAgentsViewAtStartup = () => {};
  const startup = loadAppFunctions(h.ctx, { functions: ['restoreStartupSessions'] });
  await startup.restoreStartupSessions();
  await app.markRestoreIndexingDone();
  assert.deepEqual(h.spawned.map(call => call.id), ['new']);
  assert.deepEqual(h.prompts, []);
});

test('R4 R1 a fresh format-2 false hold is rebuilt rather than reused', { timeout: 9000 }, async t => {
  const h = setup(t, { old: [] });
  const file = path.join(h.root, h.folder, 'old.jsonl');
  fs.appendFileSync(file, '{"type":"assistant","message":"continued-in",broken}\n');
  const stat = fs.statSync(file);
  h.db.setCachedContinuationIndex('old', JSON.stringify({ format: 2, complete: true, bytes: stat.size,
    mtime: stat.mtime.toISOString(), ids: [], unresolved: true }));
  await h.restore();
  assert.deepEqual(h.spawned.map(call => call.id), ['old']);
});

test('R4 R3 shipped continuation IPC keeps a live missing sibling', { timeout: 9000 }, async t => {
  const h = setup(t, { old: ['new', 'fresh'], new: [] });
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = source.indexOf("ipcMain.handle('session-continuations'");
  const end = source.indexOf("ipcMain.handle('sessions-live-elsewhere'", start);
  assert.ok(start >= 0 && end > start);
  let handler;
  const lookups = [];
  const hasPty = () => false, pids = () => [];
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (_, callback) => { handler = callback; } },
    sessionCache: cache,
    cliSessionState: { liveElsewhereChecked: async (id, own, ownPids) => {
      lookups.push(id);
      assert.equal(own, hasPty);
      assert.equal(ownPids, pids);
      return { known: true, live: id === 'fresh' ? { kind: 'bg', jobId: '1234abcd', pid: 7 } : null };
    } },
    sessionHasPty: hasPty, ptyPids: pids,
  });
  const result = await handler(null, 'old');
  assert.deepEqual(result.candidates.map(candidate => candidate.sessionId), ['new', 'fresh']);
  assert.deepEqual(lookups, ['fresh']);
});

test('R4 R3 live missing target with an indexed sibling remains ambiguous', { timeout: 9000 }, async t => {
  const h = setup(t, { old: ['new', 'fresh'], new: [] }, { live: { fresh: { kind: 'bg', jobId: '1234abcd', pid: 7 } } });
  const result = await h.ctx.api.getSessionContinuations('old');
  assert.deepEqual(result.candidates.map(candidate => candidate.sessionId), ['new', 'fresh']);
  assert.equal(result.unresolved, false);
  await h.restore();
  assert.deepEqual(h.spawned, []);
  assert.deepEqual(h.prompts, []);
});

test('R4 R3 a live missing background target uses attach when manually chosen', { timeout: 9000 }, async t => {
  const h = setup(t, { old: ['new', 'fresh'], new: [] }, {
    live: { fresh: { kind: 'bg', jobId: '1234abcd', pid: 7 } },
    answer: message => /Open fresh\?/.test(message),
  });
  await h.click();
  assert.deepEqual(h.spawned.map(call => call.id), ['fresh']);
  assert.equal(h.spawned[0].options.type, 'attach');
  assert.equal(h.spawned[0].options.jobId, '1234abcd');
  assert.equal(h.settings().openWorkingSet[0].sessionId, 'fresh');
});

for (const kind of ['bg', 'interactive', 'schedule']) {
  test(`R4 R3 lone live missing ${kind} target follows the automatic live guard`, { timeout: 9000 }, async t => {
    const h = setup(t, { old: ['fresh'] }, { live: { fresh: { kind, jobId: '1234abcd', pid: 7 } } });
    await h.restore();
    assert.deepEqual(h.spawned.map(call => call.id), kind === 'bg' ? ['fresh'] : []);
    if (kind === 'bg') assert.equal(h.spawned[0].options.type, 'attach');
    else assert.match(h.dom.window.notice, /pid 7/);
    assert.deepEqual(h.prompts, []);
    assert.equal(h.settings().openWorkingSet[0].sessionId, 'fresh');
  });
}

test('R4 R3 failed live lookup cannot discard a missing target', { timeout: 9000 }, async t => {
  const h = setup(t, { old: ['new', 'fresh'], new: [] });
  const result = await cache.resolveSessionContinuations('old', {
    getSessionLiveElsewhere: async () => ({ known: false, reason: 'descriptor unavailable' }),
  });
  assert.equal(result.unresolved, true);
});
