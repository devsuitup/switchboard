// test/scan-md-files.test.js — unit tests for the Memory/brain tab's directory
// scan.
//
// The regression this pins: a `schedule-*.md` (or `CLAUDE.md`, or a memory
// note) symlinked in from a git-versioned dotfiles repo disappeared from the
// brain tab, because the scan accepted an entry on `dirent.isFile()` — false
// for a symlink — instead of on what the entry resolves to. Nothing failed
// loudly: the cron loop kept firing the same schedule every week while the UI
// showed no schedule at all.
'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { scanMdFiles } = require('../scan-md-files');

function rig() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-scan-md-')));
  const dir = path.join(root, 'commands');
  const elsewhere = path.join(root, 'dotfiles');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(elsewhere, { recursive: true });
  return { root, dir, elsewhere, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function symlink(target, linkPath, t) {
  try { fs.symlinkSync(target, linkPath, 'file'); return true; }
  catch { t.skip('cannot create a symlink on this machine'); return false; }
}

const names = (files) => files.map(f => f.filename).sort();

test('scanMdFiles: lists plain .md files and ignores other extensions', () => {
  const r = rig();
  try {
    fs.writeFileSync(path.join(r.dir, 'CLAUDE.md'), 'hello');
    fs.writeFileSync(path.join(r.dir, 'notes.txt'), 'hello');
    assert.deepEqual(names(scanMdFiles(r.dir)), ['CLAUDE.md']);
  } finally { r.cleanup(); }
});

test('scanMdFiles: lists a .md file that is a symlink to a file kept outside the directory', (t) => {
  const r = rig();
  try {
    const real = path.join(r.elsewhere, 'schedule-audit.md');
    fs.writeFileSync(real, '---\ncron: 0 9 * * 1\n---\naudit');
    const link = path.join(r.dir, 'schedule-audit.md');
    if (!symlink(real, link, t)) return;

    const files = scanMdFiles(r.dir);
    assert.deepEqual(names(files), ['schedule-audit.md']);
    // The link's own path is what the renderer shows and hands back to
    // read-memory / run-schedule-now — not the target it resolves to.
    assert.equal(files[0].filePath, link);
    assert.ok(!Number.isNaN(Date.parse(files[0].modified)));
  } finally { r.cleanup(); }
});

test('scanMdFiles: skips a symlink to a directory, and a dangling one', (t) => {
  const r = rig();
  try {
    const targetDir = path.join(r.elsewhere, 'a-directory.md');
    fs.mkdirSync(targetDir);
    if (!symlink(targetDir, path.join(r.dir, 'a-directory.md'), t)) return;
    if (!symlink(path.join(r.elsewhere, 'gone.md'), path.join(r.dir, 'dangling.md'), t)) return;

    assert.deepEqual(names(scanMdFiles(r.dir)), []);
  } finally { r.cleanup(); }
});

test('scanMdFiles: one dangling entry does not hide the files listed after it', (t) => {
  const r = rig();
  try {
    // Accepting an entry now means stat-ing it, which throws on a dangling
    // link. 'a-dangling.md' sorts before 'z-real.md', so a scan that let that
    // throw escape the loop would return nothing at all.
    if (!symlink(path.join(r.elsewhere, 'gone.md'), path.join(r.dir, 'a-dangling.md'), t)) return;
    fs.writeFileSync(path.join(r.dir, 'z-real.md'), 'still here');

    assert.deepEqual(names(scanMdFiles(r.dir)), ['z-real.md']);
  } finally { r.cleanup(); }
});

test('scanMdFiles: skips empty and whitespace-only files, including through a symlink', (t) => {
  const r = rig();
  try {
    fs.writeFileSync(path.join(r.dir, 'empty.md'), '');
    fs.writeFileSync(path.join(r.dir, 'blank.md'), '   \n\t\n');
    const real = path.join(r.elsewhere, 'also-empty.md');
    fs.writeFileSync(real, '\n');
    if (!symlink(real, path.join(r.dir, 'also-empty.md'), t)) return;

    assert.deepEqual(names(scanMdFiles(r.dir)), []);
  } finally { r.cleanup(); }
});

test('scanMdFiles: a directory that does not exist scans to an empty list, not a throw', () => {
  const r = rig();
  try {
    assert.deepEqual(scanMdFiles(path.join(r.root, 'nope')), []);
  } finally { r.cleanup(); }
});
