const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const filename = path.resolve(__dirname, '../scripts/postinstall.js');
const source = fs.readFileSync(filename, 'utf8');
const realRequire = createRequire(filename);
const SPECIAL_NAMES = ['some file.node', 'some"file.node', 'native\\addon.node', '$(touch injected).node'];

function loadPostinstall({ main = false, platform = 'darwin', failInstall = false, failFallback = false, failSign = false, realFs = false } = {}) {
  const calls = [];
  const env = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'test-session', PATH: 'test-path' };
  const module = { exports: {} };
  const nativeDir = path.resolve(path.dirname(filename), '../node_modules');
  const spawnDir = path.join(nativeDir, 'node-pty', 'prebuilds');
  const fakeFs = {
    readdirSync(dir) {
      const names = dir === nativeDir ? SPECIAL_NAMES : dir === spawnDir ? ['spawn-helper'] : [];
      return names.map(name => ({ name, isDirectory: () => false }));
    },
    existsSync: dir => dir === spawnDir,
    chmodSync: (...args) => calls.push(['chmodSync', ...args]),
  };
  function requireStub(id) {
    if (id === 'child_process') return {
      execSync(...args) {
        calls.push(['execSync', ...args]);
        if (failInstall && args[0] === 'npx electron-builder install-app-deps') throw new Error('install failed');
        if (failFallback && args[0] === 'npx @electron/rebuild -f -m . -o better-sqlite3') throw new Error('fallback failed');
      },
      execFileSync(...args) {
        calls.push(['execFileSync', ...args]);
        if (failSign) throw new Error('sign failed');
      },
    };
    if (id === 'fs') return realFs ? fs : fakeFs;
    return realRequire(id);
  }
  requireStub.main = main ? module : {};
  vm.runInNewContext(source, {
    require: requireStub, module, __dirname: path.dirname(filename),
    process: { platform, env }, console: { log() {}, error() {} },
  }, { filename });
  return { calls: JSON.parse(JSON.stringify(calls)), env, exports: module.exports, nativeDir, spawnDir };
}

test('running postinstall passes every native path as a literal codesign argument', () => {
  const { calls, nativeDir } = loadPostinstall({ main: true });
  const signing = calls.filter(call => call[1].startsWith('codesign'));
  assert.deepEqual(signing, SPECIAL_NAMES.map(name => [
    'execFileSync', 'codesign', ['--sign', '-', '--force', path.join(nativeDir, name)], { stdio: 'ignore' },
  ]));
});

test('requiring postinstall performs no installation, signing, chmod or environment mutation', () => {
  const { calls } = loadPostinstall();
  assert.deepEqual(calls, []);
});

test('requiring postinstall preserves every environment variable', () => {
  const { env } = loadPostinstall();
  assert.deepEqual(env, { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'test-session', PATH: 'test-path' });
});

test('running postinstall scrubs session markers and preserves the Windows signing skip', () => {
  const { calls, env } = loadPostinstall({ main: true, platform: 'win32' });
  assert.deepEqual(env, { PATH: 'test-path' });
  assert.deepEqual(calls, [['execSync', 'npx electron-builder install-app-deps', { stdio: 'inherit' }]]);
});

test('running postinstall preserves fallback rebuild and permission repair when signing fails', () => {
  const { calls, spawnDir } = loadPostinstall({ main: true, failInstall: true, failFallback: true, failSign: true });
  assert.deepEqual(calls.slice(0, 2), [
    ['execSync', 'npx electron-builder install-app-deps', { stdio: 'inherit' }],
    ['execSync', 'npx @electron/rebuild -f -m . -o better-sqlite3', { stdio: 'inherit' }],
  ]);
  assert.equal(calls.filter(call => call[0] === 'execFileSync').length, SPECIAL_NAMES.length);
  assert.deepEqual(calls.at(-1), ['chmodSync', path.join(spawnDir, 'spawn-helper'), 0o755]);
});

for (const name of SPECIAL_NAMES) {
  test(`findFiles preserves the exact filename: ${name}`, {
    skip: process.platform === 'win32' && /["\\]/.test(name),
  }, () => {
    const { exports: { findFiles } } = loadPostinstall({ realFs: true });
    assert.equal(typeof findFiles, 'function');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postinstall-test-'));
    try {
      const expected = path.join(dir, name);
      fs.writeFileSync(expected, '');
      assert.deepEqual([...findFiles(dir, '.node')], [expected]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`codesignFile preserves the exact signer argument: ${name}`, () => {
    const { exports: { codesignFile } } = loadPostinstall();
    assert.equal(typeof codesignFile, 'function');
    const file = path.join(os.tmpdir(), name);
    const calls = [];
    codesignFile(file, (...args) => calls.push(args));
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
      ['codesign', ['--sign', '-', '--force', file], { stdio: 'ignore' }],
    ]);
  });
}

test('findFiles descends into directories containing a backslash', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postinstall-test-'));
  try {
    const subdir = path.join(dir, 'sub\\dir');
    fs.mkdirSync(subdir);
    const expected = path.join(subdir, 'addon.node');
    fs.writeFileSync(expected, '');
    const { exports: { findFiles } } = loadPostinstall({ realFs: true });
    assert.deepEqual([...findFiles(dir, '.node')], [expected]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
