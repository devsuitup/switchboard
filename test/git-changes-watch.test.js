'use strict';

// The main-side half of the Changes panel's file watch: the registry that
// arms fs.watch, debounces its events, re-arms after the inode is replaced,
// and reports the repo-relative path back to the renderer. The registry is
// its own module for the same reason git-changes-target.js is — main.js
// cannot be required from a test, so the logic does not live there.

const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const path = require('node:path');

const { createChangesWatchRegistry } = require('../git-changes-watch');

const ROOT = path.join(__dirname, '..');

// main.js cannot be required from a test — it pulls in electron — so the wiring
// between this registry and the IPC handlers is asserted against its source.
// Commented-out lines are dropped first, so a call that has been commented out
// cannot satisfy an assertion that it is made. This catches deletion, which is
// the regression that happens; it cannot catch a call left in place but made
// unreachable. Only whole-line comments are removed: `/*` also appears inside
// string literals in main.js, and a block-comment stripper eats them.
function sourceOf(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

// A stand-in for fs.watch plus the timer, so events and debounce are driven
// by the test rather than by the clock.
function harness({ failOn } = {}) {
  const watches = [];
  const sent = [];
  const timers = [];

  const registry = createChangesWatchRegistry({
    watchFn: (filePath, handler) => {
      if (failOn && failOn(filePath, watches.length)) throw new Error('ENOENT');
      const entry = { filePath, handler, closed: false };
      watches.push(entry);
      return { close() { entry.closed = true; } };
    },
    send: (sessionId, relPath) => sent.push({ sessionId, relPath }),
    scheduler: {
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      clearTimeout: (id) => { if (id) timers[id - 1] = null; },
    },
  });

  return {
    registry,
    watches,
    sent,
    live: () => watches.filter((w) => !w.closed),
    fire: (eventType, index = watches.length - 1) => watches[index].handler(eventType),
    settle: () => {
      const pending = timers.slice();
      timers.length = 0;
      for (const fn of pending) if (fn) fn();
    },
  };
}

test('a change event reports the session and the repo-relative path, never the resolved one (mutation target: the watch registration)', () => {
  const h = harness();
  assert.deepEqual(h.registry.watch('s1', 'src/a.js', '/repo/src/a.js'), { ok: true });
  assert.equal(h.watches.length, 1);
  assert.equal(h.watches[0].filePath, '/repo/src/a.js', 'fs.watch gets the resolved path');

  h.fire('change');
  h.settle();
  assert.deepEqual(h.sent, [{ sessionId: 's1', relPath: 'src/a.js' }],
    'the renderer gets the path it already has, and no absolute path crosses the boundary');
});

test('bursts of events collapse into one notification', () => {
  const h = harness();
  h.registry.watch('s1', 'src/a.js', '/repo/src/a.js');

  h.fire('change');
  h.fire('change');
  h.fire('change');
  h.settle();

  assert.equal(h.sent.length, 1);
});

test('a rename-based replacement re-arms the watch, so the write after it is still seen (mutation target: the re-arm)', () => {
  const h = harness();
  h.registry.watch('s1', 'src/a.js', '/repo/src/a.js');
  const first = h.watches[0];

  // An atomic replace: git checkout, sed -i, an editor saving via rename.
  h.fire('rename');
  h.settle();
  assert.equal(h.sent.length, 1, 'the replacement itself is reported');
  assert.equal(first.closed, true, 'the watch bound to the old inode is dropped');
  assert.equal(h.watches.length, 2, 'and a new one is armed on the same path');
  assert.equal(h.watches[1].filePath, '/repo/src/a.js');

  h.fire('change');
  h.settle();
  assert.equal(h.sent.length, 2, 'a write after the replacement is still reported');
});

test('unwatch stops the watch and any notification still in flight', () => {
  const h = harness();
  h.registry.watch('s1', 'src/a.js', '/repo/src/a.js');

  h.fire('change');
  h.registry.unwatch('s1', 'src/a.js');
  h.settle();

  assert.equal(h.live().length, 0);
  assert.deepEqual(h.sent, [], 'a pending debounce must not outlive the watch');
  assert.equal(h.registry.size(), 0);
});

test('watching the same file again replaces the previous watch instead of stacking', () => {
  const h = harness();
  h.registry.watch('s1', 'src/a.js', '/repo/src/a.js');
  h.registry.watch('s1', 'src/a.js', '/repo/src/a.js');

  assert.equal(h.registry.size(), 1);
  assert.equal(h.live().length, 1);

  h.fire('change');
  h.settle();
  assert.equal(h.sent.length, 1, 'one event, one notification');
});

test('two sessions watching the same relative path are independent', () => {
  const h = harness();
  h.registry.watch('s1', 'src/a.js', '/repo-a/src/a.js');
  h.registry.watch('s2', 'src/a.js', '/repo-b/src/a.js');
  assert.equal(h.registry.size(), 2);

  h.fire('change', 0);
  h.settle();
  assert.deepEqual(h.sent, [{ sessionId: 's1', relPath: 'src/a.js' }]);

  h.registry.unwatch('s1', 'src/a.js');
  h.fire('change', 1);
  h.settle();
  assert.deepEqual(h.sent[1], { sessionId: 's2', relPath: 'src/a.js' });
});

test('a notification whose entry is gone is dropped, even if its timer still fires', () => {
  const captured = [];
  const watches = [];
  const sent = [];
  const registry = createChangesWatchRegistry({
    watchFn: (filePath, handler) => {
      const entry = { filePath, handler, closed: false };
      watches.push(entry);
      return { close() { entry.closed = true; } };
    },
    send: (sessionId, relPath) => sent.push({ sessionId, relPath }),
    // A scheduler that hands the callback out and ignores clearTimeout, which
    // is the race a real timer can lose.
    scheduler: { setTimeout: (fn) => { captured.push(fn); return captured.length; }, clearTimeout: () => {} },
  });

  registry.watch('s1', 'src/a.js', '/repo/src/a.js');
  watches[0].handler('change');
  registry.unwatch('s1', 'src/a.js');
  captured[captured.length - 1]();
  assert.deepEqual(sent, [], 'the file is not open any more; nothing may be reported for it');

  registry.watch('s1', 'src/a.js', '/repo/src/a.js');
  watches[1].handler('change');
  const stale = captured[captured.length - 1];
  registry.watch('s1', 'src/a.js', '/repo/src/a.js');
  stale();
  assert.deepEqual(sent, [], 'and neither may a timer belonging to a replaced entry');
});

test('a file that cannot be watched is reported, not thrown', () => {
  const h = harness({ failOn: () => true });
  const result = h.registry.watch('s1', 'gone.js', '/repo/gone.js');
  assert.equal(result.ok, false);
  assert.equal(h.registry.size(), 0, 'a failed arm leaves nothing behind');
});

test('closeAll drops every watch', () => {
  const h = harness();
  h.registry.watch('s1', 'a.js', '/repo/a.js');
  h.registry.watch('s2', 'b.js', '/repo/b.js');

  h.registry.closeAll();
  assert.equal(h.registry.size(), 0);
  assert.equal(h.live().length, 0);
});

// --- The wiring in main.js, which no unit test can reach -----------------

test('main.js arms the registry with fs.watch and answers both IPCs with it (mutation target: the wiring)', () => {
  const main = sourceOf('main.js');
  const preload = sourceOf('preload.js');

  const start = main.indexOf('const changesWatchers = createChangesWatchRegistry');
  assert.ok(start > 0, 'the registry is what main.js uses, not an inline Map of watchers');
  const wiring = main.slice(start, main.indexOf('\n});', start));
  assert.match(wiring, /watchFn:\s*\(filePath, handler\) => fs\.watch\(filePath, handler\)/,
    'the registry must be armed with the real fs.watch');
  assert.match(wiring, /send:[\s\S]*?webContents\.send\('git-changes-file-changed', sessionId, relPath\)/,
    'and report through the channel the renderer subscribes to');

  const watchHandler = main.slice(main.indexOf("ipcMain.handle('git-changes-watch'"));
  const watchBody = watchHandler.slice(0, watchHandler.indexOf('\n});'));
  assert.match(watchBody, /requireLocalTarget/, 'a remote session has no file to watch here');
  assert.match(watchBody, /resolveTargetInsideRepo/, 'the watch goes through the same guard as the read');
  assert.match(watchBody, /if \(!resolved\.ok\) return resolved;/,
    'a refused path must come back with the guard\'s own reason, not as a failed fs.watch');
  assert.match(watchBody, /changesWatchers\.watch\(sessionId, filePath, resolved\.path\)/);

  const unwatchHandler = main.slice(main.indexOf("ipcMain.handle('git-changes-unwatch'"));
  assert.match(unwatchHandler.slice(0, unwatchHandler.indexOf('\n});')), /changesWatchers\.unwatch\(sessionId, filePath\)/);

  assert.match(preload, /gitChangesWatch: \(sessionId, filePath\) => ipcRenderer\.invoke\('git-changes-watch', sessionId, filePath\)/);
  assert.match(preload, /onGitChangesFileChanged/);

  const closedHandler = main.slice(main.indexOf("mainWindow.on('closed'"));
  assert.match(closedHandler.slice(0, closedHandler.indexOf('\n  });')), /changesWatchers\.closeAll\(\)/,
    'the watches must not outlive the window that asked for them');
});
