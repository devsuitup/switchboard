'use strict';

// Guards for the editable Changes panel's two IPCs (git-changes-file /
// git-changes-save). The `<rev>:<path>` operand is a revision, not a
// pathspec, so it carries its own guard — see .ai/contexts/changes-view.md
// ("Editing a changed file").

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isSafeRepoRelativePath,
  isSafeRevPathOperand,
  buildBlobRev,
  requireLocalTarget,
} = require('../git-changes-file');

const ADVERSARIAL = [
  ['', 'the empty string'],
  ['../../etc/passwd', 'a traversal'],
  ['a/../../b', 'a traversal in the middle'],
  ['/etc/passwd', 'an absolute POSIX path'],
  ['\\\\server\\share\\x', 'a UNC path'],
  ['C:\\Windows\\win.ini', 'a Windows absolute path'],
  ['src/a\nb.js', 'an embedded newline'],
  ['src/a\rb.js', 'an embedded carriage return'],
  ['src/a\u0000b.js', 'an embedded NUL'],
  ['-rf', 'a leading dash (an option to git)'],
  [':(exclude)src', 'pathspec magic'],
  [':/etc/passwd', 'a leading colon'],
];

for (const [value, label] of ADVERSARIAL) {
  test(`isSafeRepoRelativePath rejects ${label}`, () => {
    assert.equal(isSafeRepoRelativePath(value), false, JSON.stringify(value));
  });
  test(`isSafeRevPathOperand rejects ${label}`, () => {
    assert.equal(isSafeRevPathOperand(value), false, JSON.stringify(value));
  });
}

test('isSafeRepoRelativePath rejects a non-string and an over-long path', () => {
  assert.equal(isSafeRepoRelativePath(null), false);
  assert.equal(isSafeRepoRelativePath(42), false);
  assert.equal(isSafeRepoRelativePath(undefined), false);
  assert.equal(isSafeRepoRelativePath('a'.repeat(4097)), false);
});

test('isSafeRepoRelativePath accepts the ordinary paths git status reports', () => {
  for (const p of ['a.txt', 'src/a.js', 'dir with spaces/b.md', 'café.txt', 'a$(b)`c`.txt', 'x.1']) {
    assert.equal(isSafeRepoRelativePath(p), true, p);
    assert.equal(isSafeRevPathOperand(p), true, p);
  }
});

// `.git/config` carries core.pager and [alias]: writing it is command execution.
test('both guards reject any .git segment, in any case and at any depth (mutation target: the .git check)', () => {
  for (const p of ['.git', '.git/config', '.git/hooks/pre-commit', '.GIT/config', 'sub/.git/config', 'sub/.Git/x', '.git\\\\config']) {
    assert.equal(isSafeRepoRelativePath(p), false, p);
    assert.equal(isSafeRevPathOperand(p), false, p);
  }
});

// `..` is a path segment, not a substring: a file may legitimately be named a..b.
test('the traversal check is a segment check, so an ordinary file with two dots in its name is editable', () => {
  for (const p of ['schema..v2.sql', 'a..b.txt', 'dir/x..y']) {
    assert.equal(isSafeRepoRelativePath(p), true, p);
    assert.equal(isSafeRevPathOperand(p), true, p);
  }
  for (const p of ['..', 'a/..', '../x', 'a/../../b', 'a\\\\..\\\\b']) {
    assert.equal(isSafeRepoRelativePath(p), false, p);
    assert.equal(isSafeRevPathOperand(p), false, p);
  }
});

// `git show :1:f.txt` reads stage 1 of a conflicted path — a second layer of
// revision syntax hiding inside what the renderer called a file path.
test('isSafeRevPathOperand rejects the `:<n>:<path>` stage syntax that isSafeRepoRelativePath alone allows', () => {
  assert.equal(isSafeRepoRelativePath('1:f.txt'), true, 'a file literally named "1:f.txt" is a legal filesystem path');
  assert.equal(isSafeRevPathOperand('1:f.txt'), false);
  assert.equal(isSafeRevPathOperand('23:f.txt'), false);
});

test('requireLocalTarget refuses a remote session and passes a local one through (mutation target: the remote-write refusal)', () => {
  const remote = requireLocalTarget({ ok: true, kind: 'remote', alias: 'box', cwd: '/srv/app' });
  assert.equal(remote.ok, false);
  assert.equal(remote.reason, 'remote');
  assert.ok(!('cwd' in remote), 'a refused target hands back no working directory');

  const local = { ok: true, kind: 'local', cwd: '/home/u/repo' };
  assert.equal(requireLocalTarget(local), local);

  const unresolved = { ok: false, error: 'invalid session id' };
  assert.equal(requireLocalTarget(unresolved), unresolved, 'an unresolved target keeps its own error');
});

test('buildBlobRev names the index for the unstaged view and HEAD for the staged one', () => {
  assert.equal(buildBlobRev('src/a.js', false), ':src/a.js');
  assert.equal(buildBlobRev('src/a.js', true), 'HEAD:src/a.js');
});
