'use strict';

// The main-side half of a ViewerPanel save: the write is refused when the
// file on disk is no longer the content the panel last read, unless the
// panel asks to overwrite (no expected content).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { refuseIfMoved } = require('../viewer-save-guard');

const ROOT = path.join(__dirname, '..');

function tempFile(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-save-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'note.md');
  fs.writeFileSync(file, content);
  return file;
}

test('a file unchanged since it was read may be written', (t) => {
  const file = tempFile(t, 'one\n');
  assert.equal(refuseIfMoved(file, 'one\n'), null);
});

test('a file written in the meantime is refused as stale', (t) => {
  const file = tempFile(t, 'one\n');
  fs.writeFileSync(file, 'someone else\n');
  const refusal = refuseIfMoved(file, 'one\n');
  assert.equal(refusal.ok, false);
  assert.equal(refusal.reason, 'stale');
  assert.match(refusal.error, /changed on disk since it was opened/);
});

test('an overwrite (no expected content) is never refused', (t) => {
  const file = tempFile(t, 'someone else\n');
  assert.equal(refuseIfMoved(file, null), null);
  assert.equal(refuseIfMoved(file, undefined), null);
});

test('a CRLF file matches the LF baseline the editor holds', (t) => {
  const file = tempFile(t, 'a\r\nb\r\n');
  assert.equal(refuseIfMoved(file, 'a\nb\n'), null);
});

test('an expected value that is not a string is refused', (t) => {
  const file = tempFile(t, 'one\n');
  assert.equal(refuseIfMoved(file, 42).reason, 'invalid-expected');
});

function handlerBody(src, channel) {
  const start = src.indexOf(`ipcMain.handle('${channel}'`);
  assert.notEqual(start, -1, `${channel} must exist`);
  return src.slice(start, src.indexOf('\n});', start));
}

test('both viewer save handlers check before they write', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8').replace(/^[ \t]*\/\/.*$/gm, '');
  for (const channel of ['save-file-for-panel', 'save-memory']) {
    const body = handlerBody(src, channel);
    const check = body.indexOf('refuseIfMoved(resolved, expected)');
    const write = body.indexOf('fs.writeFileSync(resolved');
    assert.ok(check > 0, `${channel} must call refuseIfMoved`);
    assert.ok(write > check, `${channel} must check before writing`);
    assert.match(body, /\(_event, filePath, content, expected\)/);
  }
  const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  assert.match(preload, /ipcRenderer\.invoke\('save-memory', filePath, content, expected\)/);
  assert.match(preload, /ipcRenderer\.invoke\('save-file-for-panel', filePath, content, expected\)/);
});
