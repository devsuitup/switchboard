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

const { readChangesFile, writeChangesFile, versionOf, resolveTargetInsideRepo, hasGitSegment, locateChangesFile } = require('../git-changes-file');

// git translates its diagnostics; the assertions below match its English text.
process.env.LC_ALL = 'C';
process.env.LANGUAGE = 'C';

const MAX_BYTES = 1024 * 1024;

function mkTmp() {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-gcf-real-')));
}

// The maxBuffer cap SIGTERMs an overrunning `git cat-file`, and execFile's
// callback runs before that child has been reaped (measured: exitCode null,
// killed true). On Windows a live process holds a handle on its working
// directory, so removing the scratch repo can race it — hence the retries.
function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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

// The version token of what is on disk right now, i.e. a save that races nothing.
function currentVersion(repoDir, relPath) {
  try {
    return versionOf(fs.readFileSync(path.join(repoDir, relPath)));
  } catch {
    return 'no-such-file';
  }
}

function save(repoDir, relPath, content, version) {
  return writeChangesFile({
    cwd: repoDir,
    relPath,
    content,
    version: version === undefined ? currentVersion(repoDir, relPath) : version,
    maxBytes: MAX_BYTES,
  });
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
    assert.equal(raw.status, 128, 'the exit code is what the module reads; the message varies by git version');
    assert.equal(raw.stdout, '');

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
    assert.equal(readResult.reason, 'symlink');

    const writeResult = await save(repoDir, 'link.txt', 'overwritten\n');
    assert.equal(writeResult.ok, false);
    assert.equal(writeResult.reason, 'symlink');
    assert.equal(fs.readFileSync(secret, 'utf8'), OUTSIDE_SECRET, 'the file outside the repository is untouched');
  } finally { cleanup(tmp); }
});

test('real git: a symlinked directory inside the repository is an escape the containment check catches (mutation target: the containment check)', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    const outsideDir = path.join(tmp, 'outside');
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(outsideDir, 'passwd'), OUTSIDE_SECRET);
    fs.symlinkSync(outsideDir, path.join(repoDir, 'linkdir'));

    const readResult = await read(repoDir, 'linkdir/passwd', false);
    assert.equal(readResult.ok, false, 'the last component is a real file, so only containment can refuse this');
    assert.equal(readResult.reason, 'outside');

    const writeResult = await save(repoDir, 'linkdir/passwd', 'pwned\n');
    assert.equal(writeResult.ok, false);
    assert.equal(writeResult.reason, 'outside');
    assert.equal(fs.readFileSync(path.join(outsideDir, 'passwd'), 'utf8'), OUTSIDE_SECRET);
  } finally { cleanup(tmp); }
});

test('real git: a symlink to another file inside the repository is refused, not silently followed', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    fs.symlinkSync(path.join(repoDir, 'f.txt'), path.join(repoDir, 'innerlink'));

    const readResult = await read(repoDir, 'innerlink', false);
    assert.equal(readResult.ok, false, 'the pair would be the link text against the target content');
    assert.equal(readResult.reason, 'symlink');

    const writeResult = await save(repoDir, 'innerlink', 'PWNED\n');
    assert.equal(writeResult.ok, false, 'the row names one path; the write must not land on another');
    assert.equal(writeResult.reason, 'symlink');
    assert.equal(fs.readFileSync(path.join(repoDir, 'f.txt'), 'utf8'), 'worktree\n', 'the link target is untouched');
    assert.equal(fs.lstatSync(path.join(repoDir, 'innerlink')).isSymbolicLink(), true);
  } finally { cleanup(tmp); }
});

test('real git: anything under .git is refused, on the read and on the write (mutation target: the .git segment check)', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    const configPath = path.join(repoDir, '.git', 'config');
    const configBefore = fs.readFileSync(configPath, 'utf8');

    for (const relPath of ['.git/config', '.git/hooks/pre-commit.sample', '.GIT/config', 'sub/../.git/config', '.git']) {
      const readResult = await read(repoDir, relPath, false);
      assert.equal(readResult.ok, false, `read must refuse ${relPath}`);

      const writeResult = await save(repoDir, relPath, '[core]\n\tpager = OWNED\n');
      assert.equal(writeResult.ok, false, `write must refuse ${relPath}`);
    }
    assert.equal(fs.readFileSync(configPath, 'utf8'), configBefore, 'git config is a command-execution primitive');
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

    const result = await save(repoDir, 'f.txt', 'edited\n');
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

    const result = await save(repoDir, 'nope.txt', 'x\n');
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
      const result = await save(repoDir, relPath, 'pwned\n');
      assert.equal(result.ok, false, `must refuse ${JSON.stringify(relPath)}`);
    }
    assert.equal(fs.readFileSync(secret, 'utf8'), OUTSIDE_SECRET);
    assert.equal(fs.readFileSync(path.join(repoDir, 'f.txt'), 'utf8'), 'worktree\n');
  } finally { cleanup(tmp); }
});

// The guard resolves the target once; the write must run on that value and not
// on a second resolution of the same string — see .ai/contexts/changes-view.md.
test('real git: the save writes the path the guard returned, not a re-derived join (mutation target: re-resolving after the check)', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    fs.mkdirSync(path.join(repoDir, 'real'));
    fs.writeFileSync(path.join(repoDir, 'real', 'f.txt'), 'before\n');
    // A symlinked directory inside the repo, pointing at an ordinary directory:
    // editable, and the resolved path is not the path the guard was given.
    fs.symlinkSync(path.join(repoDir, 'real'), path.join(repoDir, 'link'));

    const written = [];
    const fakeFs = {
      statSync: (p) => fs.statSync(p),
      lstatSync: (p) => fs.lstatSync(p),
      readFileSync: (p) => fs.readFileSync(p),
      writeFileSync: (p, content, enc) => { written.push(p); fs.writeFileSync(p, content, enc); },
    };

    const result = await writeChangesFile(
      { cwd: repoDir, relPath: 'link/f.txt', content: 'after\n', version: currentVersion(repoDir, 'link/f.txt'), maxBytes: MAX_BYTES },
      { fs: fakeFs },
    );
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(written, [path.join(repoDir, 'real', 'f.txt')], 'the symlink-free path from the guard, not repo/link/f.txt');
    assert.equal(fs.readFileSync(path.join(repoDir, 'real', 'f.txt'), 'utf8'), 'after\n');
  } finally { cleanup(tmp); }
});

test('real git: a save refuses content over the cap and non-string content', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);

    const tooBig = await writeChangesFile({ cwd: repoDir, relPath: 'f.txt', content: 'x'.repeat(2048), version: currentVersion(repoDir, 'f.txt'), maxBytes: 1024 });
    assert.equal(tooBig.ok, false);
    assert.equal(tooBig.reason, 'too-large');

    const notAString = await writeChangesFile({ cwd: repoDir, relPath: 'f.txt', content: null, version: currentVersion(repoDir, 'f.txt'), maxBytes: MAX_BYTES });
    assert.equal(notAString.ok, false);
    assert.equal(notAString.reason, 'invalid-content');

    const noVersion = await writeChangesFile({ cwd: repoDir, relPath: 'f.txt', content: 'x\n', maxBytes: MAX_BYTES });
    assert.equal(noVersion.ok, false);
    assert.equal(noVersion.reason, 'invalid-version', 'a caller that carries no token cannot overwrite anything');

    assert.equal(fs.readFileSync(path.join(repoDir, 'f.txt'), 'utf8'), 'worktree\n');
  } finally { cleanup(tmp); }
});

// --- Saving over a file that moved ---------------------------------------

test('real git: a save is refused when the file changed since it was read, and the other writer keeps its bytes (mutation target: the version token)', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    const target = path.join(repoDir, 'f.txt');

    const opened = await read(repoDir, 'f.txt', false);
    assert.equal(opened.ok, true, opened.error);
    assert.equal(typeof opened.version, 'string');

    // The session writes the file while the panel holds it open.
    fs.writeFileSync(target, 'IMPORTANT WORK BY THE SESSION\n');

    const refused = await writeChangesFile({
      cwd: repoDir, relPath: 'f.txt', content: opened.current + 'my edit\n', version: opened.version, maxBytes: MAX_BYTES,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'stale');
    assert.equal(fs.readFileSync(target, 'utf8'), 'IMPORTANT WORK BY THE SESSION\n', 'the session\'s uncommitted work survives');

    // Re-reading hands back a token that matches, and the save goes through.
    const reread = await read(repoDir, 'f.txt', false);
    const accepted = await writeChangesFile({
      cwd: repoDir, relPath: 'f.txt', content: 'mine now\n', version: reread.version, maxBytes: MAX_BYTES,
    });
    assert.equal(accepted.ok, true, accepted.error);
    assert.equal(fs.readFileSync(target, 'utf8'), 'mine now\n');
    assert.equal(accepted.version, reread.version === accepted.version ? accepted.version : accepted.version);
  } finally { cleanup(tmp); }
});

test('real git: the token a save returns is the one the next save must carry', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);

    const opened = await read(repoDir, 'f.txt', false);
    const first = await writeChangesFile({ cwd: repoDir, relPath: 'f.txt', content: 'one\n', version: opened.version, maxBytes: MAX_BYTES });
    assert.equal(first.ok, true, first.error);

    const stale = await writeChangesFile({ cwd: repoDir, relPath: 'f.txt', content: 'two\n', version: opened.version, maxBytes: MAX_BYTES });
    assert.equal(stale.ok, false, 'the token from before the first save is spent');
    assert.equal(stale.reason, 'stale');

    const second = await writeChangesFile({ cwd: repoDir, relPath: 'f.txt', content: 'two\n', version: first.version, maxBytes: MAX_BYTES });
    assert.equal(second.ok, true, second.error);
    assert.equal(fs.readFileSync(path.join(repoDir, 'f.txt'), 'utf8'), 'two\n');
  } finally { cleanup(tmp); }
});

// --- Line endings ---------------------------------------------------------

test('real git: a CRLF file reads as LF and is written back as CRLF, so a no-op save is a no-op in git (mutation target: the line-ending round trip)', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    fs.writeFileSync(path.join(repoDir, 'crlf.txt'), 'one\r\ntwo\r\nthree\r\n');
    git(repoDir, ['add', 'crlf.txt']);
    git(repoDir, ['commit', '-q', '-m', 'crlf']);

    const opened = await read(repoDir, 'crlf.txt', true);
    assert.equal(opened.ok, true, opened.error);
    assert.equal(opened.current, 'one\ntwo\nthree\n', 'the editor never sees a CR it would strip on its own');
    assert.equal(opened.original, 'one\ntwo\nthree\n');

    // What CodeMirror hands back: the same document, LF-joined.
    const saved = await writeChangesFile({
      cwd: repoDir, relPath: 'crlf.txt', content: opened.current, version: opened.version, maxBytes: MAX_BYTES,
    });
    assert.equal(saved.ok, true, saved.error);
    assert.equal(fs.readFileSync(path.join(repoDir, 'crlf.txt'), 'utf8'), 'one\r\ntwo\r\nthree\r\n',
      'the file keeps the line endings it had');
    assert.equal(git(repoDir, ['status', '--porcelain', '--', 'crlf.txt']).trim(), '', 'a no-op save leaves git with nothing to report');

    // A real edit keeps CRLF too.
    const edited = await writeChangesFile({
      cwd: repoDir, relPath: 'crlf.txt', content: 'one\ntwo\nthree\nfour\n', version: saved.version, maxBytes: MAX_BYTES,
    });
    assert.equal(edited.ok, true, edited.error);
    assert.equal(fs.readFileSync(path.join(repoDir, 'crlf.txt'), 'utf8'), 'one\r\ntwo\r\nthree\r\nfour\r\n');
  } finally { cleanup(tmp); }
});

test('real git: an LF file stays LF even when the buffer carries a stray CR', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);

    const opened = await read(repoDir, 'f.txt', false);
    const saved = await writeChangesFile({
      cwd: repoDir, relPath: 'f.txt', content: 'a\r\nb\n', version: opened.version, maxBytes: MAX_BYTES,
    });
    assert.equal(saved.ok, true, saved.error);
    assert.equal(fs.readFileSync(path.join(repoDir, 'f.txt'), 'utf8'), 'a\nb\n');
  } finally { cleanup(tmp); }
});

// --- Encoding and the byte-order mark --------------------------------------

test('real git: a file that is not valid UTF-8 is refused rather than round-tripped through U+FFFD (mutation target: the encoding gate)', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    const latin = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
    const target = path.join(repoDir, 'latin.txt');
    fs.writeFileSync(target, latin);

    const result = await read(repoDir, 'latin.txt', false);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'encoding', 'the panel has to tell this apart from a binary file');
    assert.deepEqual(fs.readFileSync(target), latin, 'and the bytes are untouched');
  } finally { cleanup(tmp); }
});

test('real git: a blob that is not valid UTF-8 is refused too, even when the working tree side is clean', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    fs.writeFileSync(path.join(repoDir, 'latin.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    git(repoDir, ['add', 'latin.txt']);
    fs.writeFileSync(path.join(repoDir, 'latin.txt'), 'cafe\n');

    const result = await read(repoDir, 'latin.txt', false);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'encoding');
  } finally { cleanup(tmp); }
});

// --- A `cat-file` failure is not a new file -------------------------------

test('a cat-file failure that is not "absent from this tree" is an error, not an empty original', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);

    const timedOut = await readChangesFile(
      { cwd: repoDir, relPath: 'f.txt', staged: false, maxBytes: MAX_BYTES },
      { runGit: fakeRunGit({ code: -1, stderr: 'killed' }) },
    );
    assert.equal(timedOut.ok, false, 'a timeout must not be rendered as "every line is new"');
    assert.equal(timedOut.reason, 'git');

    const absent = await readChangesFile(
      { cwd: repoDir, relPath: 'f.txt', staged: false, maxBytes: MAX_BYTES },
      { runGit: fakeRunGit({ code: 128, stderr: "fatal: path 'f.txt' exists on disk, but not in the index" }) },
    );
    assert.equal(absent.ok, true, 'exit 128 is the untracked/new-file case');
    assert.equal(absent.original, '');
  } finally { cleanup(tmp); }
});

// Passes rev-parse through to real git and fails only the blob read.
function fakeRunGit(blobResult) {
  const realModule = require('../git-changes-file');
  void realModule;
  return (args, opts) => {
    if (args[0] === 'rev-parse') {
      const out = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: opts.cwd, env: scratchGitEnv() });
      return Promise.resolve({ code: 0, stdout: out, stderr: '', tooLarge: false });
    }
    return Promise.resolve({ code: blobResult.code, stdout: Buffer.alloc(0), stderr: blobResult.stderr, tooLarge: false });
  };
}

// --- The module's own invocation ------------------------------------------

test('the blob is read with `cat-file blob`, pinned on the module\'s own argv (mutation target: going back to `git show`)', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);

    const seen = [];
    const runGit = (args, opts) => {
      seen.push(args);
      if (args[0] === 'rev-parse') {
        return Promise.resolve({
          code: 0,
          stdout: execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: opts.cwd, env: scratchGitEnv() }),
          stderr: '',
          tooLarge: false,
        });
      }
      return Promise.resolve({ code: 0, stdout: Buffer.from('indexed\n'), stderr: '', tooLarge: false });
    };

    const unstaged = await readChangesFile({ cwd: repoDir, relPath: 'f.txt', staged: false, maxBytes: MAX_BYTES }, { runGit });
    assert.equal(unstaged.ok, true, unstaged.error);
    assert.deepEqual(seen[seen.length - 1], ['cat-file', 'blob', ':f.txt']);

    const staged = await readChangesFile({ cwd: repoDir, relPath: 'f.txt', staged: true, maxBytes: MAX_BYTES }, { runGit });
    assert.equal(staged.ok, true, staged.error);
    assert.deepEqual(seen[seen.length - 1], ['cat-file', 'blob', 'HEAD:f.txt']);
  } finally { cleanup(tmp); }
});

// --- A legitimately odd filename ------------------------------------------

test('real git: a file whose name contains `..` is editable; a real traversal still is not', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    withOutsideFile(tmp);
    fs.writeFileSync(path.join(repoDir, 'schema..v2.sql'), 'select 1;\n');

    const opened = await read(repoDir, 'schema..v2.sql', false);
    assert.equal(opened.ok, true, opened.error);
    assert.equal(opened.current, 'select 1;\n');

    const saved = await save(repoDir, 'schema..v2.sql', 'select 2;\n');
    assert.equal(saved.ok, true, saved.error);
    assert.equal(fs.readFileSync(path.join(repoDir, 'schema..v2.sql'), 'utf8'), 'select 2;\n');

    for (const relPath of ['../outside-secret.txt', 'sub/../../outside-secret.txt', '..', 'a/..']) {
      const refused = await read(repoDir, relPath, false);
      assert.equal(refused.ok, false, `a real traversal must still be refused: ${relPath}`);
    }
  } finally { cleanup(tmp); }
});

// --- The git directory is not editable, however it is spelled ------------

test('real git: .git reached through a symlinked directory is refused, on the read and on the write (mutation target: checking the resolved path)', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    const configPath = path.join(repoDir, '.git', 'config');
    const configBefore = fs.readFileSync(configPath, 'utf8');
    // The literal string carries no `.git` segment; only the resolved path does.
    fs.symlinkSync(path.join(repoDir, '.git'), path.join(repoDir, 'gitlink'));

    const readResult = await read(repoDir, 'gitlink/config', false);
    assert.equal(readResult.ok, false, 'the git directory must not be readable through a link');
    assert.equal(readResult.reason, 'git-dir');

    const writeResult = await save(repoDir, 'gitlink/config', '[core]\n\tpager = OWNED\n');
    assert.equal(writeResult.ok, false);
    assert.equal(writeResult.reason, 'git-dir');
    assert.equal(fs.readFileSync(configPath, 'utf8'), configBefore,
      'core.pager in .git/config runs on the next git command in this repo');
  } finally { cleanup(tmp); }
});

// Two independent rules cover the git directory, and each is the only one that
// can catch its own case: the segment rule when the git directory is named
// `.git`, the containment rule when it is somewhere else entirely.
test('real git: the resolved-path segment rule alone refuses .git reached through a link', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    fs.symlinkSync(path.join(repoDir, '.git'), path.join(repoDir, 'gitlink'));

    // A caller that knows only the root — no git-directory list to fall back on.
    const target = resolveTargetInsideRepo(repoDir, 'gitlink/config', {});
    assert.equal(target.ok, false);
    assert.equal(target.reason, 'git-dir');
  } finally { cleanup(tmp); }
});

test('real git: a git directory that is not called .git is refused by containment alone', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    fs.mkdirSync(repoDir, { recursive: true });
    // --separate-git-dir puts the real git directory under a name the segment
    // rule cannot recognise, inside the working tree.
    git(repoDir, ['init', '-q', '--separate-git-dir', path.join(repoDir, 'customgit')]);
    git(repoDir, ['config', 'user.email', 'a@a.com']);
    git(repoDir, ['config', 'user.name', 'a']);
    fs.writeFileSync(path.join(repoDir, 'f.txt'), 'hello\n');
    git(repoDir, ['add', 'f.txt']);
    git(repoDir, ['commit', '-q', '-m', 'init']);

    const configBefore = fs.readFileSync(path.join(repoDir, 'customgit', 'config'), 'utf8');
    assert.equal(hasGitSegment('customgit/config'), false, 'no segment rule can see this one');

    const readResult = await read(repoDir, 'customgit/config', false);
    assert.equal(readResult.ok, false);
    assert.equal(readResult.reason, 'git-dir');

    const writeResult = await save(repoDir, 'customgit/config', '[core]\n\tpager = OWNED\n');
    assert.equal(writeResult.ok, false);
    assert.equal(writeResult.reason, 'git-dir');
    assert.equal(fs.readFileSync(path.join(repoDir, 'customgit', 'config'), 'utf8'), configBefore);

    const ordinary = await read(repoDir, 'f.txt', false);
    assert.equal(ordinary.ok, true, 'and the working tree is still editable: ' + ordinary.error);
  } finally { cleanup(tmp); }
});

test('real git: the git-directory check does not block ordinary files whose names merely contain "git"', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    fs.mkdirSync(path.join(repoDir, '.github', 'workflows'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'a.git'));
    fs.writeFileSync(path.join(repoDir, '.gitignore'), 'node_modules\n');
    fs.writeFileSync(path.join(repoDir, '.github', 'workflows', 'ci.yml'), 'on: push\n');
    fs.writeFileSync(path.join(repoDir, 'a.git', 'x.txt'), 'x\n');
    fs.writeFileSync(path.join(repoDir, 'dotgit.md'), 'notes\n');

    for (const relPath of ['.gitignore', '.github/workflows/ci.yml', 'a.git/x.txt', 'dotgit.md']) {
      const result = await read(repoDir, relPath, false);
      assert.equal(result.ok, true, `${relPath} must stay editable: ${result.error}`);
    }
  } finally { cleanup(tmp); }
});

// --- A byte-order mark survives the round trip ---------------------------

test('real git: a BOM survives a no-op save, on a file that also uses CRLF (mutation target: the BOM round trip)', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    const target = path.join(repoDir, 'win.txt');
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello\r\nworld\r\n', 'utf8')]);
    fs.writeFileSync(target, bytes);
    git(repoDir, ['add', 'win.txt']);
    git(repoDir, ['commit', '-q', '-m', 'win']);

    const opened = await read(repoDir, 'win.txt', true);
    assert.equal(opened.ok, true, opened.error);
    assert.equal(opened.current, 'hello\nworld\n', 'the editor gets neither the BOM nor the CRs');
    assert.equal(opened.original, 'hello\nworld\n');

    const saved = await writeChangesFile({
      cwd: repoDir, relPath: 'win.txt', content: opened.current, version: opened.version, maxBytes: MAX_BYTES,
    });
    assert.equal(saved.ok, true, saved.error);
    assert.deepEqual(fs.readFileSync(target), bytes, 'byte-identical: the BOM and the CRLFs are both still there');
    assert.equal(git(repoDir, ['status', '--porcelain', '--', 'win.txt']).trim(), '');
  } finally { cleanup(tmp); }
});

test('real git: a file with no BOM does not acquire one', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);

    const opened = await read(repoDir, 'f.txt', false);
    const saved = await writeChangesFile({
      cwd: repoDir, relPath: 'f.txt', content: 'plain\n', version: opened.version, maxBytes: MAX_BYTES,
    });
    assert.equal(saved.ok, true, saved.error);
    assert.deepEqual(fs.readFileSync(path.join(repoDir, 'f.txt')), Buffer.from('plain\n', 'utf8'));
  } finally { cleanup(tmp); }
});

// --- Every uniform line ending, including a lone CR ----------------------

test('real git: a lone-CR file reads as LF and is written back as CR (mutation target: folding a lone CR)', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    const target = path.join(repoDir, 'lonecr.txt');
    fs.writeFileSync(target, 'a\rb\rc\r');
    git(repoDir, ['add', 'lonecr.txt']);
    git(repoDir, ['commit', '-q', '-m', 'cr']);

    const opened = await read(repoDir, 'lonecr.txt', true);
    assert.equal(opened.ok, true, opened.error);
    assert.equal(opened.current, 'a\nb\nc\n',
      'CodeMirror folds a lone CR to LF, so the comparison side has to fold it too');

    const saved = await writeChangesFile({
      cwd: repoDir, relPath: 'lonecr.txt', content: opened.current, version: opened.version, maxBytes: MAX_BYTES,
    });
    assert.equal(saved.ok, true, saved.error);
    assert.equal(fs.readFileSync(target, 'utf8'), 'a\rb\rc\r', 'byte-identical after a no-op save');
    assert.equal(git(repoDir, ['status', '--porcelain', '--', 'lonecr.txt']).trim(), '');
  } finally { cleanup(tmp); }
});

test('real git: a file that mixes line endings is refused rather than silently normalised (mutation target: the uniformity check)', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    const target = path.join(repoDir, 'mixed.txt');
    fs.writeFileSync(target, 'a\r\nb\nc\r\nd\n');
    git(repoDir, ['add', 'mixed.txt']);
    git(repoDir, ['commit', '-q', '-m', 'mixed']);

    const opened = await read(repoDir, 'mixed.txt', true);
    assert.equal(opened.ok, false, 'no editor can preserve per-line endings a document type does not carry');
    assert.equal(opened.reason, 'mixed-eol');

    const refused = await save(repoDir, 'mixed.txt', 'a\nb\nc\nd\n');
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'mixed-eol');
    assert.equal(fs.readFileSync(target, 'utf8'), 'a\r\nb\nc\r\nd\n', 'and the file is untouched');
    assert.equal(git(repoDir, ['status', '--porcelain', '--', 'mixed.txt']).trim(), '');
  } finally { cleanup(tmp); }
});

test('real git: a single line with no trailing newline round-trips byte-identically', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    const target = path.join(repoDir, 'oneline.txt');
    fs.writeFileSync(target, 'no trailing newline');
    git(repoDir, ['add', 'oneline.txt']);
    git(repoDir, ['commit', '-q', '-m', 'one']);

    const opened = await read(repoDir, 'oneline.txt', true);
    const saved = await writeChangesFile({
      cwd: repoDir, relPath: 'oneline.txt', content: opened.current, version: opened.version, maxBytes: MAX_BYTES,
    });
    assert.equal(saved.ok, true, saved.error);
    assert.equal(fs.readFileSync(target, 'utf8'), 'no trailing newline');
    assert.equal(git(repoDir, ['status', '--porcelain', '--', 'oneline.txt']).trim(), '');
  } finally { cleanup(tmp); }
});

// --- A file link's absolute path, mapped to a row -------------------------

function locate(repoDir, absolutePath) {
  return locateChangesFile({ cwd: repoDir, absolutePath });
}

test('real git: an absolute path inside the repo maps to its repo-relative row, with the row\'s own flags', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    fs.mkdirSync(path.join(repoDir, 'src'));
    fs.writeFileSync(path.join(repoDir, 'src', 'tracked.js'), 'one\n');
    git(repoDir, ['add', 'src/tracked.js']);
    git(repoDir, ['commit', '-q', '-m', 'add']);
    fs.writeFileSync(path.join(repoDir, 'src', 'tracked.js'), 'two\n');

    const modified = await locate(repoDir, path.join(repoDir, 'src', 'tracked.js'));
    assert.equal(modified.ok, true, modified.error);
    assert.equal(modified.relPath, 'src/tracked.js', 'the renderer is handed the pathspec, never the root');
    assert.equal(modified.changed, true);
    assert.equal(modified.staged, false, 'an unstaged edit opens against the index');
    assert.equal(modified.untracked, false);

    git(repoDir, ['add', 'src/tracked.js']);
    const staged = await locate(repoDir, path.join(repoDir, 'src', 'tracked.js'));
    assert.equal(staged.staged, true, 'a staged-only edit opens against HEAD');
  } finally { cleanup(tmp); }
});

test('real git: an untracked file is a row too, and an unmodified one is not (mutation target: the changed check)', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    fs.writeFileSync(path.join(repoDir, 'brand-new.txt'), 'new\n');
    git(repoDir, ['add', 'f.txt']);
    git(repoDir, ['commit', '-q', '-m', 'clean']);
    fs.writeFileSync(path.join(repoDir, 'clean.txt'), 'x\n');
    git(repoDir, ['add', 'clean.txt']);
    git(repoDir, ['commit', '-q', '-m', 'clean2']);

    const untracked = await locate(repoDir, path.join(repoDir, 'brand-new.txt'));
    assert.equal(untracked.changed, true, 'an untracked file is a legitimate row');
    assert.equal(untracked.untracked, true);

    const unmodified = await locate(repoDir, path.join(repoDir, 'clean.txt'));
    assert.equal(unmodified.ok, true, 'an unmodified file is not an error');
    assert.equal(unmodified.changed, false, 'it just has no diff to show');
    assert.equal(unmodified.relPath, 'clean.txt');
  } finally { cleanup(tmp); }
});

test('real git: a path outside the repository is refused, not mapped (mutation target: the containment check)', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    const outside = path.join(tmp, 'outside.txt');
    fs.writeFileSync(outside, 'secret\n');

    const result = await locate(repoDir, outside);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'outside');
    assert.ok(!('relPath' in result), 'nothing about the repository leaks back for a path outside it');

    const missing = await locate(repoDir, path.join(repoDir, 'nope.txt'));
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'missing');
  } finally { cleanup(tmp); }
});

test('real git: a link into the git directory or through a symlink is refused by the same guard as a row', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    fs.symlinkSync(path.join(repoDir, '.git'), path.join(repoDir, 'gitlink'));
    fs.symlinkSync(path.join(repoDir, 'f.txt'), path.join(repoDir, 'flink'));

    // Both spellings resolve to the same place, and the relative path computed
    // from the resolved one carries the .git segment either way.
    for (const spelling of [path.join(repoDir, '.git', 'config'), path.join(repoDir, 'gitlink', 'config')]) {
      const refused = await locate(repoDir, spelling);
      assert.equal(refused.ok, false, `must refuse ${spelling}`);
      assert.equal(refused.reason, 'invalid-path');
      assert.ok(!('relPath' in refused), 'and hands back no pathspec to open');
    }

    // A symlink resolves to its target, which is an ordinary row: what is
    // refused is editing the link itself, and that is what relPath names.
    const link = await locate(repoDir, path.join(repoDir, 'flink'));
    assert.equal(link.ok, true, link.error);
    assert.equal(link.relPath, 'f.txt', 'the row is the file the link points at, inside the repo');
  } finally { cleanup(tmp); }
});

test('real git: a path in a subdirectory keeps forward slashes, the spelling every other Changes IPC uses', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    fs.mkdirSync(path.join(repoDir, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'a', 'b', 'c.txt'), 'deep\n');

    const result = await locate(repoDir, path.join(repoDir, 'a', 'b', 'c.txt'));
    assert.equal(result.relPath, 'a/b/c.txt');
    assert.equal(result.changed, true);

    const reread = await readChangesFile({ cwd: repoDir, relPath: result.relPath, staged: false, maxBytes: MAX_BYTES });
    assert.equal(reread.ok, true, 'the pathspec it returns is one the read accepts: ' + reread.error);
    assert.equal(reread.current, 'deep\n');
  } finally { cleanup(tmp); }
});

test('real git: a link to a file no row could open is not offered as a row (mutation target: the shared guard in locate)', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    fs.writeFileSync(path.join(repoDir, '.env'), 'TOKEN=secret\n');
    fs.mkdirSync(path.join(repoDir, 'adir'));

    // Sensitive: the read refuses it, so the link must not route there either.
    const sensitive = await locate(repoDir, path.join(repoDir, '.env'));
    assert.equal(sensitive.ok, false);
    assert.equal(sensitive.reason, 'sensitive');

    // A directory link has no row to open.
    const dir = await locate(repoDir, path.join(repoDir, 'adir'));
    assert.equal(dir.ok, false);
    assert.equal(dir.reason, 'not-a-file');
  } finally { cleanup(tmp); }
});

test('real git: a git directory that is not called .git is not reachable through a link either', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    fs.mkdirSync(repoDir, { recursive: true });
    git(repoDir, ['init', '-q', '--separate-git-dir', path.join(repoDir, 'customgit')]);
    git(repoDir, ['config', 'user.email', 'a@a.com']);
    git(repoDir, ['config', 'user.name', 'a']);
    fs.writeFileSync(path.join(repoDir, 'f.txt'), 'hello\n');

    const result = await locate(repoDir, path.join(repoDir, 'customgit', 'config'));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'git-dir', 'no segment rule can see this one; containment can');
  } finally { cleanup(tmp); }
});

test('real git: a file whose name is git\'s conflict-stage syntax is refused by the operand guard, not by containment', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    // A perfectly ordinary filename that `:<path>` would read as `:<n>:<path>`.
    const staged = path.join(repoDir, '1:f.txt');
    fs.writeFileSync(staged, 'ordinary\n');

    // Containment has no objection: the file is inside the repository.
    const contained = resolveTargetInsideRepo(repoDir, '1:f.txt', {});
    assert.equal(contained.ok, true, 'nothing about its location is wrong');

    const result = await read(repoDir, '1:f.txt', false);
    assert.equal(result.ok, false, 'only the operand guard can refuse this one');
    assert.equal(result.reason, 'invalid-path');
    assert.equal(fs.readFileSync(staged, 'utf8'), 'ordinary\n');
  } finally { cleanup(tmp); }
});

// --- A hard link is a second name for the same bytes ----------------------

test('real git: a hard link to a file outside the repository is refused, on the read and on the write (mutation target: the nlink check)', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    const outside = path.join(tmp, 'outside-secret.txt');
    fs.writeFileSync(outside, OUTSIDE_SECRET);
    // Same inode, two names, one of them inside the repo: realpath cannot tell
    // the difference, because the in-repo name IS the real path.
    fs.linkSync(outside, path.join(repoDir, 'planted.txt'));
    assert.equal(fs.statSync(path.join(repoDir, 'planted.txt')).nlink, 2, 'the link is what it looks like');

    const readResult = await read(repoDir, 'planted.txt', false);
    assert.equal(readResult.ok, false);
    assert.equal(readResult.reason, 'hardlink');

    const writeResult = await save(repoDir, 'planted.txt', 'pwned\n');
    assert.equal(writeResult.ok, false);
    assert.equal(writeResult.reason, 'hardlink');
    assert.equal(fs.readFileSync(outside, 'utf8'), OUTSIDE_SECRET, 'the file outside the repository is untouched');

    // A link to a file elsewhere in the same repo is refused by the same rule:
    // the check is on the link, not on where the other name happens to be.
    fs.linkSync(path.join(repoDir, 'f.txt'), path.join(repoDir, 'inner-link.txt'));
    const inner = await read(repoDir, 'inner-link.txt', false);
    assert.equal(inner.ok, false);
    assert.equal(inner.reason, 'hardlink');
  } finally { cleanup(tmp); }
});

test('real git: an ordinary file is not mistaken for a hard link', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    assert.equal(fs.statSync(path.join(repoDir, 'f.txt')).nlink, 1);
    const result = await read(repoDir, 'f.txt', false);
    assert.equal(result.ok, true, result.error);
  } finally { cleanup(tmp); }
});

// --- The write refuses what the read refuses ------------------------------

test('real git: an unpaired surrogate in the content is refused rather than written as U+FFFD (mutation target: the write-side encoding check)', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    const target = path.join(repoDir, 'f.txt');
    const before = fs.readFileSync(target);

    for (const content of ['line1\n\uD800line2\n', 'lone low \uDC00\n', 'pair \uD83D\uDE00 then lone \uD83D\n']) {
      const result = await save(repoDir, 'f.txt', content);
      assert.equal(result.ok, false, `must refuse ${JSON.stringify(content)}`);
      assert.equal(result.reason, 'encoding');
    }
    assert.deepEqual(fs.readFileSync(target), before, 'and nothing is written');

    // A well-formed pair is ordinary text and still saves.
    const ok = await save(repoDir, 'f.txt', 'emoji \uD83D\uDE00 fine\n');
    assert.equal(ok.ok, true, ok.error);
    assert.equal(fs.readFileSync(target, 'utf8'), 'emoji \uD83D\uDE00 fine\n');
  } finally { cleanup(tmp); }
});
