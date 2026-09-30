'use strict';

// The main-side rule behind every panel save: a write goes through only when
// the file on disk is exactly the content the save says it agreed to replace.
// The handlers main registers for save-file-for-panel and save-memory are the
// ones built here, called against real temp files.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { refuseIfMoved, createPanelSaveHandlers } = require('../viewer-save-guard');

const ROOT = path.join(__dirname, '..');

function tempFile(t, content, name = 'note.md') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-save-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

function handlers() {
  return createPanelSaveHandlers({
    isSensitivePath: () => false,
    resolveAllowedMemoryPath: (p) => p,
    invalidateFtsSignature: () => {},
  });
}

for (const name of ['saveFileForPanel', 'saveMemory']) {
  test(`${name}: a stale expected writes nothing, and the refusal carries the disk it compared`, (t) => {
    const file = tempFile(t, 'session\r\n');
    const result = handlers()[name](file, 'mine\n', 'one\n');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'stale');
    assert.equal(result.disk, 'session\n', 'normalised as the editor holds it');
    assert.equal(fs.readFileSync(file, 'utf8'), 'session\r\n', 'nothing written');
  });

  test(`${name}: a missing expected is refused, never a blind write`, (t) => {
    const file = tempFile(t, 'session\n');
    for (const expected of [null, undefined, 42]) {
      const result = handlers()[name](file, 'mine\n', expected);
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'invalid-expected');
    }
    assert.equal(fs.readFileSync(file, 'utf8'), 'session\n');
  });

  test(`${name}: the agreed content is replaced`, (t) => {
    const file = tempFile(t, 'a\r\nb\r\n');
    assert.deepEqual(handlers()[name](file, 'mine\n', 'a\nb\n'), { ok: true });
    assert.equal(fs.readFileSync(file, 'utf8'), 'mine\n');
  });
}

test('saveFileForPanel refuses a sensitive path before reading it', (t) => {
  const file = tempFile(t, 'x\n');
  const h = createPanelSaveHandlers({
    isSensitivePath: () => true,
    resolveAllowedMemoryPath: (p) => p,
    invalidateFtsSignature: () => {},
  });
  assert.equal(h.saveFileForPanel(file, 'y\n', 'x\n').ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), 'x\n');
});

test('refuseIfMoved: unchanged is null, moved is stale with the disk text', (t) => {
  const file = tempFile(t, 'one\n');
  assert.equal(refuseIfMoved(file, 'one\n'), null);
  fs.writeFileSync(file, 'someone else\n');
  assert.deepEqual(refuseIfMoved(file, 'one\n'), {
    ok: false, error: 'this file changed on disk since it was opened', reason: 'stale', disk: 'someone else\n',
  });
});

test('main registers the module handlers for both channels, and writes no panel file itself', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8').replace(/^[ \t]*\/\/.*$/gm, '');
  assert.match(src, /const panelSaves = createPanelSaveHandlers\(/);
  assert.match(src, /ipcMain\.handle\('save-file-for-panel', \(_event, filePath, content, expected\) => panelSaves\.saveFileForPanel\(filePath, content, expected\)\)/);
  assert.match(src, /ipcMain\.handle\('save-memory', \(_event, filePath, content, expected\) => panelSaves\.saveMemory\(filePath, content, expected\)\)/);
  const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  assert.match(preload, /ipcRenderer\.invoke\('save-memory', filePath, content, expected\)/);
  assert.match(preload, /ipcRenderer\.invoke\('save-file-for-panel', filePath, content, expected\)/);
});

// main.js cannot be required from a test, so the policy object it passes is
// lifted out of its source and evaluated against the real functions it names.
function mainPolicies({ knownRoots, invalidated }) {
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const start = src.indexOf('const panelSaves = createPanelSaveHandlers(');
  assert.notEqual(start, -1);
  const open = src.indexOf('(', start);
  const end = src.indexOf('\n});', open);
  const literal = src.slice(open + 1, end + 2);
  const validator = require('../ipc-path-validator');
  const build = new Function('createPanelSaveHandlers', 'isSensitivePath', 'resolveAllowedMemoryPath', 'invalidateFtsSignature',
    `return createPanelSaveHandlers(${literal});`);
  return build(
    createPanelSaveHandlers,
    validator.isSensitivePath,
    (literalPath) => validator.resolveAllowedMemoryPath(literalPath, knownRoots),
    (kind) => invalidated.push(kind),
  );
}

test("main's policies: a sensitive path is refused, a memory path outside the allowlist is refused, a save invalidates the FTS signature", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-save-policies-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(root, '.ssh'), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  const invalidated = [];
  const h = mainPolicies({ knownRoots: [project], invalidated });

  const key = path.join(root, '.ssh', 'id_rsa');
  fs.writeFileSync(key, 'secret\n');
  assert.equal(h.saveFileForPanel(key, 'x\n', 'secret\n').error, 'access to sensitive path denied');
  assert.equal(fs.readFileSync(key, 'utf8'), 'secret\n');

  const outside = path.join(root, 'outside.md');
  fs.writeFileSync(outside, 'o\n');
  assert.equal(h.saveMemory(outside, 'x\n', 'o\n').error, 'path not allowed');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'o\n');

  const inside = path.join(project, 'note.md');
  fs.writeFileSync(inside, 'i\n');
  assert.deepEqual(h.saveMemory(inside, 'x\n', 'i\n'), { ok: true });
  assert.deepEqual(h.saveFileForPanel(inside, 'y\n', 'x\n'), { ok: true });
  assert.deepEqual(invalidated, ['memory', 'memory']);
});

function memoryHandlers(resolve) {
  return createPanelSaveHandlers({
    isSensitivePath: () => false,
    resolveAllowedMemoryPath: resolve,
    invalidateFtsSignature: () => {},
  });
}

test('saveMemory refuses a file that is not .md, and writes nothing', (t) => {
  const file = tempFile(t, 'x\n', 'note.txt');
  assert.deepEqual(memoryHandlers((p) => p).saveMemory(file, 'y\n', 'x\n'), { ok: false, error: 'not a .md file' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'x\n');
});

test('saveMemory refuses a path the allowlist does not resolve', (t) => {
  const file = tempFile(t, 'x\n');
  assert.deepEqual(memoryHandlers(() => null).saveMemory(file, 'y\n', 'x\n'), { ok: false, error: 'path not allowed' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'x\n');
});

test('saveMemory writes the path the allowlist resolved, not the literal one', (t) => {
  const real = tempFile(t, 'x\n', 'real.md');
  const literal = path.join(path.dirname(real), 'link.md');
  assert.deepEqual(memoryHandlers(() => real).saveMemory(literal, 'y\n', 'x\n'), { ok: true });
  assert.equal(fs.readFileSync(real, 'utf8'), 'y\n');
  assert.equal(fs.existsSync(literal), false);
});

test('both handlers refuse a file that does not exist, and create nothing', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-save-missing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const missing = path.join(dir, 'gone.md');
  const h = memoryHandlers((p) => p);
  assert.deepEqual(h.saveMemory(missing, 'y\n', ''), { ok: false, error: 'file does not exist' });
  assert.deepEqual(h.saveFileForPanel(missing, 'y\n', ''), { ok: false, error: 'File does not exist' });
  assert.equal(fs.existsSync(missing), false);
});
