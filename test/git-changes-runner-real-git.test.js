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

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { createGitChangesRunner } = require('../git-changes-runner');

function mkTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-gcr-real-'));
  // Windows can hand back a short (8.3) TEMP path (e.g. "JEAN-B~1"); git's
  // own containment check resolves the repo root through its long form and
  // then rejects a short-form pathspec as "outside repository" even when it
  // points at the same file — an environment quirk, not the thing under
  // test. Canonicalize once so cwd and every pathspec built from `dir` agree.
  return fs.realpathSync.native(dir);
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
