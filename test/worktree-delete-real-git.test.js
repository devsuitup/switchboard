'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { localGitEnv } = require('../git-changes-runner');
const deletion = require('../worktree-delete');

function fixture(t, mainOnly = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-delete-real-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...localGitEnv(), GIT_CONFIG_GLOBAL: path.join(root, 'no-global-config'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
  const git = (cwd, args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
  git(root, ['init', '-q', '--template=']);
  fs.writeFileSync(path.join(root, 't'), 'base\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'fixture']);
  const target = mainOnly ? root : path.join(root, 'work tree é');
  if (!mainOnly) git(root, ['worktree', 'add', '-qb', 'topic', target]);
  const removes = [];
  const runGit = async (args, consume) => {
    if (args.includes('remove')) {
      assert.equal(mainOnly, false, 'never remove the main working tree');
      removes.push(args);
    }
    if (consume) return deletion.streamGit(args, consume, { env });
    return git(root, args);
  };
  const read = () => deletion.readStatus(target, root, runGit);
  return { root, target, git: args => git(target, args), removes, read,
    remove: shown => deletion.removeWorktree(target, root, shown, read, runGit) };
}

test('real git removes a confirmed clean worktree without force', async t => {
  const f = fixture(t);
  assert.equal((await f.remove(await f.read())).ok, true);
  assert.equal(f.removes[0].includes('-f'), false);
  assert.equal(fs.existsSync(f.target), false);
});

test('real git refuses a new file inside an already untracked directory', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.target, 'scratch'));
  fs.writeFileSync(path.join(f.target, 'scratch/a'), 'a');
  const shown = await f.read();
  fs.writeFileSync(path.join(f.target, 'scratch/b'), 'b');
  assert.equal((await f.remove(shown)).refresh, true);
  assert.equal(f.removes.length, 0);
  assert.equal(fs.readFileSync(path.join(f.target, 'scratch/b'), 'utf8'), 'b');
});

test('real git overrides hidden untracked config and requires force for an untracked file', async t => {
  const f = fixture(t);
  f.git(['config', 'status.showUntrackedFiles', 'no']);
  fs.writeFileSync(path.join(f.target, 'untracked.txt'), 'keep');
  const shown = await f.read();
  assert.deepEqual(shown.dirty, ['?? untracked.txt']);
  assert.equal((await f.remove(shown)).ok, true);
  assert.equal(f.removes[0].filter(arg => arg === '-f').length, 1);
});

test('real git refuses changed contents of an already dirty file', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.target, 't'), 'dirty one');
  const shown = await f.read();
  fs.writeFileSync(path.join(f.target, 't'), 'dirty two');
  assert.equal((await f.remove(shown)).refresh, true);
  assert.equal(f.removes.length, 0);
});

test('real git requires renewed explicit consent for a locked worktree', async t => {
  const f = fixture(t);
  f.git(['worktree', 'lock', '--reason', 'backup', f.target]);
  const shown = await f.read();
  assert.equal(shown.locked, true);
  assert.equal(shown.lockReason, 'backup');
  assert.equal((await f.remove(shown)).refresh, true);
  assert.equal(f.removes.length, 0);
  assert.equal((await f.remove({ ...shown, confirmLocked: true })).ok, true);
  assert.equal(f.removes[0].filter(arg => arg === '-f').length, 2);
});

test('real git keeps ignored directories collapsed even with all untracked paths', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.target, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(f.target, 'node_modules/pkg/a'), 'ignored');
  fs.writeFileSync(path.join(f.target, 'node_modules/pkg/b'), 'ignored');
  const shown = await f.read();
  assert.equal(shown.ignoredCount, 1);
  assert.deepEqual(shown.dirty, []);
});

test('real git snapshot expands untracked paths, ignores config, and collapses ignored directories', async t => {
  const f = fixture(t, true);
  f.git(['config', 'status.showUntrackedFiles', 'no']);
  fs.mkdirSync(path.join(f.target, 'scratch'));
  fs.writeFileSync(path.join(f.target, 'scratch/a'), 'a');
  fs.mkdirSync(path.join(f.target, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(f.target, 'node_modules/pkg/a'), 'ignored');
  fs.writeFileSync(path.join(f.target, 'node_modules/pkg/b'), 'ignored');
  const shown = await f.read();
  assert.deepEqual(shown.dirty, ['?? scratch/a']);
  assert.equal(shown.ignoredCount, 1);
  fs.writeFileSync(path.join(f.target, 'scratch/b'), 'b');
  assert.notEqual((await f.read()).fingerprint, shown.fingerprint);
});

test('real git snapshot detects content changes with unchanged dirty status', async t => {
  const f = fixture(t, true);
  fs.writeFileSync(path.join(f.target, 't'), 'dirty one');
  const shown = await f.read();
  fs.writeFileSync(path.join(f.target, 't'), 'dirty two');
  const fresh = await f.read();
  assert.deepEqual(fresh.dirty, shown.dirty);
  assert.notEqual(fresh.fingerprint, shown.fingerprint);
});

test('real git previews an uninitialised gitlink directory without recursing into its parent', async t => {
  const f = fixture(t, true);
  const head = f.git(['rev-parse', 'HEAD']).trim();
  f.git(['update-index', '--add', '--cacheinfo', `160000,${head},sm`]);
  fs.mkdirSync(path.join(f.target, 'sm'));
  const shown = await f.read();
  assert.deepEqual(shown.submodules, ['sm']);
  assert.deepEqual(shown.dirty, ['A  sm']);
});

for (const kind of ['junction', 'dir']) {
  for (const name of ['node_modules', 'lnk']) {
    for (const mainOnly of [true, false]) {
      test(`real git refuses directory ${kind} link ${name} without touching its target (${mainOnly ? 'main snapshot' : 'linked worktree'})`, {
        skip: kind === 'junction' && process.platform !== 'win32' ? 'Windows junction regression; POSIX symlink case runs here' : false,
      }, async t => {
        const f = fixture(t, mainOnly);
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-delete-link-target-'));
        t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
        const precious = path.join(outside, 'precious');
        fs.writeFileSync(precious, 'keep');
        const shown = await f.read();
        const link = path.join(f.target, name);
        try { fs.symlinkSync(outside, link, kind); }
        catch (error) {
          if (kind === 'dir' && process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
            t.skip('Windows directory symlinks require Developer Mode or privilege; junction case remains enabled');
            return;
          }
          throw error;
        }
        try {
          await assert.rejects(f.read(), /directory link.*(?:node_modules|lnk)|(?:node_modules|lnk).*directory link/is);
          await assert.rejects(f.remove(shown), /directory link/is);
          assert.equal(f.removes.length, 0);
          assert.equal(fs.existsSync(precious), true);
          assert.equal(fs.readFileSync(precious, 'utf8'), 'keep');
        } finally { fs.unlinkSync(link); }
      });
    }
  }
}
