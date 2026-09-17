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
const { spawnSync } = require('child_process');

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

test('scanMdFiles: lists plain .md files and ignores every other extension, including ones containing .md', () => {
  const r = rig();
  try {
    fs.writeFileSync(path.join(r.dir, 'CLAUDE.md'), 'hello');
    fs.writeFileSync(path.join(r.dir, 'notes.txt'), 'hello');
    // '.md' as a substring rather than a suffix: an editor backup and an MDX
    // file are not Markdown notes this list should carry.
    fs.writeFileSync(path.join(r.dir, 'notes.md.bak'), 'hello');
    fs.writeFileSync(path.join(r.dir, 'README.mdx'), 'hello');
    assert.deepEqual(names(scanMdFiles(r.dir)), ['CLAUDE.md']);
  } finally { r.cleanup(); }
});

test('scanMdFiles: lists a .md file that is a symlink to a file kept outside the directory', (t) => {
  const r = rig();
  try {
    // Deliberately different names at the two ends: the renderer decides
    // whether to draw the "run now" play button from the *listed* name
    // (memory-workfiles-view.js keys on filename.startsWith('schedule-')), so a
    // scan that reported the target's name would move that button.
    const real = path.join(r.elsewhere, 'audit.md');
    fs.writeFileSync(real, '---\ncron: 0 9 * * 1\n---\naudit');
    const link = path.join(r.dir, 'schedule-audit.md');
    if (!symlink(real, link, t)) return;

    const files = scanMdFiles(r.dir);
    assert.deepEqual(names(files), ['schedule-audit.md']);
    // The link's own path is what the renderer shows and hands back to
    // read-memory / run-schedule-now — not the target it resolves to.
    assert.equal(files[0].filePath, link);
    // computeIndexSignature and the project sort both parse this back.
    assert.match(files[0].modified, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(files[0].modified, fs.statSync(real).mtime.toISOString());
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

test('scanMdFiles: skips a symlink to a FIFO instead of blocking forever on it', (t) => {
  const r = rig();
  try {
    // readFileSync on a FIFO with no writer never returns, and this scan runs
    // synchronously inside an ipcMain.handle — a hang here is the whole
    // Electron main process, with no way back. stat() on a FIFO does not
    // block, so resolving the entry first is what keeps the read unreachable.
    // A regression here shows up as a suite that hangs rather than one that
    // goes red: the block is synchronous, so no test timeout can interrupt it.
    const fifo = path.join(r.elsewhere, 'pipe.md');
    const mk = spawnSync('mkfifo', [fifo]);
    if (mk.error || mk.status !== 0) return t.skip('mkfifo unavailable on this machine');
    if (!symlink(fifo, path.join(r.dir, 'linked.md'), t)) return;
    fs.writeFileSync(path.join(r.dir, 'real.md'), 'still here');

    assert.deepEqual(names(scanMdFiles(r.dir)), ['real.md']);
  } finally { r.cleanup(); }
});

test('scanMdFiles: refuses a link to a credential location even when the allowlist would accept it', (t) => {
  const r = rig();
  try {
    // The denylist is not the caller's to choose: a cloned repository added as
    // a project carries its own .ssh/.env, which containment in an allowed root
    // says nothing about. Reading one here would put its content in the FTS
    // index, which is searchable by substring.
    const sshDir = path.join(r.elsewhere, '.ssh');
    fs.mkdirSync(sshDir, { recursive: true });
    const key = path.join(sshDir, 'id_rsa.md');
    fs.writeFileSync(key, '-----BEGIN OPENSSH PRIVATE KEY-----');
    if (!symlink(key, path.join(r.dir, 'notes.md'), t)) return;
    fs.writeFileSync(path.join(r.dir, 'ordinary.md'), 'an ordinary note');

    // allowAll: only the denylist can refuse it here.
    assert.deepEqual(names(scanMdFiles(r.dir, () => true)), ['ordinary.md']);
  } finally { r.cleanup(); }
});

test('scanMdFiles: a file the caller\'s allowlist refuses is not listed', (t) => {
  const r = rig();
  try {
    // The list feeds readers that apply this allowlist before opening a file
    // (read-memory, save-memory) and an FTS indexer that reads the body with no
    // guard at all. Listing a file the allowlist refuses puts its content in
    // the search index while the panel that displays it stays empty.
    const outside = path.join(r.elsewhere, 'creds.md');
    fs.writeFileSync(outside, 'SECRET=value');
    if (!symlink(outside, path.join(r.dir, 'notes.md'), t)) return;
    fs.writeFileSync(path.join(r.dir, 'allowed.md'), 'ordinary note');

    const allowed = (fp) => {
      const real = fs.realpathSync(fp);
      return real === r.dir || real.startsWith(r.dir + path.sep);
    };
    assert.deepEqual(names(scanMdFiles(r.dir, allowed)), ['allowed.md']);
    // Without a predicate the scan lists both — the allowlist is the caller's.
    assert.deepEqual(names(scanMdFiles(r.dir)), ['allowed.md', 'notes.md']);
  } finally { r.cleanup(); }
});

test('scanMdFiles: a directory that does not exist scans to an empty list, not a throw', () => {
  const r = rig();
  try {
    assert.deepEqual(scanMdFiles(path.join(r.root, 'nope')), []);
  } finally { r.cleanup(); }
});
