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

const { watchFileForViewer } = require('../viewer-file-watch');

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

test('main.js arms the viewer watch through watchFileForViewer', () => {
  const src = sourceOf('main.js');
  const start = src.indexOf("ipcMain.handle('watch-file'");
  assert.notEqual(start, -1);
  const body = src.slice(start, src.indexOf("ipcMain.handle('unwatch-file'", start));
  assert.match(body, /watchFileForViewer\(resolved/);
  assert.doesNotMatch(body, /eventType !== 'change'/, 'a rename must not be discarded');
});
