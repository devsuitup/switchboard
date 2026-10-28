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
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-delete-real-')));
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

test('real git previews a registered worktree through a noncanonical ancestor and refuses an unregistered path', async t => {
  const f = fixture(t);
  const aliases = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-delete-alias-')));
  const link = path.join(aliases, 'parent');
  t.after(() => {
    fs.unlinkSync(link);
    fs.rmSync(aliases, { recursive: true, force: true });
  });
  fs.symlinkSync(path.dirname(f.root), link, process.platform === 'win32' ? 'junction' : 'dir');
  const aliasRoot = path.join(link, path.basename(f.root), path.basename(f.target));
  assert.notEqual(aliasRoot, f.target);
  assert.equal(fs.realpathSync.native(aliasRoot), f.target);
  const runGit = args => Promise.resolve(f.git(args));
  const shown = await deletion.readStatus(aliasRoot, f.root, runGit);
  assert.equal(shown.ok, true);
  assert.deepEqual(shown.dirty, []);
  const shortRoot = path.join(os.tmpdir(), path.basename(f.root), path.basename(f.target));
  assert.equal((await deletion.readStatus(shortRoot, f.root, runGit)).ok, true);
  const aliasList = args => args.includes('list') ? Promise.resolve(`worktree ${JSON.stringify(f.root)}\nHEAD def\n\nworktree ${JSON.stringify(aliasRoot)}\nHEAD abc\n\n`) : runGit(args);
  assert.equal((await deletion.readStatus(f.target, f.root, aliasList)).ok, true);
  const unregistered = path.join(f.root, 'unregistered');
  fs.mkdirSync(unregistered);
  await assert.rejects(deletion.readStatus(unregistered, f.root, runGit), /no longer a registered worktree/);
  assert.equal(fs.existsSync(f.root), true);
  assert.equal(f.removes.length, 0);
});

test('real git refuses the main checkout, including a path through an alias ancestor', async t => {
  const f = fixture(t, true);
  const alias = path.join(path.dirname(f.root), path.basename(f.root) + '-alias');
  fs.symlinkSync(path.dirname(f.root), alias, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => fs.unlinkSync(alias));
  for (const requested of [f.root, path.join(alias, path.basename(f.root))]) {
    const read = () => deletion.readStatus(requested, f.root, args => Promise.resolve(f.git(args)));
    await assert.rejects(read(), /main worktree.*cannot be deleted/i);
    await assert.rejects(deletion.removeWorktree(requested, f.root, { fingerprint: 'old' }, read,
      async () => assert.fail('must not remove the main checkout')), /main worktree.*cannot be deleted/i);
  }
  assert.equal(f.removes.length, 0);
});

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
  const f = fixture(t);
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
  const f = fixture(t);
  fs.writeFileSync(path.join(f.target, 't'), 'dirty one');
  const shown = await f.read();
  fs.writeFileSync(path.join(f.target, 't'), 'dirty two');
  const fresh = await f.read();
  assert.deepEqual(fresh.dirty, shown.dirty);
  assert.notEqual(fresh.fingerprint, shown.fingerprint);
});

test('real git previews an uninitialised gitlink directory without recursing into its parent', async t => {
  const f = fixture(t);
  const head = f.git(['rev-parse', 'HEAD']).trim();
  f.git(['update-index', '--add', '--cacheinfo', `160000,${head},sm`]);
  fs.mkdirSync(path.join(f.target, 'sm'));
  const shown = await f.read();
  assert.deepEqual(shown.submodules, ['sm']);
  assert.deepEqual(shown.dirty, ['A  sm']);
});

for (const kind of ['junction', 'dir']) {
  for (const name of ['node_modules', 'lnk']) {
    test(`real git refuses directory ${kind} link ${name} without touching its target (linked worktree)`, {
      skip: kind === 'junction' && process.platform !== 'win32' ? 'Windows junction regression; POSIX symlink case runs here' : false,
    }, async t => {
      const f = fixture(t);
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

test(`real git applies the platform rule to an inside link sorting after its target (linked worktree removal)`, async t => {
  const f = fixture(t);
  const target = path.join(f.target, 'node_modules/pkg');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'contents'), 'internal');
  const shownBeforeLink = await f.read();
  const registration = f.git(['worktree', 'list', '--porcelain']);
  const link = path.join(f.target, 'node_modules/zz-alias');
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    if (process.platform === 'win32') {
      await assert.rejects(f.read(), /directory link.*zz-alias.*remove the link first/is);
      await assert.rejects(f.remove(shownBeforeLink), /directory link/is);
      assert.equal(f.removes.length, 0);
      assert.equal(fs.readFileSync(path.join(target, 'contents'), 'utf8'), 'internal');
      assert.equal(fs.existsSync(path.join(f.target, '.git')), true);
      assert.equal(f.git(['worktree', 'list', '--porcelain']), registration);
      return;
    }
    let shown;
    await assert.doesNotReject(async () => { shown = await f.read(); });
    assert.deepEqual(shown.dirty, []);
    assert.equal((await f.remove(shown)).ok, true);
    assert.equal(fs.existsSync(target), false, 'Git normally deletes the target inside the removed worktree');
    assert.equal(fs.existsSync(f.target), false);
  } finally { if (fs.existsSync(link)) fs.unlinkSync(link); }
});

test(`real git refuses a Windows junction to the worktree root (linked worktree removal)`, {
  skip: process.platform !== 'win32' ? 'Windows junction regression' : false,
}, async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.target, 'node_modules'));
  const shown = await f.read();
  const registration = f.git(['worktree', 'list', '--porcelain']);
  const link = path.join(f.target, 'node_modules/J');
  fs.symlinkSync(f.target, link, 'junction');
  try {
    await assert.rejects(f.read(), /directory link.*node_modules[\\/]J/is);
    await assert.rejects(f.remove(shown), /directory link/is);
    assert.equal(f.removes.length, 0);
    assert.equal(fs.readFileSync(path.join(f.target, 't'), 'utf8'), 'base\n');
    assert.equal(fs.existsSync(path.join(f.target, '.git')), true);
    assert.equal(f.git(['worktree', 'list', '--porcelain']), registration);
  } finally { fs.unlinkSync(link); }
});

test(`real git refuses stray files in a clean uninitialised gitlink (linked worktree removal)`, async t => {
  const f = fixture(t);
  const head = f.git(['rev-parse', 'HEAD']).trim();
  f.git(['update-index', '--add', '--cacheinfo', `160000,${head},sm`]);
  f.git(['commit', '-qm', 'add gitlink']);
  fs.mkdirSync(path.join(f.target, 'sm'));
  const shown = await f.read();
  assert.deepEqual(shown.dirty, []);
  fs.writeFileSync(path.join(f.target, 'sm/stray.txt'), 'keep');
  assert.equal(f.git(['status', '--porcelain=v1', '--ignore-submodules=none']), '', 'Git itself hides the stray file');
  await assert.rejects(f.read(), /uninitialised submodule sm is not empty.*review/is);
  await assert.rejects(f.remove({ ...shown, confirmSubmodules: true }), /uninitialised submodule sm is not empty/is);
  assert.equal(f.removes.length, 0);
  assert.equal(fs.readFileSync(path.join(f.target, 'sm/stray.txt'), 'utf8'), 'keep');
});
