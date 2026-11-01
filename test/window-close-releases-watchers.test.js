'use strict';

// The window-`closed` handler is the only place the three watcher registries
// are released together. Source-text assertions are the house pattern for
// main.js handlers (see read-file-for-panel-bounds.test.js): they prove the
// teardown is written, not that Electron runs it. The viewer registry's
// closeAll() is exercised directly, because a close() that throws inside the
// handler would strand everything after it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const { createViewerWatchRegistry } = require('../viewer-file-watch');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('closing the window disposes the live transcript follower', () => {
  let close, disposed = 0;
  const start = MAIN.indexOf("mainWindow.on('closed'");
  const end = MAIN.indexOf('\n  });', start) + 6;
  vm.runInNewContext(MAIN.slice(start, end), {
    mainWindow: { on: (_name, callback) => { close = callback; } },
    activeSessions: new Map(), closedSessions: new Map(),
    changesWatchers: { closeAll() {} }, closeAllFileWatchers() {}, unsubscribeBgAgents() {},
    subagentWatchers: new Map(), transcriptFollower: { dispose() { disposed++; } },
    unsavedGuard: { committedToken: () => null, invalidate() {} }, process: { platform: 'win32' },
    mainErrorWindowReady: true, quitAttemptToken: null,
  }, { filename: path.join(__dirname, '../main.js'), lineOffset: MAIN.slice(0, start).split('\n').length - 1 });
  close();
  assert.equal(disposed, 1, 'window teardown must cancel pending live transcript work');
});

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

test('closeAllFileWatchers is declared beside the registry it drains, and drains it', () => {
  const decl = MAIN.indexOf('const fileWatchers = createViewerWatchRegistry(');
  assert.ok(decl > 0, 'fileWatchers must be declared');
  const helper = MAIN.indexOf('function closeAllFileWatchers()');
  assert.ok(helper > decl, 'the helper belongs next to the registry, not at a distance');
  assert.match(helperSource(), /fileWatchers\.closeAll\(\)/);
});

function registryWith(closers) {
  const queue = closers.slice();
  const registry = createViewerWatchRegistry({
    watchFn: () => ({ close: queue.shift() }),
    send: () => {},
    realpath: (p) => p,
    lstat: () => ({ isSymbolicLink: () => false }),
  });
  return registry;
}

test('closeAll closes every watcher and empties the registry', () => {
  const closed = [];
  const registry = registryWith([() => closed.push('/a.js'), () => closed.push('/b.js')]);
  registry.watch('/a.js');
  registry.watch('/b.js');
  registry.closeAll();

  assert.deepEqual(closed, ['/a.js', '/b.js']);
  assert.equal(registry.size(), 0, 'nothing may survive the window');
});

test('a watcher whose close() throws does not strand the rest of the teardown', () => {
  const closed = [];
  const registry = registryWith([() => { throw new Error('ENOENT'); }, () => closed.push('/b.js')]);
  registry.watch('/gone.js');
  registry.watch('/b.js');

  assert.doesNotThrow(() => registry.closeAll());
  assert.deepEqual(closed, ['/b.js']);
  assert.equal(registry.size(), 0);
});
