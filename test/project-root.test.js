// see .ai/contexts/bg-agents.md
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  projectRootFromPattern, worktreeRootFromPattern, rootFromCommonDir, resolveProjectRoots, gitEnv, GIT_TIMEOUT_MS,
} = require('../project-root');

test('pattern: a cwd under <root>/.claude/worktrees/<name> resolves to <root>, any separator, nested, trailing slash', () => {
  assert.equal(projectRootFromPattern('/home/u/repo/.claude/worktrees/feat'), '/home/u/repo');
  assert.equal(projectRootFromPattern('/home/u/repo/.claude/worktrees/feat/'), '/home/u/repo');
  assert.equal(projectRootFromPattern('/home/u/repo/.claude/worktrees/feat/src/lib'), '/home/u/repo');
  assert.equal(projectRootFromPattern('C:\\code\\repo\\.claude\\worktrees\\feat'), 'C:\\code\\repo');
  assert.equal(projectRootFromPattern('C:\\code\\repo\\.claude\\worktrees\\feat\\sub'), 'C:\\code\\repo');
  assert.equal(projectRootFromPattern('/a/repo/.claude/worktrees/x/.claude/worktrees/y'), '/a/repo');
});

test('pattern: the worktree root is <root>/.claude/worktrees/<name>, whatever subdirectory the cwd is in', () => {
  assert.equal(worktreeRootFromPattern('/home/u/repo/.claude/worktrees/feat'), '/home/u/repo/.claude/worktrees/feat');
  assert.equal(worktreeRootFromPattern('/home/u/repo/.claude/worktrees/feat/'), '/home/u/repo/.claude/worktrees/feat');
  assert.equal(worktreeRootFromPattern('/home/u/repo/.claude/worktrees/feat/src/lib'), '/home/u/repo/.claude/worktrees/feat');
  assert.equal(worktreeRootFromPattern('C:\\code\\repo\\.claude\\worktrees\\feat\\sub'), 'C:\\code\\repo\\.claude\\worktrees\\feat');
  assert.equal(worktreeRootFromPattern('/a/repo/.claude/worktrees/x/.claude/worktrees/y'), '/a/repo/.claude/worktrees/x');
  assert.equal(worktreeRootFromPattern('/home/u/repo'), null);
});

test('pattern: anything else is not a match', () => {
  assert.equal(projectRootFromPattern('/home/u/worktrees/feat'), null);
  assert.equal(projectRootFromPattern('/home/u/repo/.worktrees/feat'), null);
  assert.equal(projectRootFromPattern('/home/u/repo/claude/worktrees/feat'), null);
  assert.equal(projectRootFromPattern('/home/u/repo/.claude/worktrees'), null);
  assert.equal(projectRootFromPattern('/home/u/repo/.claude/worktrees/'), null);
  assert.equal(projectRootFromPattern('/home/u/repo'), null);
  assert.equal(projectRootFromPattern(''), null);
  assert.equal(projectRootFromPattern(null), null);
  assert.equal(worktreeRootFromPattern('/home/u/worktrees/feat'), null);
});

test('common dir: <root>/.git gives <root>; a bare repo or a submodule module dir gives null', () => {
  assert.equal(rootFromCommonDir('/home/u/repo/.git'), '/home/u/repo');
  assert.equal(rootFromCommonDir('/home/u/repo.git'), null);
  assert.equal(rootFromCommonDir('/home/u/super/.git/modules/sub'), null);
  assert.equal(rootFromCommonDir(''), null);
});

test('git env: GIT_* variables of the caller are dropped', () => {
  const env = gitEnv({ PATH: '/bin', GIT_DIR: '/x/.git', GIT_INDEX_FILE: '/x/.git/index', HOME: '/h' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h' });
});

function hasGit() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

function git(cwd, args) {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args],
    { cwd, stdio: 'ignore', env: gitEnv(process.env) });
}

test('a real repo: main checkout, subdirectories and `git worktree add` directories resolve to the main root and their own worktree', async (t) => {
  if (!hasGit()) { t.skip('git not available'); return; }
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-project-root-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
  git(repo, ['init', '-q']);
  git(repo, ['commit', '-q', '--allow-empty', '-m', 'init']);
  const wt = path.join(tmp, 'elsewhere', 'wt-feat');
  git(repo, ['worktree', 'add', '-q', wt]);
  fs.mkdirSync(path.join(wt, 'deep', 'er'), { recursive: true });
  const claudeWt = path.join(repo, '.claude', 'worktrees', 'agent-x');
  git(repo, ['worktree', 'add', '-q', claudeWt]);
  const plain = path.join(tmp, 'plain');
  fs.mkdirSync(plain);
  assert.deepEqual(await resolveProjectRoots(repo), { projectRoot: repo, worktreeRoot: repo });
  assert.deepEqual(await resolveProjectRoots(path.join(repo, 'sub')), { projectRoot: repo, worktreeRoot: repo });
  assert.deepEqual(await resolveProjectRoots(wt), { projectRoot: repo, worktreeRoot: wt });
  assert.deepEqual(await resolveProjectRoots(path.join(wt, 'deep', 'er')), { projectRoot: repo, worktreeRoot: wt });
  assert.deepEqual(await resolveProjectRoots(claudeWt), { projectRoot: repo, worktreeRoot: claudeWt });
  assert.deepEqual(await resolveProjectRoots(plain), { projectRoot: plain, worktreeRoot: plain });
});

test('no git call for the pattern, a missing dir or an empty cwd; a failing or throwing runner falls back to the cwd', async () => {
  const calls = [];
  const execFile = (cmd, args, opts, cb) => { calls.push(args); cb(new Error('boom'), '', ''); };
  assert.deepEqual(await resolveProjectRoots('/nope/repo/.claude/worktrees/gone/src', { execFile }),
    { projectRoot: '/nope/repo', worktreeRoot: '/nope/repo/.claude/worktrees/gone' });
  assert.deepEqual(await resolveProjectRoots('/nope/does-not-exist', { execFile }),
    { projectRoot: '/nope/does-not-exist', worktreeRoot: '/nope/does-not-exist' });
  assert.deepEqual(await resolveProjectRoots(null, { execFile }), { projectRoot: null, worktreeRoot: null });
  assert.equal(calls.length, 0);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-project-root-'));
  try {
    assert.deepEqual(await resolveProjectRoots(tmp, { execFile }), { projectRoot: tmp, worktreeRoot: tmp });
    assert.equal(calls.length, 1);
    const thrower = () => { throw new Error('spawn failed'); };
    assert.deepEqual(await resolveProjectRoots(tmp, { execFile: thrower }), { projectRoot: tmp, worktreeRoot: tmp });
    const relative = (cmd, args, opts, cb) => cb(null, '.git\n' + tmp + '\n', '');
    assert.deepEqual(await resolveProjectRoots(tmp, { execFile: relative }), { projectRoot: tmp, worktreeRoot: tmp });
    const bare = (cmd, args, opts, cb) => cb(null, '/srv/x.git\n' + tmp + '\n', '');
    assert.deepEqual(await resolveProjectRoots(tmp, { execFile: bare }), { projectRoot: tmp, worktreeRoot: tmp });
    const seen = [];
    const spy = (cmd, args, opts, cb) => { seen.push({ cmd, args, opts }); cb(null, path.join(tmp, '.git') + '\n' + tmp + '\n', ''); };
    await resolveProjectRoots(tmp, { execFile: spy, env: { GIT_DIR: '/x', PATH: '/bin' } });
    assert.equal(seen[0].cmd, 'git');
    assert.deepEqual(seen[0].args, ['-C', tmp, 'rev-parse', '--git-common-dir', '--show-toplevel']);
    assert.equal(seen[0].opts.cwd, tmp);
    assert.equal(seen[0].opts.timeout, GIT_TIMEOUT_MS);
    assert.ok(GIT_TIMEOUT_MS > 0 && GIT_TIMEOUT_MS <= 2000);
    assert.equal(seen[0].opts.shell, undefined);
    assert.equal(seen[0].opts.env.GIT_DIR, undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
