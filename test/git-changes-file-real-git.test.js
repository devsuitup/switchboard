'use strict';

// A real, on-disk git repository — no injected exec, no fakes: the content
// pair and the write target of the editable Changes panel, measured against
// the git binary and the filesystem they will meet in production.
// See .ai/contexts/changes-view.md ("Editing a changed file").

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const { readChangesFile, writeChangesFile } = require('../git-changes-file');

// git translates its diagnostics; the assertions below match its English text.
process.env.LC_ALL = 'C';
process.env.LANGUAGE = 'C';

const MAX_BYTES = 1024 * 1024;

function mkTmp() {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-gcf-real-')));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// Scratch repo only: drop the caller's GIT_* env (set when this suite runs under a hook) and its hooks.
function scratchGitEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('GIT_') || k.startsWith('HUSKY')) continue;
    env[k] = v;
  }
  return env;
}

function git(cwd, args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', env: scratchGitEnv() });
}

// committed → indexed → working tree, so the three sides are distinguishable.
function initRepo(repoDir) {
  fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, ['init', '-q']);
  git(repoDir, ['config', 'user.email', 'a@a.com']);
  git(repoDir, ['config', 'user.name', 'a']);
  fs.writeFileSync(path.join(repoDir, 'f.txt'), 'committed\n');
  git(repoDir, ['add', 'f.txt']);
  git(repoDir, ['commit', '-q', '-m', 'first commit about SECRETWORD']);
  fs.writeFileSync(path.join(repoDir, 'f.txt'), 'indexed\n');
  git(repoDir, ['add', 'f.txt']);
  fs.writeFileSync(path.join(repoDir, 'f.txt'), 'worktree\n');
}

function read(repoDir, relPath, staged) {
  return readChangesFile({ cwd: repoDir, relPath, staged: !!staged, maxBytes: MAX_BYTES });
}

// --- The content pair ---------------------------------------------------

test('real git: the unstaged view pairs the index blob with the working tree', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);

    const result = await read(repoDir, 'f.txt', false);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.original, 'indexed\n', 'the unstaged diff compares against the index, so the editor must too');
    assert.equal(result.current, 'worktree\n');
    assert.equal(result.binary, false);
    assert.equal(result.truncated, false);
  } finally { cleanup(tmp); }
});

test('real git: the staged view pairs the HEAD blob with the working tree', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);

    const result = await read(repoDir, 'f.txt', true);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.original, 'committed\n');
    assert.equal(result.current, 'worktree\n');
  } finally { cleanup(tmp); }
});

test('real git: a path absent from the tree is a new file — empty original, not an error (exit 128 is the untracked case)', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    fs.writeFileSync(path.join(repoDir, 'new.txt'), 'brand new\n');

    // The exit code real git returns for a path that is not in the index, pinned.
    const raw = spawnSync('git', ['cat-file', 'blob', ':new.txt'], { cwd: repoDir, encoding: 'utf8', env: scratchGitEnv() });
    assert.equal(raw.status, 128);
    assert.match(raw.stderr, /not in the index/);

    const result = await read(repoDir, 'new.txt', false);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.original, '', 'an untracked file has no original side');
    assert.equal(result.current, 'brand new\n');
  } finally { cleanup(tmp); }
});

test('real git: a session cwd below the repository root still resolves the root-relative paths git status reports', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    fs.mkdirSync(path.join(repoDir, 'sub'));
    fs.writeFileSync(path.join(repoDir, 'sub', 's.txt'), 'sub content\n');

    const result = await readChangesFile({ cwd: path.join(repoDir, 'sub'), relPath: 'sub/s.txt', staged: false, maxBytes: MAX_BYTES });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.current, 'sub content\n');
  } finally { cleanup(tmp); }
});

// --- Why `git cat-file blob`, not `git show` ----------------------------

test('real git: `git show :/<text>` prints a whole commit while `git cat-file blob` refuses it — the reason the blob is read type-constrained', () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);

    const shown = spawnSync('git', ['show', ':/SECRETWORD'], { cwd: repoDir, encoding: 'utf8', env: scratchGitEnv() });
    assert.equal(shown.status, 0, 'git show resolves :/<text> as a commit-message search');
    assert.match(shown.stdout, /^commit [0-9a-f]{40}/, 'git show would hand the panel a commit object as "file content"');

    const catFile = spawnSync('git', ['cat-file', 'blob', ':/SECRETWORD'], { cwd: repoDir, encoding: 'utf8', env: scratchGitEnv() });
    assert.notEqual(catFile.status, 0, 'cat-file blob refuses an object that is not a blob');
    assert.equal(catFile.stdout, '');

    // The same asymmetry for a directory: a tree listing vs a refusal.
    const showTree = spawnSync('git', ['show', 'HEAD:'], { cwd: repoDir, encoding: 'utf8', env: scratchGitEnv() });
    assert.equal(showTree.status, 0);
    assert.match(showTree.stdout, /^tree HEAD:/);
    const catTree = spawnSync('git', ['cat-file', 'blob', 'HEAD:'], { cwd: repoDir, encoding: 'utf8', env: scratchGitEnv() });
    assert.notEqual(catTree.status, 0);
  } finally { cleanup(tmp); }
});

// --- Caps ---------------------------------------------------------------

test('real git: a binary working-tree file is refused as binary, and says so', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    fs.writeFileSync(path.join(repoDir, 'bin.dat'), Buffer.from([0, 1, 2, 0, 3, 255]));

    const result = await read(repoDir, 'bin.dat', false);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'binary', 'the panel has to tell a binary file apart from an oversized one');
  } finally { cleanup(tmp); }
});

test('real git: a file over the cap is refused as too large, and says so', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    fs.writeFileSync(path.join(repoDir, 'big.txt'), 'x'.repeat(2048));

    const result = await readChangesFile({ cwd: repoDir, relPath: 'big.txt', staged: false, maxBytes: 1024 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'too-large');
  } finally { cleanup(tmp); }
});

test('real git: a blob over the cap is refused too, even when the working-tree side fits', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    fs.writeFileSync(path.join(repoDir, 'shrunk.txt'), 'x'.repeat(4096));
    git(repoDir, ['add', 'shrunk.txt']);
    fs.writeFileSync(path.join(repoDir, 'shrunk.txt'), 'tiny\n');

    const result = await readChangesFile({ cwd: repoDir, relPath: 'shrunk.txt', staged: false, maxBytes: 1024 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'too-large');
  } finally { cleanup(tmp); }
});

// --- Containment --------------------------------------------------------

const OUTSIDE_SECRET = 'outside secret\n';

function withOutsideFile(tmp) {
  const secret = path.join(tmp, 'outside-secret.txt');
  fs.writeFileSync(secret, OUTSIDE_SECRET);
  return secret;
}

test('real git: a traversal out of the repository is refused by the read (mutation target: the containment check)', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    withOutsideFile(tmp);

    for (const relPath of ['../outside-secret.txt', '../../etc/passwd', '/etc/passwd', 'f\n.txt', '']) {
      const result = await read(repoDir, relPath, false);
      assert.equal(result.ok, false, `must refuse ${JSON.stringify(relPath)}`);
      assert.ok(!('current' in result), 'no content may come back from a refused path');
    }
  } finally { cleanup(tmp); }
});

test('real git: a symlink inside the repository pointing outside it is refused by both the read and the save (mutation target: resolving on disk)', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    const secret = withOutsideFile(tmp);
    fs.symlinkSync(secret, path.join(repoDir, 'link.txt'));

    const readResult = await read(repoDir, 'link.txt', false);
    assert.equal(readResult.ok, false, 'a symlinked escape must not read the file it points at');
    assert.equal(readResult.reason, 'outside');

    const writeResult = await writeChangesFile({ cwd: repoDir, relPath: 'link.txt', content: 'overwritten\n', maxBytes: MAX_BYTES });
    assert.equal(writeResult.ok, false);
    assert.equal(writeResult.reason, 'outside');
    assert.equal(fs.readFileSync(secret, 'utf8'), OUTSIDE_SECRET, 'the file outside the repository is untouched');
  } finally { cleanup(tmp); }
});

test('real git: a sensitive file inside the repository is refused even though it is contained', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    fs.writeFileSync(path.join(repoDir, '.env'), 'TOKEN=secret\n');

    const result = await read(repoDir, '.env', false);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'sensitive');
  } finally { cleanup(tmp); }
});

test('real git: a directory is refused rather than read', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    fs.mkdirSync(path.join(repoDir, 'dir'));

    const result = await read(repoDir, 'dir', false);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not-a-file');
  } finally { cleanup(tmp); }
});

test('real git: a directory that is not a repository is refused', async () => {
  const tmp = mkTmp();
  try {
    const plainDir = path.join(tmp, 'plain');
    fs.mkdirSync(plainDir);
    fs.writeFileSync(path.join(plainDir, 'f.txt'), 'x\n');

    const result = await read(plainDir, 'f.txt', false);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'repo');
  } finally { cleanup(tmp); }
});

// --- The save -----------------------------------------------------------

test('real git: a save writes the working-tree file and the next read sees it', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);

    const result = await writeChangesFile({ cwd: repoDir, relPath: 'f.txt', content: 'edited\n', maxBytes: MAX_BYTES });
    assert.equal(result.ok, true, result.error);
    assert.equal(fs.readFileSync(path.join(repoDir, 'f.txt'), 'utf8'), 'edited\n');

    const after = await read(repoDir, 'f.txt', false);
    assert.equal(after.current, 'edited\n');
    assert.equal(after.original, 'indexed\n', 'saving the working tree must not move the index');
  } finally { cleanup(tmp); }
});

test('real git: a save never creates a file that does not exist', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);

    const result = await writeChangesFile({ cwd: repoDir, relPath: 'nope.txt', content: 'x\n', maxBytes: MAX_BYTES });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing');
    assert.equal(fs.existsSync(path.join(repoDir, 'nope.txt')), false);
  } finally { cleanup(tmp); }
});

test('real git: a save refuses every adversarial path shape and writes nothing (mutation target: the path guard)', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    const secret = withOutsideFile(tmp);

    for (const relPath of ['../outside-secret.txt', '../../etc/passwd', secret, 'f\n.txt', '', ':(exclude)f.txt', '-rf']) {
      const result = await writeChangesFile({ cwd: repoDir, relPath, content: 'pwned\n', maxBytes: MAX_BYTES });
      assert.equal(result.ok, false, `must refuse ${JSON.stringify(relPath)}`);
    }
    assert.equal(fs.readFileSync(secret, 'utf8'), OUTSIDE_SECRET);
    assert.equal(fs.readFileSync(path.join(repoDir, 'f.txt'), 'utf8'), 'worktree\n');
  } finally { cleanup(tmp); }
});

test('real git: a save refuses content over the cap and non-string content', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);

    const tooBig = await writeChangesFile({ cwd: repoDir, relPath: 'f.txt', content: 'x'.repeat(2048), maxBytes: 1024 });
    assert.equal(tooBig.ok, false);
    assert.equal(tooBig.reason, 'too-large');

    const notAString = await writeChangesFile({ cwd: repoDir, relPath: 'f.txt', content: null, maxBytes: MAX_BYTES });
    assert.equal(notAString.ok, false);
    assert.equal(notAString.reason, 'invalid-content');

    assert.equal(fs.readFileSync(path.join(repoDir, 'f.txt'), 'utf8'), 'worktree\n');
  } finally { cleanup(tmp); }
});
