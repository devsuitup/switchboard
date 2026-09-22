// Openability of a path matched in terminal output, main-side.
//
// The link provider asks this one question per candidate: may the panel open
// this? Everything the answer depends on — the sensitive-path denylist, the
// session's working directory for a relative path, regular-file-ness, the
// panel's size bound, a NUL byte — is exercised against real files on disk.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveTerminalPathTarget, fileHasNullByte } = require('../terminal-path-target');
const { isSensitivePath } = require('../ipc-path-validator');

const MAX_BYTES = 2 * 1024 * 1024;

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-path-links-'));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(cwd, 'public'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'emptydir'));
  fs.writeFileSync(path.join(cwd, 'public', 'app.js'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(cwd, 'my file.txt'), 'spaced\n');
  fs.writeFileSync(path.join(cwd, '.env'), 'SECRET=1\n');
  fs.writeFileSync(path.join(cwd, 'blob.bin'), Buffer.from([0x61, 0x00, 0x62]));
  fs.writeFileSync(path.join(cwd, 'huge.txt'), Buffer.alloc(MAX_BYTES + 1, 0x61));
  fs.writeFileSync(path.join(home, 'notes.md'), '# notes\n');
  return { root, home, cwd };
}

function deps(home) {
  return {
    isSensitivePath,
    statSync: (p) => fs.statSync(p),
    hasNullByte: fileHasNullByte,
    homedir: () => home,
    maxBytes: MAX_BYTES,
  };
}

const fixture = makeFixture();
test.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

// The matrix. A row added here is covered without anyone remembering to wire it.
const ROWS = [
  { name: 'absolute path to a regular file', text: (f) => path.join(f.cwd, 'public/app.js'), ok: true, resolved: (f) => path.join(f.cwd, 'public/app.js') },
  { name: 'relative path, against the session cwd', text: () => 'public/app.js', ok: true, resolved: (f) => path.join(f.cwd, 'public/app.js') },
  { name: 'dot-relative path', text: () => './public/app.js', ok: true, resolved: (f) => path.join(f.cwd, 'public/app.js') },
  { name: 'tilde path, against the home directory', text: () => '~/notes.md', ok: true, resolved: (f) => path.join(f.home, 'notes.md') },
  { name: 'path with spaces', text: () => 'my file.txt', ok: true, resolved: (f) => path.join(f.cwd, 'my file.txt') },
  { name: 'path that does not exist', text: () => 'public/nope.js', ok: false, reason: 'missing' },
  { name: 'path the guards refuse', text: () => '.env', ok: false, reason: 'sensitive' },
  { name: 'absolute path the guards refuse', text: (f) => path.join(f.cwd, '.env'), ok: false, reason: 'sensitive' },
  { name: 'directory', text: () => 'emptydir', ok: false, reason: 'directory' },
  { name: 'file over the panel size bound', text: () => 'huge.txt', ok: false, reason: 'too-large' },
  { name: 'binary file', text: () => 'blob.bin', ok: false, reason: 'binary' },
  { name: 'empty text', text: () => '', ok: false, reason: 'invalid-path' },
  { name: 'text with a NUL byte', text: () => 'pub\0lic/app.js', ok: false, reason: 'invalid-path' },
  { name: 'text over the length bound', text: () => `a/${'b'.repeat(5000)}`, ok: false, reason: 'invalid-path' },
];

for (const row of ROWS) {
  test(`openability: ${row.name}`, () => {
    const result = resolveTerminalPathTarget(row.text(fixture), fixture.cwd, deps(fixture.home));
    assert.strictEqual(result.ok, row.ok, JSON.stringify(result));
    if (row.ok) assert.strictEqual(result.path, row.resolved(fixture));
    else assert.strictEqual(result.reason, row.reason);
  });
}

test('a relative path with no session cwd is refused, never resolved against the app cwd', () => {
  const result = resolveTerminalPathTarget('public/app.js', null, deps(fixture.home));
  assert.deepStrictEqual(result, { ok: false, reason: 'no-cwd' });
});

test('an absolute path still resolves when the session cwd is unknown', () => {
  const abs = path.join(fixture.cwd, 'public/app.js');
  assert.deepStrictEqual(resolveTerminalPathTarget(abs, null, deps(fixture.home)), { ok: true, path: abs });
});

test('a symlink into a sensitive location is refused on its resolved target', () => {
  const link = path.join(fixture.cwd, 'innocent.txt');
  fs.symlinkSync(path.join(fixture.cwd, '.env'), link);
  try {
    const result = resolveTerminalPathTarget('innocent.txt', fixture.cwd, deps(fixture.home));
    assert.deepStrictEqual(result, { ok: false, reason: 'sensitive' });
  } finally {
    fs.unlinkSync(link);
  }
});

test('the resolved path is the one the panel is handed, not the text that was matched', () => {
  const result = resolveTerminalPathTarget('public/../public/app.js', fixture.cwd, deps(fixture.home));
  assert.deepStrictEqual(result, { ok: true, path: path.join(fixture.cwd, 'public', 'app.js') });
});

test('fileHasNullByte reports true for an unreadable path rather than letting it through', () => {
  assert.strictEqual(fileHasNullByte(path.join(fixture.cwd, 'does-not-exist')), true);
});
