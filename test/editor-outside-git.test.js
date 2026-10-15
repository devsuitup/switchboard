'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const files = require('../git-changes-file');
const { runToExit } = require('../run-to-exit');
const { createChangesWatchRegistry } = require('../git-changes-watch');
const { createViewerWatchRegistry } = require('../viewer-file-watch');
const { createMainPanelSaves } = require('../viewer-save-guard');
const { isSensitivePath } = require('../ipc-path-validator');
const { resolveTerminalPathTarget, fileHasNullByte } = require('../terminal-path-target');

const maxBytes = 1024;
const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

async function runGit(args, options) {
  const result = await runToExit('git', args, { ...options, env: {
    ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), 'sb-658-no-config'),
    GIT_CEILING_DIRECTORIES: fs.realpathSync.native(os.tmpdir()), LC_ALL: 'C', LANGUAGE: 'C',
  } });
  return { ...result, tooLarge: result.overflow };
}

function fixture(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-658-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const absolutePath = path.join(dir, 'notes.txt');
  fs.writeFileSync(absolutePath, '\ufeffone\r\ntwo\r\n');
  return { dir, absolutePath };
}

function handlers(t, cwd) {
  const registered = new Map();
  let notify;
  const changed = new Promise(resolve => { notify = resolve; });
  const changesWatchers = createChangesWatchRegistry({ watchFn: fs.watch, send: (...args) => notify(args), debounceMs: 5 });
  const fileWatchers = createViewerWatchRegistry({ send: p => notify(p), debounceMs: 5 });
  t.after(() => { changesWatchers.closeAll(); fileWatchers.closeAll(); });
  const gitChangesFile = Object.fromEntries(Object.entries(files).map(([name, fn]) => [name,
    ['readChangesFile', 'writeChangesFile', 'readTouchedChangesFile', 'writeTouchedChangesFile', 'resolveRepoDirs'].includes(name)
      ? args => fn(args, { runGit }) : fn]));
  gitChangesFile.resolveRepoDirs = cwd => files.resolveRepoDirs(cwd, { runGit });
  gitChangesFile.resolveFileRoot = cwd => files.resolveFileRoot(cwd, { runGit });
  const context = {
    ipcMain: { handle: (channel, fn) => registered.set(channel, fn) },
    fs, path, gitChangesFile, isSensitivePath, PANEL_FILE_MAX_BYTES: maxBytes,
    resolveGitChangesTarget: id => ({ ok: true, kind: id === 'remote' ? 'remote' : 'local', cwd }),
    changesWatchers, fileWatchers, invalidateFtsSignature() {},
    panelSaves: createMainPanelSaves({ getKnownProjectPaths: () => [], invalidateFtsSignature() {} }),
  };
  for (const channel of ['read-file-for-panel', 'save-file-for-panel', 'watch-file', 'git-changes-file', 'git-changes-save', 'git-changes-watch']) {
    const start = source.indexOf("ipcMain.handle('" + channel + "'");
    const end = source.indexOf('\n});', start) + 4;
    vm.runInNewContext(source.slice(start, end), context, { filename: 'main.js' });
  }
  return { call: (channel, ...args) => registered.get(channel)(null, ...args), changed };
}

test('658: relative file IPC reads outside git and saves with byte version and original BOM/CRLF', async t => {
  const { dir, absolutePath } = fixture(t);
  const api = handlers(t, dir);
  const pair = await api.call('git-changes-file', 'local', 'notes.txt', {});
  assert.equal(pair.ok, true, pair.error);
  assert.equal(pair.git, false);
  assert.equal(pair.current, 'one\ntwo\n');
  assert.equal(pair.original, pair.current);
  assert.equal(pair.version, files.versionOf(fs.readFileSync(absolutePath)));
  const saved = await api.call('git-changes-save', 'local', 'notes.txt', 'saved\n', pair.version);
  assert.equal(saved.ok, true, saved.error);
  assert.equal(fs.readFileSync(absolutePath, 'utf8'), '\ufeffsaved\r\n');
  assert.equal(saved.version, files.versionOf(fs.readFileSync(absolutePath)));
});

test('658: non-touched terminal target outside git opens and saves through shipped panel IPC', async t => {
  const { dir, absolutePath } = fixture(t);
  const target = await resolveTerminalPathTarget('notes.txt', dir, {
    isSensitivePath, stat: fs.promises.stat, hasNullByte: fileHasNullByte, homedir: os.homedir, maxBytes,
  });
  assert.equal(target.ok, true);
  const api = handlers(t, dir);
  const pair = await api.call('read-file-for-panel', target.path, { editor: true });
  assert.equal(pair.ok, true, pair.error);
  assert.equal(pair.version, files.versionOf(fs.readFileSync(absolutePath)));
  const saved = await api.call('save-file-for-panel', target.path, 'saved\n', pair.current, { git: pair.git, version: pair.version });
  assert.equal(saved.ok, true, saved.error);
  assert.equal(fs.readFileSync(absolutePath, 'utf8'), '\ufeffsaved\r\n');
});

test('658: plain panel rejects concurrent byte changes even when normalized text is unchanged', async t => {
  const { dir, absolutePath } = fixture(t);
  fs.writeFileSync(absolutePath, 'same\r\n');
  const api = handlers(t, dir);
  const pair = await api.call('read-file-for-panel', absolutePath, { editor: true });
  fs.writeFileSync(absolutePath, 'same\n');
  const saved = await api.call('save-file-for-panel', absolutePath, 'overwrite\n', pair.current, { git: pair.git, version: pair.version });
  assert.equal(saved.reason, 'stale');
  assert.equal(fs.readFileSync(absolutePath, 'utf8'), 'same\n');
});

for (const relative of [true, false]) {
  test('658: real external-change watch works outside git (relative=' + relative + ')', { timeout: 5000 }, async t => {
    const { dir, absolutePath } = fixture(t);
    const api = handlers(t, dir);
    const result = relative ? await api.call('git-changes-watch', 'local', 'notes.txt') : await api.call('watch-file', absolutePath);
    assert.equal(result.ok, true, result.error);
    fs.writeFileSync(absolutePath, 'external\n');
    const event = await api.changed;
    assert.deepEqual(event, relative ? ['local', 'notes.txt'] : absolutePath);
    const pair = relative ? await api.call('git-changes-file', 'local', 'notes.txt', {})
      : await api.call('read-file-for-panel', absolutePath, { editor: true });
    assert.equal(pair.current, 'external\n');
  });
}

test('658: relative IPC keeps shipped path, sensitive, link, binary and size guards without git', async t => {
  const { dir, absolutePath } = fixture(t);
  const api = handlers(t, dir);
  const original = fs.readFileSync(absolutePath);
  const version = files.versionOf(original);
  for (const rel of ['../notes.txt', absolutePath, '.git/config', 'sub/../../notes.txt', ':magic', '-option']) {
    assert.equal((await api.call('git-changes-file', 'local', rel, {})).ok, false, rel);
    assert.equal((await api.call('git-changes-save', 'local', rel, 'overwrite', version)).ok, false, rel);
    assert.equal((await api.call('git-changes-watch', 'local', rel)).ok, false, rel);
  }
  fs.writeFileSync(path.join(dir, '.env'), 'secret');
  fs.writeFileSync(path.join(dir, 'binary'), Buffer.from([0, 1]));
  fs.writeFileSync(path.join(dir, 'large'), 'x'.repeat(maxBytes + 1));
  for (const [rel, reason] of [['.env', 'sensitive'], ['binary', 'binary'], ['large', 'too-large']]) {
    assert.equal((await api.call('git-changes-file', 'local', rel, {})).reason, reason);
  }
  fs.linkSync(absolutePath, path.join(dir, 'hardlink'));
  assert.equal((await api.call('git-changes-file', 'local', 'hardlink', {})).reason, 'hardlink');
  assert.equal((await api.call('git-changes-save', 'local', 'hardlink', 'overwrite', version)).reason, 'hardlink');
  assert.equal((await api.call('git-changes-watch', 'local', 'hardlink')).reason, 'hardlink');
  assert.equal((await api.call('git-changes-save', 'remote', 'notes.txt', 'overwrite', version)).reason, 'remote');
  assert.equal((await api.call('git-changes-watch', 'remote', 'notes.txt')).reason, 'remote');
  assert.deepEqual(fs.readFileSync(absolutePath), original);
});

test('658: git metadata used as a session cwd remains refused', async t => {
  const { dir } = fixture(t);
  const gitDir = path.join(dir, '.git');
  fs.mkdirSync(gitDir);
  const target = path.join(gitDir, 'config');
  fs.writeFileSync(target, 'metadata');
  const api = handlers(t, gitDir);
  for (const channel of ['git-changes-file', 'git-changes-watch']) {
    const result = await api.call(channel, 'local', 'config', {});
    assert.equal(result.ok, false, channel);
  }
  const result = await api.call('git-changes-save', 'local', 'config', 'overwrite', files.versionOf(Buffer.from('metadata')));
  assert.equal(result.ok, false);
  const alias = path.join(dir, 'metadata-alias');
  fs.symlinkSync(gitDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const throughAlias = handlers(t, alias);
  assert.equal((await throughAlias.call('git-changes-file', 'local', 'config', {})).ok, false);
  assert.equal((await throughAlias.call('git-changes-save', 'local', 'config', 'overwrite', files.versionOf(Buffer.from('metadata')))).ok, false);
  assert.equal((await throughAlias.call('git-changes-watch', 'local', 'config')).ok, false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'metadata');
});

test('658: a repository probe error cannot turn metadata into an editable plain file', async t => {
  const { dir, absolutePath } = fixture(t);
  const runGit = async () => ({ code: 128, stderr: 'fatal: this operation must be run in a work tree' });
  const args = { cwd: dir, relPath: 'notes.txt', maxBytes, content: 'overwrite', version: files.versionOf(fs.readFileSync(absolutePath)) };
  assert.equal((await files.readChangesFile(args, { runGit })).ok, false);
  assert.equal((await files.writeChangesFile(args, { runGit })).ok, false);
});

test('658: a non-touched terminal target inside git opens and saves without transcript membership', async t => {
  const { dir, absolutePath } = fixture(t);
  const initialized = await runGit(['init', '-q'], { cwd: dir });
  assert.equal(initialized.code, 0);
  const target = await resolveTerminalPathTarget('notes.txt', dir, {
    isSensitivePath, stat: fs.promises.stat, hasNullByte: fileHasNullByte, homedir: os.homedir, maxBytes,
  });
  assert.equal(target.ok, true);
  const api = handlers(t, dir);
  const pair = await api.call('read-file-for-panel', target.path, { editor: true });
  assert.equal(pair.ok, true, pair.error);
  assert.equal(pair.git, true);
  assert.equal(pair.original, '');
  const saved = await api.call('save-file-for-panel', target.path, 'saved\n', pair.current, { git: pair.git, version: pair.version });
  assert.equal(saved.ok, true, saved.error);
  assert.equal(fs.readFileSync(absolutePath, 'utf8'), '\ufeffsaved\r\n');
});

test('658: plain files retain encoding, EOL, size and missing-version save refusals', async t => {
  const { dir, absolutePath } = fixture(t);
  const args = { cwd: dir, relPath: 'notes.txt', maxBytes };
  for (const [bytes, reason] of [[Buffer.from([0xc3, 0x28]), 'encoding'], [Buffer.from('a\r\nb\n'), 'mixed-eol']]) {
    fs.writeFileSync(absolutePath, bytes);
    assert.equal((await files.readChangesFile(args, { runGit })).reason, reason);
    const saved = await files.writeChangesFile({ ...args, version: files.versionOf(bytes), content: 'overwrite' }, { runGit });
    assert.equal(saved.reason, reason);
    assert.deepEqual(fs.readFileSync(absolutePath), bytes);
  }
  fs.writeFileSync(absolutePath, 'safe\n');
  const version = files.versionOf(fs.readFileSync(absolutePath));
  assert.equal((await files.writeChangesFile({ ...args, version, content: '\ud800' }, { runGit })).reason, 'encoding');
  assert.equal((await files.writeChangesFile({ ...args, version, content: 'x'.repeat(maxBytes + 1) }, { runGit })).reason, 'too-large');
  assert.equal((await files.writeChangesFile({ ...args, content: 'overwrite' }, { runGit })).reason, 'invalid-version');
  assert.equal(fs.readFileSync(absolutePath, 'utf8'), 'safe\n');
});

test('658: a terminal filename unsuitable for git still uses a byte-versioned save outside git', async t => {
  const { dir } = fixture(t);
  const target = path.join(dir, '-notes.txt');
  fs.writeFileSync(target, 'same\r\n');
  const api = handlers(t, dir);
  const pair = await api.call('read-file-for-panel', target, { editor: true });
  assert.equal(pair.ok, true, pair.error);
  assert.equal(pair.version, files.versionOf(fs.readFileSync(target)));
  const saved = await api.call('save-file-for-panel', target, 'saved\n', pair.current, { git: pair.git, version: pair.version });
  assert.equal(saved.ok, true, saved.error);
  assert.equal(fs.readFileSync(target, 'utf8'), 'saved\r\n');
});

test('658: mixed-EOL fallback is readable and versioned but does not bypass the EOL save guard', async t => {
  const { dir, absolutePath } = fixture(t);
  const bytes = Buffer.from('one\r\ntwo\n');
  fs.writeFileSync(absolutePath, bytes);
  const api = handlers(t, dir);
  const pair = await api.call('read-file-for-panel', absolutePath, { editor: true });
  assert.equal(pair.ok, true, pair.error);
  assert.equal(pair.current, 'one\ntwo\n');
  assert.equal(pair.version, files.versionOf(bytes));
  const saved = await api.call('save-file-for-panel', absolutePath, 'overwrite', pair.current, { git: pair.git, version: pair.version });
  assert.equal(saved.reason, 'mixed-eol');
  assert.deepEqual(fs.readFileSync(absolutePath), bytes);
});
