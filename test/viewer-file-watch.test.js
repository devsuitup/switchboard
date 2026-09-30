'use strict';

// The main-side watch behind a ViewerPanel, against a real temp file and the
// real fs.watch: a write, an atomic replace (write a temp file, rename it over
// the original, as `sed -i` and `git checkout` do), a write after that, a
// delete and a recreate must each be reported.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { watchFileForViewer, createViewerWatchRegistry, sameFileName, watchTargets } = require('../viewer-file-watch');

const ROOT = path.join(__dirname, '..');
const DEBOUNCE_MS = 40;

function sourceOf(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/^[ \t]*\/\/.*$/gm, '');
}

function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-watch-'));
  const file = path.join(dir, 'note.md');
  fs.writeFileSync(file, 'one\n');
  let count = 0;
  let waiters = [];
  const watcher = watchFileForViewer(file, {
    debounceMs: DEBOUNCE_MS,
    send: () => {
      count += 1;
      const ready = waiters;
      waiters = [];
      for (const w of ready) w();
    },
  });
  t.after(() => {
    watcher.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  return {
    dir,
    file,
    count: () => count,
    // Resolves on the next report, or rejects after `ms` without one.
    nextReport(ms = 2000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no file-changed report')), ms);
        waiters.push(() => { clearTimeout(timer); resolve(); });
      });
    },
  };
}

function settle(ms = DEBOUNCE_MS * 4) {
  return new Promise((r) => setTimeout(r, ms));
}

test('a write to the file is reported', async (t) => {
  const h = harness(t);
  const report = h.nextReport();
  fs.writeFileSync(h.file, 'two\n');
  await report;
});

test('a file replaced by rename still reports its next change', async (t) => {
  const h = harness(t);
  const replaced = h.nextReport();
  const tmp = path.join(h.dir, '.note.md.tmp');
  fs.writeFileSync(tmp, 'replaced\n');
  fs.renameSync(tmp, h.file);
  await replaced;
  await settle();

  const written = h.nextReport();
  fs.writeFileSync(h.file, 'after the replace\n');
  await written;
});

test('a deleted file is reported, and so is its recreation', async (t) => {
  const h = harness(t);
  const deleted = h.nextReport();
  fs.unlinkSync(h.file);
  await deleted;
  await settle();

  const recreated = h.nextReport();
  fs.writeFileSync(h.file, 'back\n');
  await recreated;
  await settle();

  const written = h.nextReport();
  fs.writeFileSync(h.file, 'written again\n');
  await written;
});

test('another file in the same directory is not reported', async (t) => {
  const h = harness(t);
  await settle();
  const before = h.count();
  fs.writeFileSync(path.join(h.dir, 'other.md'), 'x\n');
  await settle(DEBOUNCE_MS * 6);
  assert.equal(h.count(), before);
});

test('a burst of events is debounced into one report', async (t) => {
  const h = harness(t);
  await settle();
  const before = h.count();
  for (let i = 0; i < 5; i += 1) fs.writeFileSync(h.file, `v${i}\n`);
  await settle(DEBOUNCE_MS * 6);
  assert.equal(h.count() - before, 1);
});

test('nothing is reported after close', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-watch-closed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'a.md');
  fs.writeFileSync(file, 'a\n');
  let sent = 0;
  const w = watchFileForViewer(file, { debounceMs: DEBOUNCE_MS, send: () => { sent += 1; } });
  w.close();
  fs.writeFileSync(file, 'b\n');
  await settle(DEBOUNCE_MS * 6);
  assert.equal(sent, 0);
});

test('a symlinked file is watched in the directory of its target', async (t) => {
  const h = harness(t);
  const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-watch-link-'));
  t.after(() => fs.rmSync(linkDir, { recursive: true, force: true }));
  const link = path.join(linkDir, 'CLAUDE.md');
  fs.symlinkSync(h.file, link);
  let resolveReport;
  const report = new Promise((r) => { resolveReport = r; });
  const w = watchFileForViewer(link, { debounceMs: DEBOUNCE_MS, send: () => resolveReport() });
  t.after(() => w.close());
  const timer = setTimeout(() => resolveReport('timeout'), 2000);
  fs.writeFileSync(h.file, 'through the link\n');
  const outcome = await report;
  clearTimeout(timer);
  assert.notEqual(outcome, 'timeout', 'a write to the target must reach a watch set on the link');
});

test('a symlink replaced by a regular file is still heard, and so is the next write', async (t) => {
  const h = harness(t);
  const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-watch-link-'));
  t.after(() => fs.rmSync(linkDir, { recursive: true, force: true }));
  const link = path.join(linkDir, 'CLAUDE.md');
  fs.symlinkSync(h.file, link);
  let sent = 0;
  let wake = null;
  const w = watchFileForViewer(link, { debounceMs: DEBOUNCE_MS, send: () => { sent += 1; if (wake) wake(); } });
  t.after(() => w.close());
  const next = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no report')), 2000);
    wake = () => { clearTimeout(timer); wake = null; resolve(); };
  });

  let report = next();
  const tmp = path.join(linkDir, '.CLAUDE.md.tmp');
  fs.writeFileSync(tmp, 'a regular file now\n');
  fs.renameSync(tmp, link);
  await report;
  assert.equal(fs.lstatSync(link).isSymbolicLink(), false);
  await settle();

  report = next();
  fs.writeFileSync(link, 'written after the replace\n');
  await report;
  assert.ok(sent >= 2);
});

// Deterministic: events and timers driven by the test, as git-changes-watch.test.js does.
function fakeWatch({ platform = 'linux', realpath = (p) => p, symlink = false } = {}) {
  const watches = [];
  const timers = [];
  let sent = 0;
  const deps = {
    watchFn: (dir, handler) => {
      const entry = { dir, handler, closed: false };
      watches.push(entry);
      return { close() { entry.closed = true; } };
    },
    send: () => { sent += 1; },
    scheduler: {
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      clearTimeout: (id) => { if (id) timers[id - 1] = null; },
    },
    platform,
    realpath,
    lstat: () => ({ isSymbolicLink: () => symlink }),
  };
  return {
    deps,
    watches,
    sent: () => sent,
    fire: (filename, index = 0) => watches[index].handler('change', filename),
    settle: () => { const pending = timers.slice(); timers.length = 0; for (const fn of pending) if (fn) fn(); },
  };
}

test('a burst of events is debounced into one report (driven timers)', () => {
  const f = fakeWatch();
  watchFileForViewer('/d/note.md', f.deps);
  f.fire('note.md');
  f.fire('note.md');
  f.fire('note.md');
  f.settle();
  assert.equal(f.sent(), 1, 'each event must cancel the timer the previous one armed');
});

test('an event for another name is dropped, an event with no name is reported', () => {
  const f = fakeWatch();
  watchFileForViewer('/d/note.md', f.deps);
  f.fire('other.md');
  f.settle();
  assert.equal(f.sent(), 0);
  f.fire(null);
  f.settle();
  assert.equal(f.sent(), 1);
});

test('sameFileName folds case on win32 and darwin only', () => {
  assert.equal(sameFileName('CLAUDE.md', 'claude.md', 'win32'), true);
  assert.equal(sameFileName('CLAUDE.md', 'claude.md', 'darwin'), true);
  assert.equal(sameFileName('CLAUDE.md', 'claude.md', 'linux'), false);
  assert.equal(sameFileName('CLAUDE.md', 'CLAUDE.md', 'linux'), true);
});

test('on win32 an event whose name differs only in case is reported; on linux it is not', () => {
  const f = fakeWatch({ platform: 'win32' });
  watchFileForViewer('/u/.claude/claude.md', f.deps);
  f.fire('CLAUDE.md');
  f.settle();
  assert.equal(f.sent(), 1);

  const linux = fakeWatch({ platform: 'linux' });
  watchFileForViewer('/u/.claude/claude.md', linux.deps);
  linux.fire('CLAUDE.md');
  linux.settle();
  assert.equal(linux.sent(), 0, 'a case-sensitive filesystem has two different files');
});

test('the watched name comes from the real path, so it carries the on-disk case', () => {
  const targets = watchTargets('/d/claude.md', { realpath: () => '/d/CLAUDE.md', lstat: () => ({ isSymbolicLink: () => false }) });
  assert.deepEqual(targets, [{ dir: '/d', name: 'CLAUDE.md' }]);
});

test('a symlink is watched at its target and at the link itself', () => {
  const f = fakeWatch({ realpath: () => '/repo/claude/CLAUDE.md', symlink: true });
  watchFileForViewer('/home/u/.claude/CLAUDE.md', f.deps);
  assert.deepEqual(f.watches.map((w) => w.dir), ['/repo/claude', '/home/u/.claude']);
  f.fire('CLAUDE.md', 1);
  f.settle();
  assert.equal(f.sent(), 1, 'an event on the link entry is reported');
});

test('two panels on one file share one watch, and closing one does not deafen the other', () => {
  const f = fakeWatch();
  const sentPaths = [];
  const registry = createViewerWatchRegistry({ ...f.deps, send: (p) => sentPaths.push(p) });
  registry.watch('/d/CLAUDE.md');
  registry.watch('/d/CLAUDE.md');
  assert.equal(f.watches.length, 1, 'one directory watch for both panels');

  registry.unwatch('/d/CLAUDE.md');
  assert.equal(f.watches[0].closed, false, 'the other panel still watches');
  f.fire('CLAUDE.md');
  f.settle();
  assert.deepEqual(sentPaths, ['/d/CLAUDE.md']);

  registry.unwatch('/d/CLAUDE.md');
  assert.equal(f.watches[0].closed, true, 'the last unwatch closes it');
  assert.equal(registry.size(), 0);
  registry.unwatch('/d/CLAUDE.md');
  assert.equal(registry.size(), 0, 'an extra unwatch is harmless');
});

test('main.js routes watch-file and unwatch-file through the ref-counted registry', () => {
  const src = sourceOf('main.js');
  const start = src.indexOf("ipcMain.handle('watch-file'");
  assert.notEqual(start, -1);
  const end = src.indexOf('\n});', src.indexOf("ipcMain.handle('unwatch-file'", start));
  const body = src.slice(start, end);
  assert.match(body, /fileWatchers\.watch\(resolved\)/);
  assert.match(body, /fileWatchers\.unwatch\(path\.resolve\(filePath\)\)/);
  assert.doesNotMatch(body, /eventType !== 'change'/, 'a rename must not be discarded');
  assert.match(src, /const fileWatchers = createViewerWatchRegistry\(/);
});
