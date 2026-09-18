'use strict';

// The window-`closed` handler is the only place the three watcher registries
// are released together. Source-text assertions are the house pattern for
// main.js handlers (see read-file-for-panel-bounds.test.js): they prove the
// teardown is written, not that Electron runs it. The helper itself is lifted
// out of the source and exercised, because a close() that throws inside the
// handler would strand everything after it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function closedHandler() {
  const start = MAIN.indexOf("mainWindow.on('closed'");
  assert.notEqual(start, -1, "the 'closed' handler must exist");
  const end = MAIN.indexOf('\n  });', start);
  assert.notEqual(end, -1, "end of the 'closed' handler not found");
  return MAIN.slice(start, end);
}

function helperSource() {
  const start = MAIN.indexOf('function closeAllFileWatchers()');
  assert.notEqual(start, -1, 'closeAllFileWatchers must be declared');
  const end = MAIN.indexOf('\n}', start);
  assert.notEqual(end, -1, 'end of closeAllFileWatchers not found');
  return MAIN.slice(start, end + 2);
}

test('the closed handler releases all three watcher registries', () => {
  const body = closedHandler();
  assert.match(body, /changesWatchers\.closeAll\(\)/, 'the Changes panel watches');
  assert.match(body, /closeAllFileWatchers\(\)/,
    'the viewer-panel file watches — a closing window never sends unwatch-file');
  assert.match(body, /subagentWatchers\.clear\(\)/, 'the subagent transcript watches');
});

test('closeAllFileWatchers is declared beside the registry it drains', () => {
  const decl = MAIN.indexOf('const fileWatchers = new Map()');
  assert.ok(decl > 0, 'fileWatchers must be declared');
  const helper = MAIN.indexOf('function closeAllFileWatchers()');
  assert.ok(helper > decl, 'the helper belongs next to the map, not at a distance');
});

test('closeAllFileWatchers closes every watcher and empties the registry', () => {
  const closed = [];
  const fileWatchers = new Map([
    ['/a.js', { close: () => closed.push('/a.js') }],
    ['/b.js', { close: () => closed.push('/b.js') }],
  ]);
  new Function('fileWatchers', `${helperSource()}\nreturn closeAllFileWatchers();`)(fileWatchers);

  assert.deepEqual(closed, ['/a.js', '/b.js']);
  assert.equal(fileWatchers.size, 0, 'nothing may survive the window');
});

test('a watcher whose close() throws does not strand the rest of the teardown', () => {
  const closed = [];
  const fileWatchers = new Map([
    ['/gone.js', { close: () => { throw new Error('ENOENT'); } }],
    ['/b.js', { close: () => closed.push('/b.js') }],
  ]);
  const run = new Function('fileWatchers', `${helperSource()}\nreturn closeAllFileWatchers();`);

  assert.doesNotThrow(() => run(fileWatchers));
  assert.deepEqual(closed, ['/b.js']);
  assert.equal(fileWatchers.size, 0);
});
