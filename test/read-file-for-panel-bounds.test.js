'use strict';

// read-file-for-panel accepts an arbitrary path on purpose: a file link in
// terminal output decides it. isSensitivePath says which paths are refused;
// nothing said how big a file could be, while the neighbouring read-work-file
// has capped at 2 MB all along. See .ai/contexts/viewer-panel.md, "Bounds".
//
// These are source-text assertions, the house pattern for main.js IPC handlers
// (see delete-session.test.js): they prove the guard is written, not that it
// runs. The behavioural equivalent would need an Electron host.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function handlerBody(name) {
  const start = MAIN.indexOf(`ipcMain.handle('${name}'`);
  assert.notEqual(start, -1, `handler ${name} not found`);
  const end = MAIN.indexOf('\n});', start);
  assert.notEqual(end, -1, `end of handler ${name} not found`);
  return MAIN.slice(start, end);
}

test('read-file-for-panel refuses a file above the panel ceiling', () => {
  const body = handlerBody('read-file-for-panel');
  assert.match(body, /statSync/, 'the size must be read before the file is');
  assert.match(body, /PANEL_FILE_MAX_BYTES/, 'the ceiling must gate the read');
  assert.match(body, /too large/i, 'the refusal must say why');
});

test('read-file-for-panel refuses a binary file', () => {
  assert.match(handlerBody('read-file-for-panel'), /includes\(0\)/);
});

test('the panel ceiling is declared and is not unbounded', () => {
  const m = MAIN.match(/const PANEL_FILE_MAX_BYTES = ([^;]+);/);
  assert.ok(m, 'PANEL_FILE_MAX_BYTES must be declared');
  // eslint-disable-next-line no-eval
  const value = eval(m[1]);
  assert.ok(Number.isFinite(value) && value > 0, 'the ceiling must be a finite positive size');
});

test('the sensitive-path check still runs before anything is read', () => {
  const body = handlerBody('read-file-for-panel');
  assert.ok(
    body.indexOf('isSensitivePath') < body.indexOf('statSync'),
    'the path must be refused before its size is even asked for',
  );
});
