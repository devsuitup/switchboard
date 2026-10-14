'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function makeCtx() {
  const start = mainSrc.indexOf('const fileListStates =');
  const end = mainSrc.indexOf('function fileListsSnapshot(');
  const ctx = vm.createContext({ path, process, CLAUDE_DIR: path.resolve('test-claude'), require: require('node:module').createRequire(path.join(__dirname, '..', 'main.js')) });
  vm.runInContext(mainSrc.slice(start, end), ctx, { filename: path.join(__dirname, '..', 'main.js') });
  return ctx;
}

test('save invalidation only marks the changed file for reindexing', () => {
  const ctx = makeCtx();
  const a = JSON.stringify([JSON.stringify([1, 2, 'a.md']), 'a']);
  const b = JSON.stringify([JSON.stringify([1, 2, 'b.md']), 'b']);
  vm.runInContext(`
    const state = fileListStates.get('memory');
    state.indexed = new Map([['a.md', ${JSON.stringify(a)}], ['b.md', ${JSON.stringify(b)}]]);
    publishFileListPaths(state, state.indexed.keys());
    invalidateFtsSignature('memory', 'a.md');
  `, ctx, { filename: path.join(__dirname, '..', 'main.js') });
  assert.equal(vm.runInContext("fileListStates.get('memory').indexed.get('a.md')", ctx, { filename: path.join(__dirname, '..', 'main.js') }), null);
  assert.equal(vm.runInContext("fileListStates.get('memory').indexed.get('b.md')", ctx, { filename: path.join(__dirname, '..', 'main.js') }), b);
  assert.equal(vm.runInContext("fileListStates.get('memory').epoch", ctx), 1);
  assert.equal(vm.runInContext("fileListStates.get('work-file').epoch", ctx), 0);
});

function panelSaveHarness() {
  const { createPanelSaveHandlers } = require('../viewer-save-guard');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fts-save-'));
  const invalidated = [];
  const handlers = createPanelSaveHandlers({
    isSensitivePath: () => false,
    resolveAllowedMemoryPath: (p) => p,
    invalidateFtsSignature: (kind, filePath) => invalidated.push({ kind, filePath }),
  });
  const file = (rel) => {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'old\n');
    return f;
  };
  return { handlers, invalidated, file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('save-memory invalidates the "memory" signature after writing', () => {
  const h = panelSaveHarness();
  try {
    const f = h.file('note.md');
    assert.deepEqual(h.handlers.saveMemory(f, 'new\n', 'old\n'), { ok: true });
    assert.deepEqual(h.invalidated, [{ kind: 'memory', filePath: f }]);
  } finally { h.cleanup(); }
});

test('main.js delete-work-file handler calls invalidateFtsSignature("work-file")', () => {
  const dwfStart = mainSrc.indexOf("ipcMain.handle('delete-work-file'");
  assert.ok(dwfStart !== -1, "delete-work-file handler not found in main.js");
  const nextHandler = mainSrc.indexOf('ipcMain.handle(', dwfStart + 1);
  const handlerBody = mainSrc.slice(dwfStart, nextHandler !== -1 ? nextHandler : dwfStart + 2000);
  assert.match(
    handlerBody,
    /invalidateFtsSignature\s*\(\s*['"]work-file['"]/,
    "delete-work-file must call invalidateFtsSignature('work-file') after deletion"
  );
});

test('save-file-for-panel invalidates "work-file" for a .work-files/ path', () => {
  const h = panelSaveHarness();
  try {
    const f = h.file('.work-files/notes.txt');
    assert.deepEqual(h.handlers.saveFileForPanel(f, 'new\n', 'old\n'), { ok: true });
    assert.deepEqual(h.invalidated, [{ kind: 'work-file', filePath: f }]);
  } finally { h.cleanup(); }
});

test('save-file-for-panel invalidates "memory" for a .md path, and nothing when the write is refused', () => {
  const h = panelSaveHarness();
  try {
    const f = h.file('doc.md');
    assert.deepEqual(h.handlers.saveFileForPanel(f, 'new\n', 'old\n'), { ok: true });
    assert.deepEqual(h.invalidated, [{ kind: 'memory', filePath: f }]);
    assert.equal(h.handlers.saveFileForPanel(f, 'again\n', 'old\n').reason, 'stale');
    assert.deepEqual(h.invalidated, [{ kind: 'memory', filePath: f }], 'a refused save wrote nothing to reindex');
  } finally { h.cleanup(); }
});

test('save-file-for-panel recognises a .work-files directory whatever the path separator', () => {
  const { createPanelSaveHandlers } = require('../viewer-save-guard');
  const invalidated = [];
  const h = createPanelSaveHandlers({
    isSensitivePath: () => false,
    resolveAllowedMemoryPath: (p) => p,
    invalidateFtsSignature: (kind) => invalidated.push(kind),
    existsSync: () => true,
    readFile: () => 'old\n',
    writeFile: () => {},
  });
  assert.deepEqual(h.saveFileForPanel('C:\\repo\\.work-files\\notes.txt', 'new\n', 'old\n'), { ok: true });
  assert.deepEqual(invalidated, ['work-file'], 'a Windows path under .work-files is a work file too');
});
