'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveOnDisk, resolveOnDiskAsync } = require('../resolve-path-on-disk');
const { isSensitivePath, isSensitivePathAsync } = require('../ipc-path-validator');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ondisk-')));
const sshDir = path.join(root, '.ssh');
fs.mkdirSync(sshDir);
fs.writeFileSync(path.join(sshDir, 'k'), 'key\n');
fs.mkdirSync(path.join(root, 'sub'));
fs.writeFileSync(path.join(root, 'sub', 'file.txt'), 'x\n');

let linked = false;
const link = path.join(root, 'notes');
for (const type of ['dir', 'junction']) {
  try { fs.symlinkSync(sshDir, link, type); linked = true; break; } catch {}
}
test.after(() => {
  if (linked) { try { fs.rmdirSync(link); } catch { fs.unlinkSync(link); } }
  fs.rmSync(root, { recursive: true, force: true });
});

const PATHS = () => [
  path.join(root, 'sub', 'file.txt'),
  path.join(root, 'sub', 'missing.txt'),
  path.join(root, 'sub', '..', 'sub', 'file.txt'),
  path.join(root, 'sub', '..', '..', path.basename(root), 'sub'),
  path.join(link, 'k'),
  link,
];

test('resolveOnDiskAsync returns what resolveOnDisk returns for each path', async () => {
  for (const p of PATHS()) {
    assert.strictEqual(await resolveOnDiskAsync(p), resolveOnDisk(p), p);
  }
});

test('resolveOnDiskAsync walks with the same realpath as resolveOnDisk, not the native one', async () => {
  const real = fs.realpath;
  const promised = fs.promises.realpath;
  const native = fs.realpath.native;
  const seen = { js: 0, promises: 0, native: 0 };
  fs.realpath = Object.assign((...a) => { seen.js++; return real(...a); }, { native });
  fs.realpath.native = (...a) => { seen.native++; return native(...a); };
  fs.promises.realpath = (...a) => { seen.promises++; return promised(...a); };
  try {
    await resolveOnDiskAsync(path.join(root, 'sub', 'file.txt'));
  } finally {
    fs.realpath = real;
    fs.realpath.native = native;
    fs.promises.realpath = promised;
  }
  assert.deepStrictEqual(seen, { js: 1, promises: 0, native: 0 });
});

test('isSensitivePathAsync agrees with isSensitivePath on every path', async () => {
  for (const p of PATHS()) {
    assert.strictEqual(await isSensitivePathAsync(p), isSensitivePath(p), p);
  }
});

test('isSensitivePathAsync refuses a literal credential path and allows a plain one', async () => {
  assert.strictEqual(await isSensitivePathAsync(path.join(sshDir, 'k')), true);
  assert.strictEqual(await isSensitivePathAsync(path.join(root, 'sub', 'file.txt')), false);
});

test('isSensitivePathAsync refuses a link into a credential directory on its resolved target', { skip: !linked && 'cannot create a link here' }, async () => {
  assert.strictEqual(await isSensitivePathAsync(path.join(link, 'k')), true);
});
