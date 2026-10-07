'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function loadShipped(filename, imports, platform = 'win32') {
  const module = { exports: {} };
  const shippedRequire = createRequire(path.join(__dirname, '..', filename));
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', filename), 'utf8'), {
    module, exports: module.exports, Buffer, TextDecoder, process: { platform },
    require: name => Object.hasOwn(imports, name) ? imports[name] : shippedRequire(name),
  }, { filename });
  return module.exports;
}

test('round 3: Changes fixtures expand short temporary directory spellings', () => {
  const source = fs.readFileSync(path.join(__dirname, 'git-changes-file-real-git.test.js'), 'utf8');
  const start = source.indexOf('function mkTmp() {');
  const end = source.indexOf('\n}', start) + 2;
  assert.ok(start >= 0 && end > start);
  const short = 'C:\\Users\\RUNNER~1\\Temp\\fixture';
  const canonical = 'C:\\Users\\Runner Administrator\\Temp\\fixture';
  const context = {
    fs: { mkdtempSync: () => short, realpathSync: Object.assign(p => p, { native: () => canonical }) },
    path: path.win32, os: { tmpdir: () => 'C:\\Users\\RUNNER~1\\Temp' },
  };
  assert.equal(vm.runInNewContext(source.slice(start, end) + '\nmkTmp()', context), canonical);
});

test('round 3: Touched fixtures deliberately retain short temporary directory spellings', () => {
  const source = fs.readFileSync(path.join(__dirname, 'git-changes-file-real-git.test.js'), 'utf8');
  const start = source.indexOf('function mkTouchedTmp() {');
  const end = source.indexOf('\n}', start) + 2;
  assert.ok(start >= 0 && end > start);
  const short = 'C:\\Users\\RUNNER~1\\Temp\\fixture';
  const context = {
    fs: { mkdtempSync: () => short, realpathSync: Object.assign(p => p, { native: () => 'C:\\Users\\Runner Administrator\\Temp\\fixture' }) },
    path: path.win32, os: { tmpdir: () => 'C:\\Users\\RUNNER~1\\Temp' },
  };
  assert.equal(vm.runInNewContext(source.slice(start, end) + '\nmkTouchedTmp()', context), short);
});

for (const shortPart of ['file', 'root', 'both', 'case']) {
  test('Touched locally canonicalizes Windows ' + shortPart + ' spellings for HEAD and save without changing shared paths', async () => {
    const root = 'C:\\Users\\Long Profile\\Repo';
    const file = path.win32.join(root, 'f.txt');
    const shortRoot = 'C:\\Users\\LONGPR~1\\Repo';
    const shortFile = path.win32.join(shortRoot, 'f.txt');
    const reportedRoot = shortPart === 'file' || shortPart === 'case' ? root : shortRoot;
    const nativeCalls = [];
    let disk = Buffer.from('current\n');
    const fakeFs = {
      realpathSync: Object.assign(p => p, { native: p => {
        nativeCalls.push(p);
        const expanded = p.replace('LONGPR~1', 'Long Profile');
        return shortPart === 'case' && p.endsWith('f.txt') ? expanded.replace('Users\\Long Profile\\Repo', 'users\\long profile\\repo') : expanded;
      } }),
      lstatSync: () => ({ isSymbolicLink: () => false }),
      statSync: () => ({ isFile: () => true, nlink: 1, size: disk.length }),
      readFileSync: () => disk,
      writeFileSync: (p, bytes) => { assert.equal(p, path.win32.join(reportedRoot, 'f.txt')); disk = bytes; },
    };
    const resolver = loadShipped('resolve-path-on-disk.js', { fs: fakeFs, path: path.win32 });
    const api = loadShipped('git-changes-file.js', {
      fs: fakeFs, path: path.win32, './resolve-path-on-disk': resolver,
      './ipc-path-validator': { isSensitivePath: () => false },
      './session-touched-files': { resolveTouchedPath: p => ({ path: p }) },
    });
    let probes = 0;
    const runGit = async (args, options) => {
      if (args[0] === 'rev-parse') {
        probes++;
        assert.equal(options.cwd, probes % 2 ? path.win32.dirname(absolutePath) : reportedRoot);
        return { code: 0, stdout: reportedRoot + '\n' };
      }
      assert.equal(options.cwd, reportedRoot, 'shared read guards and Git keep the repository spelling');
      assert.deepEqual(Array.from(args), ['cat-file', 'blob', 'HEAD:f.txt']);
      return { code: 0, stdout: Buffer.from('base\n') };
    };
    const absolutePath = shortPart === 'root' || shortPart === 'case' ? file : shortFile;
    const pair = await api.readTouchedChangesFile({ absolutePath, maxBytes: 1024 }, { runGit });
    assert.equal(pair.ok, true, pair.error);
    assert.equal(pair.git, true);
    assert.equal(pair.original, 'base\n');
    assert.equal(pair.current, 'current\n');
    const saved = await api.writeTouchedChangesFile({ absolutePath, content: 'saved\n', version: pair.version, maxBytes: 1024 }, { runGit });
    assert.equal(saved.ok, true, saved.error);
    assert.equal(disk.toString(), 'saved\n');
    assert.ok(nativeCalls.includes(absolutePath));
    assert.ok(nativeCalls.includes(reportedRoot));
  });
}

for (const [platform, pathApi, root, file] of [
  ['win32', path.win32, 'C:\\Users\\Profile\\Repo', 'C:\\users\\profile\\Repo-evil\\f.txt'],
  ['linux', path.posix, '/Repo', '/repo/f.txt'],
]) {
  test('Touched refuses ' + platform + ' containment escapes before shared reads or writes', async () => {
    let writes = 0;
    const fakeFs = {
      realpathSync: Object.assign(p => p, { native: p => p }),
      lstatSync: () => ({ isSymbolicLink: () => false }),
      statSync: () => ({ isFile: () => true, nlink: 1, size: 8 }),
      readFileSync: () => Buffer.from('current\n'),
      writeFileSync: () => { writes++; },
    };
    const api = loadShipped('git-changes-file.js', {
      fs: fakeFs, path: pathApi,
      './resolve-path-on-disk': { resolveOnDisk: p => p, isInsideDir: () => true },
      './ipc-path-validator': { isSensitivePath: () => false },
      './session-touched-files': { resolveTouchedPath: p => ({ path: p }) },
    }, platform);
    const runGit = async args => {
      assert.equal(args[0], 'rev-parse', 'containment must reject before a blob read');
      return { code: 0, stdout: root + '\n' };
    };
    const read = await api.readTouchedChangesFile({ absolutePath: file, maxBytes: 1024 }, { runGit });
    assert.equal(read.reason, 'outside');
    const saved = await api.writeTouchedChangesFile({ absolutePath: file, content: 'saved\n', version: api.versionOf(Buffer.from('current\n')), maxBytes: 1024 }, { runGit });
    assert.equal(saved.reason, 'outside');
    assert.equal(writes, 0);
  });
}

test('Touched refuses a missing short-spelled file without falling back to an editor or saving', async () => {
  const root = 'C:\\Users\\Long Profile\\Repo';
  const file = 'C:\\Users\\LONGPR~1\\Repo\\missing.txt';
  const api = loadShipped('git-changes-file.js', {
    fs: {
      realpathSync: Object.assign(p => p, { native: p => {
        if (p === file) throw Object.assign(new Error('missing file'), { code: 'ENOENT' });
        return p;
      } }),
      lstatSync: () => { throw Object.assign(new Error('missing file'), { code: 'ENOENT' }); },
    },
    path: path.win32,
    './resolve-path-on-disk': { resolveOnDisk: p => p === file ? null : p, isInsideDir: () => true },
    './ipc-path-validator': { isSensitivePath: () => false },
    './session-touched-files': { resolveTouchedPath: p => ({ path: p }) },
  });
  const runGit = async args => {
    assert.equal(args[0], 'rev-parse');
    return { code: 0, stdout: root + '\n' };
  };
  for (const result of [
    await api.readTouchedChangesFile({ absolutePath: file, maxBytes: 1024 }, { runGit }),
    await api.writeTouchedChangesFile({ absolutePath: file, content: 'saved', version: 'v1', maxBytes: 1024 }, { runGit }),
  ]) {
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing');
  }
});

for (const reason of ['repo', 'git-dir']) {
  test('Touched refuses a canonical ' + reason + ' failure before shared reads or writes', async () => {
    const root = 'C:\\Users\\Long Profile\\Repo';
    const file = path.win32.join(root, 'alias', 'config');
    const fakeFs = {
      realpathSync: Object.assign(p => p, { native: p => {
        if (reason === 'repo' && p === root) throw new Error('repository unavailable');
        return reason === 'git-dir' && p === file ? path.win32.join(root, '.git', 'config') : p;
      } }),
      lstatSync: () => ({ isSymbolicLink: () => false }),
    };
    const api = loadShipped('git-changes-file.js', {
      fs: fakeFs, path: path.win32,
      './resolve-path-on-disk': loadShipped('resolve-path-on-disk.js', { fs: fakeFs, path: path.win32 }),
      './ipc-path-validator': { isSensitivePath: () => false },
      './session-touched-files': { resolveTouchedPath: p => ({ path: p }) },
    });
    const runGit = async args => {
      assert.equal(args[0], 'rev-parse');
      return { code: 0, stdout: root + '\n' };
    };
    for (const result of [
      await api.readTouchedChangesFile({ absolutePath: file, maxBytes: 1024 }, { runGit }),
      await api.writeTouchedChangesFile({ absolutePath: file, content: 'saved', version: 'v1', maxBytes: 1024 }, { runGit }),
    ]) {
      assert.equal(result.ok, false);
      assert.equal(result.reason, reason);
    }
  });
}
