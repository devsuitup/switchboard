'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setup } = require('./continuations-harness');
const { loadAppFunctions } = require('./app-source');
const { readSessionFile } = require('../read-session-file');
const { scanContinuationIndex } = require('../session-continuations');
const cache = require('../session-cache');
const cliSessionState = require('../cli-session-state');

test('R5 m1 shipped IPC cannot discard a missing target when descriptor directory is unreadable', { timeout: 9000 }, async t => {
  const h = setup(t, { old: ['new', 'fresh'], new: [] });
  const descriptors = path.join(h.root, 'descriptors');
  fs.writeFileSync(descriptors, 'not a directory');
  cliSessionState.init({ dir: descriptors, activeSessions: new Map(), onIdle() {} });
  t.after(() => cliSessionState.stop());
  assert.equal((await cliSessionState.liveElsewhereChecked('fresh', () => false)).known, false);
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = source.indexOf("ipcMain.handle('session-continuations'");
  const end = source.indexOf("ipcMain.handle('sessions-live-elsewhere'", start);
  assert.ok(start >= 0 && end > start);
  let handler;
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (_, callback) => { handler = callback; } },
    sessionCache: cache, cliSessionState, sessionHasPty: () => false, ptyPids: () => [],
  });
  const result = await handler(null, 'old');
  assert.equal(result.unresolved, true, 'unreadable descriptors cannot confirm a missing sibling');
  assert.deepEqual(result.candidates.map(candidate => candidate.sessionId), ['new']);
  h.ctx.api.getSessionContinuations = id => handler(null, id);
  await h.restore();
  assert.deepEqual(h.spawned, []);
  assert.deepEqual(h.prompts, []);
  assert.equal(h.settings().openWorkingSet[0].sessionId, 'old');
});

for (const mode of ['ask', 'auto']) {
  test(`R5 M1 renderer reload with an active session cancels working-set restore (${mode})`, { timeout: 9000 }, async t => {
    const h = setup(t, { old: [], other: [] }, {
      savedEntries: [{ sessionId: 'old', active: true }, { sessionId: 'other' }],
    });
    await h.ctx.api.setSetting('global', { ...h.settings(), restoreOnStartup: mode });
    h.ctx.api.getIndexingState = async () => ({ finished: false });
    h.ctx.restoreAgentsViewAtStartup = () => {};
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/restore-plan.js'), 'utf8'), h.ctx);
    vm.runInContext('restoringWorkingSet = false; activeSessionId = "old";', h.ctx);
    const app = loadAppFunctions(h.ctx, {
      declarations: ['restoreMode'],
      functions: ['restoreStartupSessions', 'restoreWorkingSet', 'tickRestorePlanner', 'markRestoreIndexingDone', 'showColdCacheNotice', 'showNotRestoredNotice'],
    });
    await app.restoreStartupSessions();
    assert.equal(h.dom.window.document.getElementById('restore-toast'), null, 'reload must not ask to restore saved sessions');
    assert.deepEqual(h.spawned.map(call => call.id), ['old'], 'reload reopens only the remembered active session');
    assert.equal(vm.runInContext('restorePlanner.isSettled()', h.ctx), true);
    assert.deepEqual(h.prompts, []);
  });
}

for (const suffix of [
  '\n',
  JSON.stringify({ type: 'continued-in', sessionId: 'old', continuedInSessionId: 'tail' }),
  '{"type":"continued-in","sessionId":"old","continuedInSessionId":"',
  '{"type":"assistant","padding":"' + 'x'.repeat(1024 * 1024),
]) {
  const name = suffix === '\n' ? 'sealed records' : suffix.includes('"tail"') ? 'valid unterminated tail' : suffix.includes('assistant') ? 'oversized partial tail' : 'partial continuation tail';
  test(`R5 m2 full read then append scans only appended bytes (${name})`, { timeout: 9000 }, t => {
    const h = setup(t, { old: ['first'] });
    const file = path.join(h.root, h.folder, 'old.jsonl');
    fs.appendFileSync(file, suffix);
    const previous = readSessionFile(file, h.folder, h.root).continuationIndex;
    const size = fs.statSync(file).size;
    const appended = name === 'partial continuation tail' ? 'tail"}\n' : name === 'oversized partial tail' ? '"}\n' : '\n';
    fs.appendFileSync(file, appended + JSON.stringify({ type: 'continued-in', sessionId: 'old', continuedInSessionId: 'new' }) + '\n');
    const reads = [];
    const original = fs.readSync;
    fs.readSync = function (fd, buffer, offset, length, position) {
      reads.push({ position, length });
      return original.call(this, fd, buffer, offset, length, position);
    };
    let index;
    try { index = JSON.parse(scanContinuationIndex(file, 'old', previous)); }
    finally { fs.readSync = original; }
    assert.ok(reads.length >= 2);
    assert.ok(reads.every(read => read.position >= size - 64), 'only the 64-byte cursor witness and appended bytes may be read');
    assert.equal(index.bytes, fs.statSync(file).size);
    assert.equal(index.complete, true);
    assert.equal(index.unresolved, false);
    assert.deepEqual(index.ids, name.includes('tail') && !name.includes('oversized') ? ['first', 'tail', 'new'] : ['first', 'new']);
  });
}
