'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { stripExtendedPrefix } = require('../resolve-path-on-disk');
const { isSensitivePath, isSensitivePathAsync } = require('../ipc-path-validator');

const BS = String.fromCharCode(92);
const EXT = BS + BS + '?' + BS;
const DEV = BS + BS + '.' + BS;

test('stripExtendedPrefix drops the \\\\?\\ and \\\\.\\ drive prefixes', () => {
  assert.strictEqual(stripExtendedPrefix(EXT + 'C:' + BS + 'a' + BS + 'b'), 'C:' + BS + 'a' + BS + 'b');
  assert.strictEqual(stripExtendedPrefix(DEV + 'C:' + BS + 'a'), 'C:' + BS + 'a');
});

test('stripExtendedPrefix turns \\\\?\\UNC\\host\\share into \\\\host\\share, whatever the case', () => {
  assert.strictEqual(stripExtendedPrefix(EXT + 'UNC' + BS + 'h' + BS + 's' + BS + 'a'), BS + BS + 'h' + BS + 's' + BS + 'a');
  assert.strictEqual(stripExtendedPrefix(EXT + 'unc' + BS + 'h' + BS + 's'), BS + BS + 'h' + BS + 's');
});

test('stripExtendedPrefix leaves ordinary, relative and plain UNC paths alone', () => {
  for (const p of ['C:' + BS + 'a', 'a' + BS + 'b', BS + BS + 'h' + BS + 's' + BS + 'a', '/home/u/.ssh/k', '']) {
    assert.strictEqual(stripExtendedPrefix(p), p);
  }
});

const win = process.platform === 'win32';

function shortPathOf(dir) {
  const out = execFileSync('powershell', [
    '-NoProfile', '-Command',
    '(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:SB_P).ShortPath',
  ], { encoding: 'utf8', env: { ...process.env, SB_P: dir }, timeout: 30000 });
  return out.trim();
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-sens-'));
const realRoot = fs.realpathSync.native(root);
const sshDir = path.join(realRoot, '.ssh');
fs.mkdirSync(sshDir);
fs.writeFileSync(path.join(sshDir, 'id_rsa'), 'key\n');

let shortSsh = null;
let junction = null;
if (win) {
  try {
    const s = shortPathOf(sshDir);
    if (s && s.toLowerCase() !== sshDir.toLowerCase() && fs.existsSync(path.join(s, 'id_rsa'))) shortSsh = s;
  } catch {}
  const j = path.join(realRoot, 'notes');
  try { fs.symlinkSync(sshDir, j, 'junction'); junction = j; } catch {}
}

test.after(() => {
  if (junction) fs.rmdirSync(junction);
  fs.rmSync(root, { recursive: true, force: true });
});

const bothGuards = async (p) => [isSensitivePath(p), await isSensitivePathAsync(p)];

test('a plain file next to the credential directory stays allowed', async () => {
  const ok = path.join(realRoot, 'plain.txt');
  fs.writeFileSync(ok, 'x\n');
  assert.deepStrictEqual(await bothGuards(ok), [false, false]);
});

test('an 8.3 short name for a credential directory is refused by both guards',
  { skip: !win ? 'win32 only' : !shortSsh && 'this volume generates no 8.3 short names' },
  async () => {
    assert.deepStrictEqual(await bothGuards(path.join(shortSsh, 'id_rsa')), [true, true]);
  });

test('an 8.3 short name for a credential directory is refused for a file not created yet',
  { skip: !win ? 'win32 only' : !shortSsh && 'this volume generates no 8.3 short names' },
  async () => {
    assert.deepStrictEqual(await bothGuards(path.join(shortSsh, 'not-yet')), [true, true]);
  });

test('a \\\\?\\ path through a junction into a credential directory is refused by both guards',
  { skip: !win ? 'win32 only' : !junction && 'cannot create a junction here' },
  async () => {
    assert.deepStrictEqual(await bothGuards(EXT + path.join(junction, 'id_rsa')), [true, true]);
  });

test('a \\\\?\\ path through a junction is still refused when only the JS realpath can resolve it',
  { skip: !win ? 'win32 only' : !junction && 'cannot create a junction here' },
  async () => {
    const nativeSync = fs.realpathSync.native;
    const nativeAsync = fs.realpath.native;
    const missing = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
    fs.realpathSync.native = missing;
    fs.realpath.native = (p, cb) => cb(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    try {
      assert.deepStrictEqual(await bothGuards(EXT + path.join(junction, 'id_rsa')), [true, true]);
    } finally {
      fs.realpathSync.native = nativeSync;
      fs.realpath.native = nativeAsync;
    }
  });

test('a \\\\?\\ path with an 8.3 credential directory is refused by both guards',
  { skip: !win ? 'win32 only' : !shortSsh && 'this volume generates no 8.3 short names' },
  async () => {
    assert.deepStrictEqual(await bothGuards(EXT + path.join(shortSsh, 'id_rsa')), [true, true]);
  });

test('a \\\\?\\ path to an ordinary file is not refused', { skip: !win && 'win32 only' }, async () => {
  assert.deepStrictEqual(await bothGuards(EXT + path.join(realRoot, 'plain.txt')), [false, false]);
});

test('a realpath failure other than "does not exist" fails closed in both guards', { skip: !win && 'win32 only' }, async () => {
  const target = path.join(realRoot, 'plain.txt');
  const fail = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
  const realSync = fs.realpathSync;
  const nativeSync = fs.realpathSync.native;
  const realAsync = fs.realpath;
  const nativeAsync = fs.realpath.native;
  const failCb = (p, cb) => cb(Object.assign(new Error('denied'), { code: 'EACCES' }));
  fs.realpathSync = Object.assign(fail, { native: fail });
  fs.realpath = Object.assign(failCb, { native: failCb });
  try {
    assert.strictEqual(isSensitivePath(target), true);
    assert.strictEqual(await isSensitivePathAsync(target), true);
  } finally {
    fs.realpathSync = Object.assign(realSync, { native: nativeSync });
    fs.realpath = Object.assign(realAsync, { native: nativeAsync });
  }
});

test('a missing path under an ordinary directory is not refused for failing to resolve', { skip: !win && 'win32 only' }, async () => {
  const missing = path.join(realRoot, 'nowhere', 'file.txt');
  assert.deepStrictEqual(await bothGuards(missing), [false, false]);
});

test('a failure of one realpath fails closed even when the other resolves', { skip: !win && 'win32 only' }, async () => {
  const target = path.join(realRoot, 'plain.txt');
  const nativeSync = fs.realpathSync.native;
  const nativeAsync = fs.realpath.native;
  fs.realpathSync.native = () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); };
  fs.realpath.native = (p, cb) => cb(Object.assign(new Error('denied'), { code: 'EPERM' }));
  try {
    assert.deepStrictEqual(await bothGuards(target), [true, true]);
  } finally {
    fs.realpathSync.native = nativeSync;
    fs.realpath.native = nativeAsync;
  }
});

test('trailing dots and spaces on a credential name are refused by both guards', { skip: !win && 'win32 only' }, async () => {
  for (const name of [path.join('.ssh.', 'id_rsa'), '.git-credentials.', '.netrc ', path.join('.ssh. ', 'x')]) {
    assert.deepStrictEqual(await bothGuards(path.join(realRoot, name)), [true, true], name);
  }
});

test('stripTrailingDotsAndSpaces trims each segment and keeps the root', { skip: !win && 'win32 only' }, () => {
  const { stripTrailingDotsAndSpaces } = require('../resolve-path-on-disk');
  assert.strictEqual(stripTrailingDotsAndSpaces('C:' + BS + 'a. ' + BS + 'b.' + BS + 'c '), 'C:' + BS + 'a' + BS + 'b' + BS + 'c');
});

test('a missing file is resolved with a bounded number of realpath calls', { skip: !win && 'win32 only' }, () => {
  const real = fs.realpathSync;
  const nativeSync = real.native;
  let calls = 0;
  const count = (fn) => Object.assign((...a) => { calls++; return fn(...a); }, { native: nativeSync });
  fs.realpathSync = count(real);
  fs.realpathSync.native = (...a) => { calls++; return nativeSync(...a); };
  try {
    isSensitivePath(path.join(realRoot, 'a', 'b', 'c', 'd', 'e', 'f', 'file.txt'));
  } finally {
    fs.realpathSync = Object.assign(real, { native: nativeSync });
  }
  assert.ok(calls <= 6, 'realpath calls: ' + calls);
});

test('trailing dots on a credential name are refused behind a \\.\ prefix, which Win32 still normalises', { skip: !win && 'win32 only' }, async () => {
  const drive = realRoot.slice(0, 2);
  const rest = realRoot.slice(2);
  const spellings = [
    DEV + path.join(realRoot, '.ssh.', 'id_rsa'),
    '//./' + path.join(realRoot, '.git-credentials.').split(BS).join('/'),
    DEV + 'UNC' + BS + 'localhost' + BS + drive[0] + '$' + path.join(rest, '.ssh.', 'id_rsa'),
  ];
  for (const p of spellings) {
    assert.deepStrictEqual(await bothGuards(p), [true, true], p);
  }
});

test('trailing dots are not trimmed behind a \\?\ prefix, which Win32 does not normalise', { skip: !win && 'win32 only' }, async () => {
  const p = EXT + path.join(realRoot, 'notes.');
  assert.deepStrictEqual(await bothGuards(p), [false, false]);
});
