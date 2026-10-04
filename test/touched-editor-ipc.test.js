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

const { runToExit } = require('../run-to-exit');
const MAX_BYTES = 1024;
async function fixtureRunGit(args, options) {
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    HOME: os.tmpdir(), USERPROFILE: os.tmpdir(), TMP: os.tmpdir(), TEMP: os.tmpdir(),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), 'sb-touched-no-config'),
    GIT_CEILING_DIRECTORIES: fs.realpathSync(os.tmpdir()), LC_ALL: 'C', LANGUAGE: 'C',
  };
  const result = await runToExit('git', args, { ...options, env });
  return { ...result, tooLarge: result.overflow };
}
const fixtureGitFiles = {
  ...gitChangesFile,
  readTouchedChangesFile: args => gitChangesFile.readTouchedChangesFile(args, { runGit: fixtureRunGit }),
  writeTouchedChangesFile: args => gitChangesFile.writeTouchedChangesFile(args, { runGit: fixtureRunGit }),
};
const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function panelHandlers(fsOps = fs, gitOps = fixtureGitFiles) {
  const handlers = new Map();
  const context = {
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    fs: fsOps, path, isSensitivePath, gitChangesFile: gitOps, PANEL_FILE_MAX_BYTES: MAX_BYTES,
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-touched-ipc-'));
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
  assert.match((await api.read(target)).error, /binary/);
  const binaryPair = await api.read(target, { editor: true });
  assert.equal(binaryPair.ok, false);
  assert.match(binaryPair.error, /binary file/);
  fs.writeFileSync(target, 'x'.repeat(MAX_BYTES + 1));
  assert.match((await api.read(target, { editor: true })).error, /large/);
  const unreadable = panelHandlers({ realpathSync: fs.realpathSync, statSync: fs.statSync, readFileSync: () => { throw new Error('unreadable fixture'); } });
  fs.writeFileSync(target, 'text');
  assert.match((await unreadable.read(target, { editor: true })).error, /unreadable fixture/);
});

for (const inGit of [true, false]) {
  test('round 3: refusing a binary Touched open preserves its exact bytes (git=' + inGit + ')', async t => {
    const { dir, git } = fixture(t);
    if (inGit) git('init', '-q');
    const target = path.join(dir, 'bin.dat');
    const before = Buffer.from([0x41, 0x00, 0xff, 0x42]);
    fs.writeFileSync(target, before);
    const api = panelHandlers();
    const pair = await api.read(target, { editor: true });
    if (pair.ok) await api.save(target, pair.current, pair.current, { git: pair.git, version: pair.version });
    assert.deepEqual(fs.readFileSync(target), before, 'opening and attempting to save must preserve binary bytes');
    assert.equal(pair.ok, false);
    assert.equal(pair.error, 'binary file');
    if (inGit) {
      const direct = await fixtureGitFiles.readTouchedChangesFile({ absolutePath: target, maxBytes: MAX_BYTES });
      assert.equal(direct.ok, false);
      assert.equal(direct.reason, 'binary');
    }
  });

  test('round 3: a final file symlink opens read-only and every save refuses the link (git=' + inGit + ')', async t => {
    const { dir, git } = fixture(t);
    if (inGit) git('init', '-q');
    const target = path.join(dir, 'target.txt');
    const link = path.join(dir, 'link.txt');
    fs.writeFileSync(target, 'target bytes\n');
    fs.symlinkSync(target, link, 'file');
    const api = panelHandlers();
    const ordinary = await api.read(link);
    assert.equal(ordinary.ok, true, ordinary.error);
    assert.equal(ordinary.content, 'target bytes\n');
    const pair = await api.read(link, { editor: true });
    assert.equal(pair.ok, true, pair.error);
    assert.equal(pair.readOnly, true);
    assert.equal(pair.current, 'target bytes\n');
    for (const opts of [undefined, { git: false }, { git: true, version: pair.version }]) {
      const saved = await api.save(link, 'overwrite', pair.current, opts);
      assert.equal(saved.ok, false);
      assert.equal(saved.reason, 'symlink');
    }
    const direct = await fixtureGitFiles.writeTouchedChangesFile({ absolutePath: link, content: 'overwrite', version: 'v1', maxBytes: MAX_BYTES });
    assert.equal(direct.reason, 'symlink');
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(target, 'utf8'), 'target bytes\n');
  });
}

for (const [name, body] of [['dash name', 'text\n'], ['mixed EOL', 'one\r\ntwo\n']]) {
  test('round 2: shipped IPC opens and saves plain content for ' + name, async t => {
    const { dir, git } = fixture(t);
    git('init', '-q');
    const target = path.join(dir, name === 'dash name' ? '-file.txt' : 'mixed.txt');
    fs.writeFileSync(target, body);
    const api = panelHandlers();
    const pair = await api.read(target, { editor: true });
    assert.equal(pair.ok, true, pair.error);
    assert.equal(pair.git, false);
    assert.equal(pair.current, gitChangesFile.toLf(body));
    const saved = await api.save(target, 'saved\n', pair.current, { git: pair.git });
    assert.equal(saved.ok, true, saved.error);
    assert.equal(fs.readFileSync(target, 'utf8'), 'saved\n');
  });
}

test('round 2: real git opens and saves a Touched path through an internal junction', async t => {
  const { dir, git } = fixture(t);
  git('init', '-q');
  fs.mkdirSync(path.join(dir, 'real'));
  const target = path.join(dir, 'real', 'file.txt');
  fs.writeFileSync(target, 'base\n');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('add', 'real/file.txt');
  git('commit', '-qm', 'fixture');
  fs.writeFileSync(target, 'current\n');
  fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const api = panelHandlers();
  const alias = path.join(dir, 'link', 'file.txt');
  const pair = await api.read(alias, { editor: true });
  assert.equal(pair.ok, true, pair.error);
  assert.equal(pair.git, true);
  assert.equal(pair.original, 'base\n');
  assert.equal(pair.current, 'current\n');
  const saved = await api.save(alias, 'saved\n', pair.current, { git: pair.git, version: pair.version });
  assert.equal(saved.ok, true, saved.error);
  assert.equal(fs.readFileSync(target, 'utf8'), 'saved\n');
});

test('round 3: real git preserves HEAD and saves a modified Windows 8.3 Touched path', { skip: process.platform !== 'win32' }, async t => {
  const { dir, git } = fixture(t);
  git('init', '-q');
  const target = path.join(dir, 'long-file-name.txt');
  fs.writeFileSync(target, 'base\n');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('add', 'long-file-name.txt');
  git('commit', '-qm', 'fixture');
  fs.writeFileSync(target, 'current\n');
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: dir, USERPROFILE: dir };
  const longDir = fs.realpathSync.native(dir);
  const shortDir = execFileSync('cmd.exe', ['/d', '/c', 'for %I in ("' + longDir + '") do @echo %~sI'], { env, encoding: 'utf8', timeout: 10_000, windowsVerbatimArguments: true }).trim();
  if (shortDir.toLowerCase() === longDir.toLowerCase()) { t.skip('the derived directory spelling equals its long spelling'); return; }
  const short = path.join(shortDir, 'long-file-name.txt');
  assert.notEqual(short.toLowerCase(), fs.realpathSync.native(target).toLowerCase());
  const api = panelHandlers();
  const pair = await api.read(short, { editor: true });
  assert.equal(pair.ok, true, pair.error);
  assert.equal(pair.git, true);
  assert.equal(pair.original, 'base\n');
  assert.equal(pair.current, 'current\n');
  const saved = await api.save(short, 'saved\n', pair.current, { git: pair.git, version: pair.version });
  assert.equal(saved.ok, true, saved.error);
  assert.equal(fs.readFileSync(target, 'utf8'), 'saved\n');
});

for (const failure of [{ code: -1, stderr: 'git timed out' }, new Error('spawn git ENOENT')]) {
  test('round 2: shipped IPC falls back to plain content when git cannot run: ' + (failure.stderr || failure.message), async t => {
    const { dir } = fixture(t);
    const target = path.join(dir, 'file.txt');
    fs.writeFileSync(target, 'current\n');
    const api = panelHandlers(fs, { ...gitChangesFile, readTouchedChangesFile: args => gitChangesFile.readTouchedChangesFile(args, {
      runGit: async () => { if (failure instanceof Error) throw failure; return failure; },
    }) });
    const pair = await api.read(target, { editor: true });
    assert.equal(pair.ok, true, pair.error);
    assert.equal(pair.git, false);
    assert.equal(pair.current, 'current\n');
    assert.equal((await api.save(target, 'saved\n', pair.current, { git: false })).ok, true);
    assert.equal(fs.readFileSync(target, 'utf8'), 'saved\n');
  });
}

test('round 2: shipped plain and git read/save paths refuse .git metadata independently of git version', async t => {
  const { dir, git } = fixture(t);
  git('init', '-q');
  const target = path.join(dir, '.git', 'config');
  const before = fs.readFileSync(target, 'utf8');
  const api = panelHandlers(fs, { ...gitChangesFile, readTouchedChangesFile: () => { throw new Error('git must not run'); } });
  for (const opts of [undefined, { editor: true }]) assert.equal((await api.read(target, opts)).reason, 'git-dir');
  for (const opts of [undefined, { git: false }, { git: true, version: 'v1' }]) assert.equal((await api.save(target, 'overwrite', before, opts)).reason, 'git-dir');
  assert.equal(fs.readFileSync(target, 'utf8'), before);
});

test('round 2: real git opens a Touched file through a repository directory alias', async t => {
  const { dir, git } = fixture(t);
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  git('init', '-q', repo);
  const target = path.join(repo, 'file.txt');
  fs.writeFileSync(target, 'current\n');
  fs.symlinkSync(repo, path.join(dir, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const api = panelHandlers();
  const alias = path.join(dir, 'alias', 'file.txt');
  const pair = await api.read(alias, { editor: true });
  assert.equal(pair.ok, true, pair.error);
  assert.equal(pair.git, true);
  assert.equal(pair.current, 'current\n');
  const saved = await api.save(alias, 'saved\n', pair.current, { git: pair.git, version: pair.version });
  assert.equal(saved.ok, true, saved.error);
  assert.equal(fs.readFileSync(target, 'utf8'), 'saved\n');
});

test('round 2: a noncanonical root from real git is resolved before computing the relative path', async t => {
  const { dir, git } = fixture(t);
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  git('init', '-q', repo);
  const target = path.join(repo, 'file.txt');
  fs.writeFileSync(target, 'current\n');
  const alias = path.join(dir, 'alias');
  fs.symlinkSync(repo, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const runGit = async (args, options) => {
    const result = await fixtureRunGit(args, options);
    if (args[0] === 'rev-parse' && result.code === 0) {
      const lines = result.stdout.toString().split('\n');
      lines[0] = alias;
      result.stdout = Buffer.from(lines.join('\n'));
    }
    return result;
  };
  const pair = await gitChangesFile.readTouchedChangesFile({ absolutePath: target, maxBytes: MAX_BYTES }, { runGit });
  assert.equal(pair.ok, true, pair.error);
  assert.equal(pair.git, true);
  assert.equal(pair.current, 'current\n');
  assert.equal((await gitChangesFile.writeTouchedChangesFile({ absolutePath: target, content: 'saved\n', version: pair.version, maxBytes: MAX_BYTES }, { runGit })).ok, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'saved\n');
});

test('round 2: a git-directory junction is refused before probing on every panel path', async t => {
  const { dir, git } = fixture(t);
  git('init', '-q');
  const alias = path.join(dir, 'metadata');
  fs.symlinkSync(path.join(dir, '.git'), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const target = path.join(alias, 'config');
  const before = fs.readFileSync(target, 'utf8');
  const deps = { runGit: () => { throw new Error('git must not run'); } };
  assert.equal((await gitChangesFile.readTouchedChangesFile({ absolutePath: target, maxBytes: MAX_BYTES }, deps)).reason, 'git-dir');
  assert.equal((await gitChangesFile.writeTouchedChangesFile({ absolutePath: target, content: 'overwrite', version: 'v1', maxBytes: MAX_BYTES }, deps)).reason, 'git-dir');
  const api = panelHandlers();
  assert.equal((await api.read(target, { editor: true })).reason, 'git-dir');
  assert.equal((await api.save(target, 'overwrite', before, { git: false })).reason, 'git-dir');
  assert.equal(fs.readFileSync(target, 'utf8'), before);
});

for (const [name, bytes] of [['binary', Buffer.from([0, 1])], ['encoding', Buffer.from([0xff])]]) {
  test('round 3: real Git ' + name + ' refusal retains its panel policy', async t => {
    const { dir, git } = fixture(t);
    git('init', '-q');
    const target = path.join(dir, 'file.txt');
    fs.writeFileSync(target, bytes);
    const pair = await panelHandlers().read(target, { editor: true });
    if (name === 'binary') {
      assert.equal(pair.ok, false);
      assert.equal(pair.error, 'binary file');
      assert.deepEqual(fs.readFileSync(target), bytes);
      return;
    }
    assert.equal(pair.ok, false);
    assert.equal(pair.reason, 'encoding');
    assert.deepEqual(fs.readFileSync(target), bytes);
  });
}

for (const phase of ['repository reread', 'blob read']) {
  for (const throws of [false, true]) {
    test('round 2: git failure during ' + phase + ' falls back to plain content (throws=' + throws + ')', async t => {
      const { dir, git } = fixture(t);
      git('init', '-q');
      const target = path.join(dir, 'file.txt');
      fs.writeFileSync(target, 'current\n');
      let probes = 0;
      const runGit = async (args, options) => {
        if (args[0] === 'rev-parse') probes++;
        if ((phase === 'repository reread' && probes === 2) || (phase === 'blob read' && args[0] === 'cat-file')) {
          if (throws) throw new Error('spawn git ENOENT');
          return { code: -1, stdout: '', stderr: 'git timed out' };
        }
        return fixtureRunGit(args, options);
      };
      const api = panelHandlers(fs, { ...fixtureGitFiles, readTouchedChangesFile: args => gitChangesFile.readTouchedChangesFile(args, { runGit }) });
      const pair = await api.read(target, { editor: true });
      assert.equal(pair.ok, true, pair.error);
      assert.equal(pair.git, false);
      assert.equal(pair.current, 'current\n');
    });
  }
}

test('round 3: a binary HEAD blob is refused without plain fallback or writes', async t => {
  const { dir, git } = fixture(t);
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  const target = path.join(dir, 'file.txt');
  fs.writeFileSync(target, Buffer.from([0x41, 0x00, 0xff, 0x42]));
  git('add', 'file.txt');
  git('commit', '-qm', 'fixture');
  const before = Buffer.from('now text\n');
  fs.writeFileSync(target, before);
  const pair = await panelHandlers().read(target, { editor: true });
  assert.equal(pair.ok, false);
  assert.equal(pair.reason, 'binary');
  assert.deepEqual(fs.readFileSync(target), before);
});

for (const inGit of [true, false]) {
  test('round 5: invalid UTF-8 open and every save preserve bytes (git=' + inGit + ')', async t => {
    const { dir, git } = fixture(t);
    const target = path.join(dir, 'file.txt');
    const before = Buffer.from([0x41, 0xff, 0x42, 0x0a]);
    fs.writeFileSync(target, before);
    if (inGit) {
      git('init', '-q');
      git('add', 'file.txt');
    }
    const api = panelHandlers();
    const pair = await api.read(target, { editor: true });
    assert.deepEqual(fs.readFileSync(target), before, 'open preserves the original bytes');
    for (const opts of [undefined, { git: false }, { git: true, version: gitChangesFile.versionOf(before) }]) {
      const saved = await api.save(target, before.toString('utf8'), before.toString('utf8'), opts);
      assert.deepEqual(fs.readFileSync(target), before, 'every save preserves the original bytes');
      assert.equal(saved.ok, false);
      assert.equal(saved.reason, 'encoding');
    }
    assert.equal(pair.ok, false);
    assert.equal(pair.reason, 'encoding');
    if (inGit) {
      const direct = await fixtureGitFiles.readTouchedChangesFile({ absolutePath: target, maxBytes: MAX_BYTES });
      assert.equal(direct.ok, false);
      assert.equal(direct.reason, 'encoding');
      const saved = await fixtureGitFiles.writeTouchedChangesFile({ absolutePath: target, content: 'overwrite', version: gitChangesFile.versionOf(before), maxBytes: MAX_BYTES });
      assert.equal(saved.ok, false);
      assert.deepEqual(fs.readFileSync(target), before);
    }
  });
}

test('round 5: invalid UTF-8 HEAD stays refused with valid working text', async t => {
  const { dir, git } = fixture(t);
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  const target = path.join(dir, 'file.txt');
  fs.writeFileSync(target, Buffer.from([0x41, 0xff, 0x42, 0x0a]));
  git('add', 'file.txt');
  git('commit', '-qm', 'fixture');
  const before = Buffer.from('valid text\n');
  fs.writeFileSync(target, before);
  const pair = await panelHandlers().read(target, { editor: true });
  assert.equal(pair.ok, false);
  assert.equal(pair.reason, 'encoding');
  assert.deepEqual(fs.readFileSync(target), before);
});

for (const operation of ['read', 'save']) {
  test('round 5: native realpath blocks injected short metadata spelling on ' + operation, async t => {
    const { dir } = fixture(t);
    const target = path.join(dir, 'GIT~1', 'DESCRI~1');
    fs.mkdirSync(path.dirname(target));
    const before = Buffer.from('metadata bytes\n');
    fs.writeFileSync(target, before);
    const realpathSync = p => fs.realpathSync(p);
    realpathSync.native = () => path.join(dir, '.git', 'description');
    const api = panelHandlers({ ...fs, realpathSync });
    const result = operation === 'read' ? await api.read(target) : await api.save(target, 'overwrite', before.toString('utf8'), { git: false });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'git-dir');
    assert.deepEqual(fs.readFileSync(target), before);
  });
}

test('round 5: real Windows short metadata spelling blocks plain read and every save', { skip: process.platform !== 'win32' }, async t => {
  const { dir, git } = fixture(t);
  git('init', '-q');
  const target = path.join(dir, '.git', 'description');
  const before = fs.readFileSync(target);
  const long = fs.realpathSync.native(target);
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: dir, USERPROFILE: dir };
  const short = execFileSync('cmd.exe', ['/d', '/c', 'for %I in ("' + long + '") do @echo %~sI'], { env, encoding: 'utf8', timeout: 10_000, windowsVerbatimArguments: true }).trim();
  if (short.toLowerCase() === long.toLowerCase() || gitChangesFile.hasGitSegment(short)) {
    t.skip('no short spelling hiding the .git segment is available');
    return;
  }
  assert.equal(fs.realpathSync.native(short).toLowerCase(), long.toLowerCase());
  const api = panelHandlers();
  for (const opts of [undefined, { editor: true }]) {
    assert.equal((await api.read(short, opts)).reason, 'git-dir');
  }
  for (const opts of [undefined, { git: false }, { git: true, version: 'v1' }]) {
    assert.equal((await api.save(short, 'overwrite', before.toString('utf8'), opts)).reason, 'git-dir');
    assert.deepEqual(fs.readFileSync(target), before);
  }
});

test('round 5: saving a deleted file returns the friendly missing-file error', async t => {
  const { dir } = fixture(t);
  const target = path.join(dir, 'file.txt');
  fs.writeFileSync(target, 'before\n');
  const api = panelHandlers();
  const pair = await api.read(target, { editor: true });
  assert.equal(pair.ok, true, pair.error);
  fs.unlinkSync(target);
  for (const opts of [undefined, { git: false }, { git: true, version: 'v1' }]) {
    const result = await api.save(target, 'overwrite', pair.current, opts);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'File does not exist');
    assert.equal(fs.existsSync(target), false);
  }
});

test('round 5: UTF-8 save validation keeps sensitive paths unread', async t => {
  const { dir } = fixture(t);
  const target = path.join(dir, '.env');
  const before = Buffer.from('fixture-only bytes\n');
  fs.writeFileSync(target, before);
  let reads = 0;
  const api = panelHandlers({ ...fs, readFileSync: () => { reads++; throw new Error('sensitive content must not be read'); } });
  for (const opts of [undefined, { git: false }, { git: true, version: 'v1' }]) {
    const result = await api.save(target, 'overwrite', before.toString('utf8'), opts);
    assert.equal(reads, 0);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'access to sensitive path denied');
    assert.deepEqual(fs.readFileSync(target), before);
  }
});
