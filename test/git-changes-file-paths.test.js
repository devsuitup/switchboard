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

for (const shortPart of ['file', 'root', 'both']) {
  test('round 3: injected Windows short ' + shortPart + ' spelling keeps the HEAD diff and versioned save', async () => {
    const root = 'C:\\Users\\Long Profile\\Repo';
    const file = path.win32.join(root, 'f.txt');
    const shortRoot = 'C:\\Users\\LONGPR~1\\Repo';
    const shortFile = path.win32.join(shortRoot, 'f.txt');
    const nativeCalls = [];
    let disk = Buffer.from('current\n');
    const fakeFs = {
      realpathSync: Object.assign(p => p, { native: p => {
        nativeCalls.push(p);
        return p.replace('LONGPR~1', 'Long Profile');
      } }),
      lstatSync: () => ({ isSymbolicLink: () => false }),
      statSync: () => ({ isFile: () => true, nlink: 1, size: disk.length }),
      readFileSync: () => disk,
      writeFileSync: (p, bytes) => { assert.equal(p, file); disk = bytes; },
    };
    const resolver = loadShipped('resolve-path-on-disk.js', { fs: fakeFs, path: path.win32 });
    const api = loadShipped('git-changes-file.js', {
      fs: fakeFs, path: path.win32, './resolve-path-on-disk': resolver,
      './ipc-path-validator': { isSensitivePath: () => false },
      './session-touched-files': { resolveTouchedPath: p => ({ path: p }) },
    });
    const runGit = async args => {
      if (args[0] === 'rev-parse') return { code: 0, stdout: (shortPart === 'file' ? root : shortRoot) + '\n' };
      assert.deepEqual(Array.from(args), ['cat-file', 'blob', 'HEAD:f.txt']);
      return { code: 0, stdout: Buffer.from('base\n') };
    };
    const absolutePath = shortPart === 'root' ? file : shortFile;
    const pair = await api.readTouchedChangesFile({ absolutePath, maxBytes: 1024 }, { runGit });
    assert.equal(pair.ok, true, pair.error);
    assert.equal(pair.git, true);
    assert.equal(pair.original, 'base\n');
    assert.equal(pair.current, 'current\n');
    const saved = await api.writeTouchedChangesFile({ absolutePath, content: 'saved\n', version: pair.version, maxBytes: 1024 }, { runGit });
    assert.equal(saved.ok, true, saved.error);
    assert.equal(disk.toString(), 'saved\n');
    assert.ok(nativeCalls.includes(absolutePath));
    assert.ok(nativeCalls.includes(shortPart === 'file' ? root : shortRoot));
  });
}

test('round 3: Windows containment ignores case and still refuses a sibling prefix', () => {
  const resolver = loadShipped('resolve-path-on-disk.js', { fs: {}, path: path.win32 });
  assert.equal(resolver.isInsideDir('C:\\users\\profile\\repo\\f.txt', 'C:\\Users\\Profile\\Repo'), true);
  assert.equal(resolver.isInsideDir('C:\\users\\profile\\repo', 'C:\\Users\\Profile\\Repo'), true);
  assert.equal(resolver.isInsideDir('C:\\Users\\Profile\\Repo-evil\\f.txt', 'C:\\Users\\Profile\\Repo'), false);
});

test('round 3: POSIX containment keeps case distinct', () => {
  const resolver = loadShipped('resolve-path-on-disk.js', { fs: {}, path: path.posix }, 'linux');
  assert.equal(resolver.isInsideDir('/repo/file', '/Repo'), false);
});
