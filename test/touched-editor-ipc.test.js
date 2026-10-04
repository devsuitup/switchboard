'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const gitChangesFile = require('../git-changes-file');
const { isSensitivePath } = require('../ipc-path-validator');
const { createMainPanelSaves } = require('../viewer-save-guard');

const MAX_BYTES = 1024;
const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function panelHandlers(fsOps = fs) {
  const handlers = new Map();
  const context = {
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    fs: fsOps, path, isSensitivePath, gitChangesFile, PANEL_FILE_MAX_BYTES: MAX_BYTES,
    panelSaves: createMainPanelSaves({ getKnownProjectPaths: () => [], invalidateFtsSignature() {} }),
    invalidateFtsSignature() {},
  };
  for (const channel of ['read-file-for-panel', 'save-file-for-panel']) {
    const start = source.indexOf("ipcMain.handle('" + channel + "'");
    const end = source.indexOf('\n});', start) + '\n});'.length;
    assert.ok(start >= 0 && end > start);
    vm.runInNewContext(source.slice(start, end), context, { filename: 'main.js' });
  }
  return { read: (...args) => handlers.get('read-file-for-panel')(null, ...args), save: (...args) => handlers.get('save-file-for-panel')(null, ...args) };
}

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-touched-ipc-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: dir, USERPROFILE: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(dir, 'empty-config') };
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, env, timeout: 10_000, stdio: 'pipe' });
  return { dir, git };
}

for (const inGit of [true, false]) {
  test('shipped panel IPC opens, saves, reloads and rejects stale Touched text (git=' + inGit + ')', async t => {
    const { dir, git } = fixture(t);
    const target = path.join(dir, 'file.txt');
    fs.writeFileSync(target, 'base\n');
    if (inGit) {
      git('init', '-q');
      git('config', 'core.autocrlf', 'false');
      git('config', 'user.name', 'Fixture');
      git('config', 'user.email', 'fixture@example.invalid');
      git('add', 'file.txt');
      git('commit', '-qm', 'fixture');
      fs.writeFileSync(target, 'indexed\n');
      git('add', 'file.txt');
    }
    fs.writeFileSync(target, 'current\n');
    const api = panelHandlers();
    const pair = await api.read(target, { editor: true });
    assert.equal(pair.ok, true, pair.error);
    assert.equal(pair.git, inGit);
    assert.equal(pair.current, 'current\n');
    assert.equal(pair.original, inGit ? 'base\n' : 'current\n');
    const saved = await api.save(target, 'saved\n', pair.current, { git: pair.git, version: pair.version });
    assert.equal(saved.ok, true, saved.error);
    assert.equal(fs.readFileSync(target, 'utf8'), 'saved\n');
    const reloaded = await api.read(target, { editor: true });
    assert.equal(reloaded.current, 'saved\n');
    assert.equal(reloaded.original, inGit ? 'base\n' : 'saved\n');
    const stale = await api.save(target, 'overwrite', pair.current, { git: pair.git, version: pair.version });
    assert.equal(stale.reason, 'stale');
    assert.equal(fs.readFileSync(target, 'utf8'), 'saved\n');
    const ordinary = await api.read(target);
    assert.equal(ordinary.content, 'saved\n');
  });
}

test('shipped Touched read keeps missing, binary, oversized, directory and unreadable refusals', async t => {
  const { dir } = fixture(t);
  const api = panelHandlers();
  const target = path.join(dir, 'file.txt');
  assert.equal((await api.read(target, { editor: true })).ok, false);
  assert.equal((await api.read(dir, { editor: true })).ok, false);
  fs.writeFileSync(target, Buffer.from([0, 1]));
  assert.match((await api.read(target, { editor: true })).error, /binary/);
  fs.writeFileSync(target, 'x'.repeat(MAX_BYTES + 1));
  assert.match((await api.read(target, { editor: true })).error, /large/);
  const unreadable = panelHandlers({ statSync: fs.statSync, readFileSync: () => { throw new Error('unreadable fixture'); } });
  fs.writeFileSync(target, 'text');
  assert.match((await unreadable.read(target, { editor: true })).error, /unreadable fixture/);
});
