'use strict';

// A real, on-disk git repository — no injected `exec`, the local runner's own
// execFile('git', ...) path. Adversarial review (issue #251), SUGGESTION 7:
// document what an absolute path or a "~" pathspec does against real git,
// and reject it in isSafeGitPath if that turns out to be unsafe. Measured
// behavior (git 2.24+, --literal-pathspecs): git itself refuses an absolute
// pathspec that resolves outside the repository ("fatal: ... is outside
// repository", exit 128, no stdout) — no content ever leaks from outside the
// repo, so isSafeGitPath does not need its own absolute-path check on top of
// that. This test pins that measurement so a future git/behavior change is
// caught here rather than assumed.
//
// The untracked tests below pin the three measurements the untracked support
// rests on: -uall descends into a wholly-untracked directory, `git diff
// --no-index` exits 1 on a difference (success, not failure), and --no-index
// carries NO repository-containment check — see .ai/contexts/changes-view.md
// ("Untracked files").

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const { createGitChangesRunner, isSafeNoIndexPath, NOT_A_REPO_REASON } = require('../git-changes-runner');

// git translates its diagnostics; the assertions below match its English text.
// Set on this process so both the scratch-repo helper and the runner's own
// execFile child (which inherits process.env) speak the same language.
process.env.LC_ALL = 'C';
process.env.LANGUAGE = 'C';

function mkTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-gcr-real-'));
  // Windows can hand back a short (8.3) TEMP path (e.g. "JEAN-B~1"); git's
  // own containment check resolves the repo root through its long form and
  // then rejects a short-form pathspec as "outside repository" even when it
  // points at the same file — an environment quirk, not the thing under
  // test. Canonicalize once so cwd and every pathspec built from `dir` agree.
  return fs.realpathSync.native(dir);
}

// Same race as test/git-changes-file-real-git.test.js: a git child killed by a
// cap is still terminating when the assertion returns, and on Windows it holds
// its working directory until it dies.
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

function initRepo(repoDir) {
  fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, ['init', '-q']);
  git(repoDir, ['config', 'user.email', 'a@a.com']);
  git(repoDir, ['config', 'user.name', 'a']);
  fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'line1\n');
  git(repoDir, ['add', 'tracked.txt']);
  git(repoDir, ['commit', '-q', '-m', 'init']);
  fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'line1\nline2\n');
}

// A whole untracked tree plus a binary file, none of it ever added to the index.
function addUntrackedTree(repoDir) {
  fs.mkdirSync(path.join(repoDir, 'newdir', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'newdir', 'a.txt'), 'a1\na2\na3\n');
  fs.writeFileSync(path.join(repoDir, 'newdir', 'sub', 'b.txt'), 'b1\n');
  fs.writeFileSync(path.join(repoDir, 'bin.dat'), Buffer.from([0, 1, 2, 0, 3, 255]));
}

test('real git: status descends into a wholly-untracked directory — one row per file, never a single directory row (mutation target: dropping -uall)', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    addUntrackedTree(repoDir);

    const runner = createGitChangesRunner({ kind: 'local', cwd: repoDir });
    const result = await runner.status();
    assert.equal(result.ok, true);

    const paths = result.files.map((f) => f.path).sort();
    assert.deepEqual(paths, ['bin.dat', 'newdir/a.txt', 'newdir/sub/b.txt', 'tracked.txt']);
    for (const f of result.files) {
      assert.ok(!f.path.endsWith('/'), `no row may be a directory: ${f.path}`);
    }
    assert.ok(!paths.includes('newdir/'), 'git\'s default --untracked-files=normal would collapse the tree to "newdir/"');
  } finally {
    cleanup(tmp);
  }
});

test('real git: an untracked file yields a new-file diff and its added-line count — --no-index exits 1 on a difference, which is success here', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    addUntrackedTree(repoDir);

    // The exit code real git actually returns here, pinned: 1, with the diff on stdout.
    const raw = spawnSync('git', ['--literal-pathspecs', 'diff', '--no-index', '--', '/dev/null', 'newdir/a.txt'],
      { cwd: repoDir, encoding: 'utf8', env: scratchGitEnv() });
    assert.equal(raw.status, 1, 'git diff --no-index exits 1 when the two inputs differ');
    assert.match(raw.stdout, /\+a1/);

    const runner = createGitChangesRunner({ kind: 'local', cwd: repoDir });
    const result = await runner.diff('newdir/a.txt', { untracked: true });

    assert.equal(result.ok, true, 'exit 1 must not be reported as a failure');
    assert.match(result.content, /^\+a1$/m);
    assert.match(result.content, /^\+a3$/m);
    assert.equal(result.added, 3);
    assert.equal(result.deleted, 0);
    assert.equal(result.truncated, false);
  } finally {
    cleanup(tmp);
  }
});

test('real git: an untracked binary file shows git\'s own note and no line counts, never raw bytes', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    addUntrackedTree(repoDir);

    const runner = createGitChangesRunner({ kind: 'local', cwd: repoDir });
    const result = await runner.diff('bin.dat', { untracked: true });

    assert.equal(result.ok, true);
    assert.match(result.content, /Binary files .*differ/);
    assert.ok(!result.content.includes('\x00'), 'no raw binary content may reach the renderer');
    assert.equal(result.added, null);
    assert.equal(result.deleted, null);
  } finally {
    cleanup(tmp);
  }
});

test('real git: --no-index has NO repository-containment check — the operand guard, not git, is what keeps an untracked diff inside the working directory', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    const secretPath = path.join(tmp, 'outside-secret.txt');
    fs.writeFileSync(secretPath, 'SUPER_SECRET_OUTSIDE_THE_REPO\n');

    // Measured, and the whole reason isSafeNoIndexPath is stricter than
    // isSafeGitPath: git happily reads an out-of-repo file under --no-index,
    // where the same path as a pathspec is refused with "outside repository".
    const raw = spawnSync('git', ['--literal-pathspecs', 'diff', '--no-index', '--', '/dev/null', secretPath],
      { cwd: repoDir, encoding: 'utf8', env: scratchGitEnv() });
    assert.match(raw.stdout, /SUPER_SECRET_OUTSIDE_THE_REPO/, 'raw git --no-index reads outside the repo');

    const runner = createGitChangesRunner({ kind: 'local', cwd: repoDir });
    for (const bad of [secretPath.replace(/\\/g, '/'), '../outside-secret.txt']) {
      const result = await runner.diff(bad, { untracked: true });
      assert.equal(result.ok, false, `${bad} must never reach git`);
      assert.equal(result.error, 'invalid path');
    }
  } finally {
    cleanup(tmp);
  }
});

test('real git: a symlinked directory inside the repo does not open a way out — the operand is syntactically innocent and still refused', async (t) => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    const secretDir = path.join(tmp, 'secrets');
    fs.mkdirSync(secretDir, { recursive: true });
    fs.writeFileSync(path.join(secretDir, 'outside-secret.txt'), 'SUPER_SECRET_OUTSIDE_THE_REPO\n');
    try {
      fs.symlinkSync(secretDir, path.join(repoDir, 'link-to-dir'), 'dir');
    } catch {
      t.skip('this platform does not allow creating a directory symlink unprivileged');
      return;
    }

    const operand = 'link-to-dir/outside-secret.txt';
    assert.equal(isSafeNoIndexPath(operand), true, 'no "..", not absolute, no leading dash: the syntactic guard accepts it');

    const raw = spawnSync('git', ['--literal-pathspecs', 'diff', '--no-index', '--', '/dev/null', operand],
      { cwd: repoDir, encoding: 'utf8', env: scratchGitEnv() });
    assert.match(raw.stdout, /SUPER_SECRET_OUTSIDE_THE_REPO/, 'raw git follows the symlink and reads the file');

    const runner = createGitChangesRunner({ kind: 'local', cwd: repoDir });
    const result = await runner.diff(operand, { untracked: true });
    assert.equal(result.ok, false, 'the resolved parent is outside the working directory');
    assert.equal(result.error, 'invalid path');
  } finally {
    cleanup(tmp);
  }
});

test('real git: a leaf symlink to a DIRECTORY leaks a file named "null" unless the guard stops it — git follows that one and pairs the --no-index operands by basename', async (t) => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    const outsideDir = path.join(tmp, 'outside');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'null'), 'PAIRED_SECRET_VIA_NULL_BASENAME\n');
    try {
      fs.symlinkSync(outsideDir, path.join(repoDir, 'dirlink'), 'dir');
    } catch {
      t.skip('this platform does not allow creating a directory symlink unprivileged');
      return;
    }

    const runner = createGitChangesRunner({ kind: 'local', cwd: repoDir });
    const status = await runner.status();
    assert.ok(status.files.some((f) => f.path === 'dirlink'), 'git lists the symlink as a row of its own — this needs no crafted path, just a click');

    // What raw git does with that row's own path, pinned.
    const raw = spawnSync('git', ['--literal-pathspecs', 'diff', '--no-index', '--', '/dev/null', 'dirlink'],
      { cwd: repoDir, encoding: 'utf8', env: scratchGitEnv() });
    assert.match(raw.stdout, /PAIRED_SECRET_VIA_NULL_BASENAME/, 'raw git follows the directory symlink and diffs <dirlink>/null');
    assert.match(raw.stdout, /^\+\+\+ b\/dirlink\/null$/m, 'and says so in the header: the path it diffed is not the path it was given');

    const result = await runner.diff('dirlink', { untracked: true });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'invalid path');
    assert.ok(!String(result.content || '').includes('PAIRED_SECRET_VIA_NULL_BASENAME'));
  } finally {
    cleanup(tmp);
  }
});

test('real git: a leaf symlink to a FILE stays openable and leaks nothing — git lstats that one, so the diff is the link target string, not the target\'s content', async (t) => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    const secretPath = path.join(tmp, 'outside-secret.txt');
    fs.writeFileSync(secretPath, 'SUPER_SECRET_OUTSIDE_THE_REPO\n');
    try {
      fs.symlinkSync(secretPath, path.join(repoDir, 'link-to-file'));
    } catch {
      t.skip('this platform does not allow creating a symlink unprivileged');
      return;
    }

    const runner = createGitChangesRunner({ kind: 'local', cwd: repoDir });
    const status = await runner.status();
    assert.ok(status.files.some((f) => f.path === 'link-to-file'), 'git lists the symlink as an untracked row');

    const result = await runner.diff('link-to-file', { untracked: true });
    assert.equal(result.ok, true, 'a row git lists must stay openable');
    assert.match(result.content, /new file mode 120000/);
    assert.ok(!result.content.includes('SUPER_SECRET_OUTSIDE_THE_REPO'), 'the target\'s content never surfaces');
  } finally {
    cleanup(tmp);
  }
});

test('real git: a file whose name contains ".." is listed and opens — ".." is only a traversal as a whole path segment', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    fs.writeFileSync(path.join(repoDir, 'has..dots.txt'), 'one\ntwo\n');

    const runner = createGitChangesRunner({ kind: 'local', cwd: repoDir });
    const status = await runner.status();
    assert.ok(status.files.some((f) => f.path === 'has..dots.txt'), 'git lists it');

    const result = await runner.diff('has..dots.txt', { untracked: true });
    assert.equal(result.ok, true, 'a listed row must not refuse to open');
    assert.equal(result.added, 2);
  } finally {
    cleanup(tmp);
  }
});

test('real git: an untracked path that no longer exists is an error, not an empty success', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);

    const runner = createGitChangesRunner({ kind: 'local', cwd: repoDir });
    const result = await runner.diff('gone.txt', { untracked: true });

    assert.equal(result.ok, false, 'a row whose file is gone must not read as an empty diff');
    assert.equal(result.error, 'invalid path');

    // What raw git does with the same operand, pinned: exit 1 with nothing on
    // stdout — the shape the runner must not mistake for a difference.
    const raw = spawnSync('git', ['--literal-pathspecs', 'diff', '--no-index', '--', '/dev/null', 'gone.txt'],
      { cwd: repoDir, encoding: 'utf8', env: scratchGitEnv() });
    assert.equal(raw.status, 1);
    assert.equal(raw.stdout, '');
    assert.match(raw.stderr, /Could not access/);
  } finally {
    cleanup(tmp);
  }
});

test('real git: an absolute pathspec outside the repo is refused by git itself — no secret content ever surfaces', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    const secretPath = path.join(tmp, 'outside-secret.txt');
    fs.writeFileSync(secretPath, 'SUPER_SECRET_OUTSIDE_THE_REPO\n');

    const runner = createGitChangesRunner({ kind: 'local', cwd: repoDir });
    const result = await runner.diff(secretPath);
    if (result.ok) {
      // Whatever git did, it must never have echoed the secret file's content.
      assert.ok(!result.content.includes('SUPER_SECRET_OUTSIDE_THE_REPO'), 'no content from outside the repo may ever surface');
    } else {
      assert.match(result.error, /outside repository/, 'git refuses an absolute pathspec outside the repo with this message');
    }
  } finally {
    cleanup(tmp);
  }
});

test('real git: an absolute pathspec INSIDE the repo still works — the containment check is about the repo boundary, not "absolute" per se', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    const absoluteInsidePath = path.join(repoDir, 'tracked.txt');

    const runner = createGitChangesRunner({ kind: 'local', cwd: repoDir });
    const result = await runner.diff(absoluteInsidePath.replace(/\\/g, '/'));
    assert.equal(result.ok, true);
    assert.match(result.content, /\+line2/);
  } finally {
    cleanup(tmp);
  }
});

test('real git: a literal "~/..." pathspec is never shell-expanded (no shell is invoked) and resolves to nothing, not the caller\'s home directory', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);

    const runner = createGitChangesRunner({ kind: 'local', cwd: repoDir });
    const result = await runner.diff('~/nonexistent-should-not-expand');
    assert.equal(result.ok, true, 'a nonexistent literal path is not an error, just an empty diff');
    assert.equal(result.content, '', 'git diff never reports a nonexistent/untracked path — and "~" was never expanded to $HOME');
  } finally {
    cleanup(tmp);
  }
});

// --- Not a git work tree — see .ai/contexts/changes-view.md ("Not a repository") ---
//
// Real git, a real directory outside any repository. The suite pins LC_ALL=C
// for its message assertions; these cases run under a second locale on purpose,
// because the detection is an exit code and must not move when the message does.
// A host without fr_FR.UTF-8 installed falls back to English — the assertions
// hold either way, which is the point.

const LOCALES = ['C', 'fr_FR.UTF-8'];

// A temp directory with a repository somewhere above it would answer "true";
// os.tmpdir() is not inside one on any supported platform, and the assertions
// below would fail loudly rather than silently if it ever were.
function withLocale(locale, fn) {
  const saved = { LC_ALL: process.env.LC_ALL, LANGUAGE: process.env.LANGUAGE, LANG: process.env.LANG };
  process.env.LC_ALL = locale;
  process.env.LANGUAGE = locale;
  process.env.LANG = locale;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

test('real git: a directory outside any repository is reported as its own reason, in every locale', async () => {
  const results = [];
  for (const locale of LOCALES) {
    const tmp = mkTmp();
    try {
      await withLocale(locale, async () => {
        const result = await createGitChangesRunner({ kind: 'local', cwd: tmp }).status();
        assert.equal(result.ok, false, `${locale}: no repository, no changes`);
        assert.equal(result.reason, NOT_A_REPO_REASON, `${locale}: the outcome is machine-readable`);
        assert.doesNotMatch(result.error, /fatal|dépôt|GIT_DISCOVERY|usage/,
          `${locale}: git's own text must not become the panel's message`);
        results.push(result);
      });
    } finally { cleanup(tmp); }
  }
  assert.deepEqual(results[1], results[0], 'the two locales must produce byte-identical outcomes');
});

test('real git: isWorkTree() answers by exit code, in every locale', async () => {
  for (const locale of LOCALES) {
    const tmp = mkTmp();
    try {
      const repoDir = path.join(tmp, 'repo');
      initRepo(repoDir);
      await withLocale(locale, async () => {
        assert.deepEqual(await createGitChangesRunner({ kind: 'local', cwd: repoDir }).isWorkTree(),
          { ok: true, isRepo: true }, `${locale}: a real repository`);
        assert.deepEqual(await createGitChangesRunner({ kind: 'local', cwd: tmp }).isWorkTree(),
          { ok: true, isRepo: false }, `${locale}: its parent, which is not one`);
      });
    } finally { cleanup(tmp); }
  }
});

test('real git: a subdirectory of a repository is still inside the work tree', async () => {
  const tmp = mkTmp();
  try {
    const repoDir = path.join(tmp, 'repo');
    initRepo(repoDir);
    const sub = path.join(repoDir, 'nested', 'deeper');
    fs.mkdirSync(sub, { recursive: true });

    assert.deepEqual(await createGitChangesRunner({ kind: 'local', cwd: sub }).isWorkTree(), { ok: true, isRepo: true },
      'a session recorded in a subdirectory must keep its Changes panel');
  } finally { cleanup(tmp); }
});
