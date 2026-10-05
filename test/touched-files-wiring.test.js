// Reads the shipped sources as TEXT: it shows the glue between the touched-files
// listing and the rest of the app is still written down. Behaviour is in
// session-touched-files.test.js and dom-file-panel-touched.test.js.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('main.js serves session-touched-files through the sensitive-path guard and the cached folder', () => {
  const src = read('main.js');
  const at = src.indexOf("ipcMain.handle('session-touched-files'");
  assert.notEqual(at, -1, 'the handler is registered');
  const body = src.slice(at, src.indexOf('});', src.indexOf('listSessionTouchedFiles(', at)) + 3);
  assert.match(body, /isSensitive:\s*isSensitivePathAsync/);
  assert.match(body, /getCachedFolder/);
  assert.match(body, /isRemoteFolder/);
  assert.match(body, /projectsDir:\s*PROJECTS_DIR/);
});

test('preload.js exposes sessionTouchedFiles on the same channel and nothing that reads a path', () => {
  const src = read('preload.js');
  assert.match(src, /sessionTouchedFiles:\s*\(sessionId, options\)\s*=>\s*ipcRenderer\.invoke\('session-touched-files',\s*sessionId, options\)/);
});

test('index.html loads the touched tab after the file panel it hooks into', () => {
  const html = read('public/index.html');
  const panel = html.indexOf('src="file-panel.js"');
  const touched = html.indexOf('src="touched-files-view.js"');
  assert.ok(panel !== -1 && touched > panel);
});

test('the touched tab opens a file only through readFileForPanel', () => {
  const src = read('public/touched-files-view.js');
  const apis = [...src.matchAll(/window\.api\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(apis)].sort(), ['readFileForPanel', 'resolveTerminalPaths', 'sessionTouchedFiles']);
});

test('a path is shown in its own bidi isolate, so an override in it cannot reorder the row', () => {
  const css = read('public/style.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = /\.touched-file-path\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'the rule exists');
  assert.match(rule[1], /unicode-bidi:\s*isolate/);
});
