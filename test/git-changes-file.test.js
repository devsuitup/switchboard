'use strict';

// Guards for the editable Changes panel's two IPCs (git-changes-file /
// git-changes-save). The `<rev>:<path>` operand is a revision, not a
// pathspec, so it carries its own guard — see .ai/contexts/changes-view.md
// ("Editing a changed file").

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// main.js cannot be required from a test, so the wiring that keeps a remote
// session out of a local-only handler is asserted against its source, with
// commented-out lines dropped first — the same instrument, and the same
// limitation, as test/git-changes-watch.test.js.
function mainSource() {
  return fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8').replace(/^[ \t]*\/\/.*$/gm, '');
}

function handlerBody(source, channel) {
  const start = source.indexOf(`ipcMain.handle('${channel}'`);
  assert.notEqual(start, -1, `${channel} must be handled`);
  return source.slice(start, source.indexOf('\n});', start));
}

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

// --- The local-only handlers, all four of them ---------------------------

test('every Changes handler that touches the filesystem refuses a remote session (mutation target: the wiring)', () => {
  const main = mainSource();
  for (const channel of ['git-changes-file', 'git-changes-save', 'git-changes-watch']) {
    const body = handlerBody(main, channel);
    assert.match(body, /requireLocalTarget\(resolveGitChangesTarget\(sessionId\)\)/,
      `${channel} must resolve the session through the local-only guard`);
    assert.match(body, /if \(!target\.ok\) return target;/,
      `${channel} must hand back the guard's own refusal`);
  }
});

test('only the read-only status and diff handlers admit a subagent id (mutation target: the wiring)', () => {
  const main = mainSource();
  for (const channel of ['git-changes-status', 'git-changes-diff']) {
    assert.match(handlerBody(main, channel), /resolveGitChangesTarget\(sessionId, \{ allowSubagent: true \}\)/,
      `${channel} must opt in to a subagent id`);
  }
  for (const channel of ['git-changes-file', 'git-changes-save', 'git-changes-watch']) {
    assert.doesNotMatch(handlerBody(main, channel), /allowSubagent/, `${channel} must keep refusing a subagent id`);
  }
  assert.match(main, /readSubagentMeta/, 'main must inject the sidecar reader');
  assert.match(main, /hardened: !!target[.]subagent/, 'a subagent target runs a hardened runner');
  assert.match(handlerBody(main, 'git-changes-status'), /hardened: true/, 'the groups of a status reply run hardened runners');
  for (const channel of ['git-changes-status', 'git-changes-diff']) {
    assert.match(handlerBody(main, channel), /await gitChangesTarget[.]checkSubagentRepo[(]sessionId, resolved/,
      `${channel} must check a subagent worktree belongs to the session repository`);
  }
  const status = handlerBody(main, 'git-changes-status');
  assert.match(status, /await gitChangesTarget.listSubagentWorktrees\(sessionId/, 'the status handler lists the parent subagent worktrees');
  assert.match(status, /collectSubagentChanges\(/, 'and attaches their changes to the result');
});

test('Touched rejects invalid absolute paths before asking git', async () => {
  const { readTouchedChangesFile, writeTouchedChangesFile } = require('../git-changes-file');
  const deps = { runGit: () => { throw new Error('git must not run'); } };
  for (const absolutePath of ['', 'relative.txt', null, path.resolve(ROOT, 'control\nfile')]) {
    const read = await readTouchedChangesFile({ absolutePath, maxBytes: 1024 }, deps);
    assert.equal(read.reason, 'invalid-path');
    const write = await writeTouchedChangesFile({ absolutePath, content: 'x', version: 'v1', maxBytes: 1024 }, deps);
    assert.equal(write.reason, 'invalid-path');
  }
});

test('Touched falls back on a failed git transport but refuses other git errors', async () => {
  const { readTouchedChangesFile } = require('../git-changes-file');
  for (const code of [-1, 1, 128]) {
    const result = await readTouchedChangesFile({ absolutePath: path.join(ROOT, 'example.txt'), maxBytes: 1024 }, {
      runGit: async () => ({ code, stdout: '', stderr: 'probe failed' }),
    });
    assert.equal(result.ok, code === -1);
    if (code === -1) assert.equal(result.git, false);
    else assert.equal(result.reason, 'git');
  }
});

test('Touched refuses a sensitive path before asking git', async () => {
  const { readTouchedChangesFile, writeTouchedChangesFile } = require('../git-changes-file');
  const absolutePath = path.join(ROOT, '.ssh', 'credential');
  let calls = 0;
  const deps = { runGit: async () => { calls++; return { code: 128 }; } };
  assert.equal((await readTouchedChangesFile({ absolutePath, maxBytes: 1024 }, deps)).reason, 'sensitive');
  assert.equal((await writeTouchedChangesFile({ absolutePath, content: 'x', version: 'v1', maxBytes: 1024 }, deps)).reason, 'sensitive');
  assert.equal(calls, 0);
});

test('round 2: Touched refuses any literal git directory before probing on read and write', async () => {
  const { readTouchedChangesFile, writeTouchedChangesFile } = require('../git-changes-file');
  for (const absolutePath of ['.git/config', '.GIT/config', 'sub/.Git/config'].map(name => path.join(ROOT, name)).concat(ROOT + '/.git/../example.txt')) {
    let calls = 0;
    const deps = { runGit: async () => { calls++; return { code: 128, stderr: 'fatal: not a git repository' }; } };
    assert.equal((await readTouchedChangesFile({ absolutePath, maxBytes: 1024 }, deps)).reason, 'git-dir');
    assert.equal((await writeTouchedChangesFile({ absolutePath, content: 'overwrite', version: 'v1', maxBytes: 1024 }, deps)).reason, 'git-dir');
    assert.equal(calls, 0);
  }
});

test('round 2: a not-a-repository diagnostic permits plain fallback', async () => {
  const result = await require('../git-changes-file').readTouchedChangesFile({ absolutePath: path.join(ROOT, 'example.txt'), maxBytes: 1024 }, {
    runGit: async () => ({ code: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git' }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.git, false);
});

test('round 3: a Touched file symlink selects read-only plain content before probing git', async () => {
  const absolutePath = path.join(ROOT, 'git-changes-file.js');
  const deps = { fs: { lstatSync: () => ({ isSymbolicLink: () => true }) }, runGit: () => { throw new Error('git must not run'); } };
  const read = await require('../git-changes-file').readTouchedChangesFile({ absolutePath, maxBytes: 1024 }, deps);
  assert.equal(read.ok, true);
  assert.equal(read.git, false);
  assert.equal(read.readOnly, true);
});

test('round 2: a vanished repository root is refused without plain fallback', async () => {
  const absolutePath = path.join(ROOT, 'git-changes-file.js');
  const deps = { runGit: async () => ({ code: 0, stdout: path.join(ROOT, 'does-not-exist-round-two') + '\n', stderr: '' }) };
  const result = await require('../git-changes-file').readTouchedChangesFile({ absolutePath, maxBytes: 1024 }, deps);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'repo');
});
