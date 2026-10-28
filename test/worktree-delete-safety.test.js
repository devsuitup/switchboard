'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const deletion = require('../worktree-delete');
const vm = require('node:vm');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-delete-safety-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 't'), 'dirty one');
  const state = { removes: [], paths: ['t'], submodule: false, ignored: ['!! node_modules/'], ...options };
  const runGit = async args => {
    if (args.includes('rev-parse')) return path.join(root, '.git', 'locked') + '\n';
    if (args.includes('list')) {
      if (options.oldGit) assert.equal(args.includes('-z'), false, 'Git 2.24 cannot list worktrees with -z');
      const fields = [`worktree ${args.includes('-z') ? root : JSON.stringify(root)}`, 'HEAD abc', 'branch refs/heads/topic'];
      return fields.join(args.includes('-z') ? '\0' : '\n') + (args.includes('-z') ? '\0\0' : '\n\n');
    }
    if (args.includes('ls-files')) return state.submodule ? '160000 abc 0\tsub\0' : '';
    if (args.includes('status')) {
      const all = args.includes('--untracked-files=all');
      const dirty = state.paths.flatMap(file => file === 't' ? [' M t']
        : (!all && state.hideUntracked) ? [] : ['?? ' + (all ? file : file.split('/')[0] + '/')]);
      return [...new Set(dirty), ...(args.includes('--ignored') ? state.ignored : [])].join('\0') + '\0';
    }
    state.removes.push(args);
    return '';
  };
  const read = () => deletion.readStatus(root, root, runGit);
  return { root, state, read, remove: shown => deletion.removeWorktree(root, root, shown, read, runGit) };
}

test('Git 2.24 preview accepts quoted worktree paths without list -z', async t => {
  const f = fixture(t, { oldGit: true });
  assert.equal((await f.read()).branch, 'topic');
});

test('old Git lock files require fresh explicit consent before double force', async t => {
  const f = fixture(t, { oldGit: true, paths: [] });
  const unlocked = await f.read();
  fs.mkdirSync(path.join(f.root, '.git'));
  const lockFile = path.join(f.root, '.git', 'locked');
  fs.writeFileSync(lockFile, ' backup disk\n');
  const shown = await f.read();
  assert.equal(shown.locked, true);
  assert.equal(shown.lockReason, 'backup disk');
  assert.notEqual(shown.fingerprint, unlocked.fingerprint);
  assert.equal((await f.remove(unlocked)).refresh, true);
  assert.equal((await f.remove(shown)).refresh, true);
  fs.writeFileSync(lockFile, 'another owner\n');
  assert.equal((await f.remove({ ...shown, confirmLocked: true })).refresh, true);
  assert.equal(f.state.removes.length, 0);
  assert.equal((await f.remove({ ...await f.read(), confirmLocked: true })).ok, true);
  assert.equal(f.state.removes[0].filter(arg => arg === '-f').length, 2);
});

test('a new file inside an untracked folder invalidates confirmed deletion', async t => {
  const f = fixture(t, { paths: ['scratch/a'] });
  fs.mkdirSync(path.join(f.root, 'scratch'));
  fs.writeFileSync(path.join(f.root, 'scratch/a'), 'a');
  let shown;
  await assert.doesNotReject(async () => { shown = await f.read(); });
  fs.writeFileSync(path.join(f.root, 'scratch/b'), 'b');
  f.state.paths.push('scratch/b');
  assert.equal((await f.remove(shown)).refresh, true);
  assert.equal(f.state.removes.length, 0);
});

test('status.showUntrackedFiles=no cannot hide files or authorize unforced removal', async t => {
  const f = fixture(t, { paths: ['untracked.txt'], hideUntracked: true });
  fs.writeFileSync(path.join(f.root, 'untracked.txt'), 'keep');
  const shown = await f.read();
  assert.deepEqual(shown.dirty, ['?? untracked.txt']);
  assert.equal((await f.remove(shown)).ok, true);
  assert.equal(f.state.removes[0].filter(arg => arg === '-f').length, 1);
});

test('editing an already dirty file with identical size and mtime refuses removal', async t => {
  const f = fixture(t);
  const file = path.join(f.root, 't');
  const before = fs.statSync(file);
  const shown = await f.read();
  fs.writeFileSync(file, 'dirty two');
  fs.utimesSync(file, before.atime, before.mtime);
  assert.equal((await f.remove(shown)).refresh, true);
  assert.equal(f.state.removes.length, 0);
});

test('clean submodules require their own explicit force consent', async t => {
  const f = fixture(t, { paths: [], submodule: true });
  const shown = await f.read();
  assert.deepEqual(shown.submodules, ['sub']);
  assert.equal((await f.remove(shown)).refresh, true);
  assert.equal(f.state.removes.length, 0);
  assert.equal((await f.remove({ ...shown, confirmSubmodules: true })).ok, true);
  assert.equal(f.state.removes[0].filter(arg => arg === '-f').length, 1);
});

test('worktree removal has a longer timeout than preview Git calls', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const options = [];
  const context = vm.createContext({ localGitEnv: () => ({}),
    execFile: (_exe, _args, opts, callback) => { options.push(opts); callback(null, '', ''); } });
  vm.runInContext(source.slice(source.indexOf('function worktreeGit('),
    source.indexOf('async function worktreeDeletionStatus(')), context, { filename: path.join(__dirname, '../main.js') });
  await context.worktreeGit(['worktree', 'list', '--porcelain']);
  await context.worktreeGit(['worktree', 'remove', '--', '/temp/task']);
  assert.equal(options[0].timeout, 15000);
  assert.equal(options[1].timeout, 120000);
});

test('Git C-quoted paths decode octal UTF-8 and escaped control characters', async () => {
  const target = '/repo/été\t"\\\n';
  const listed = '"/repo/\\303\\251t\\303\\251\\t\\"\\\\\\n"';
  let shown;
  await assert.doesNotReject(async () => {
    shown = await deletion.readStatus(target, '/repo', async args => args.includes('list')
      ? `worktree ${listed}\nHEAD abc\nbranch refs/heads/topic\n\n` : args.includes('rev-parse') ? '.git/locked\n' : '');
  });
  assert.equal(shown.branch, 'topic');
});

test('a rename source beginning with !! is not counted as ignored', async t => {
  const f = fixture(t);
  const shown = await deletion.readStatus(f.root, f.root, async args => {
    if (args.includes('rev-parse')) return path.join(f.root, '.git', 'locked') + '\n';
    if (args.includes('list')) return `worktree ${f.root}\nHEAD abc\n\n`;
    if (args.includes('ls-files')) return '';
    return 'R  destination\0!! source\0';
  });
  assert.equal(shown.ignoredCount, 0);
});

test('a staged content change invalidates confirmation even when working bytes stay identical', async t => {
  const f = fixture(t);
  let index = '100644 abc 0\tt\0';
  const runGit = async args => args.includes('list') ? `worktree ${f.root}\nHEAD abc\n\n`
    : args.includes('rev-parse') ? path.join(f.root, '.git', 'locked') + '\n' : args.includes('ls-files') ? index : 'MM t\0';
  const read = () => deletion.readStatus(f.root, f.root, runGit);
  const shown = await read();
  index = '100644 def 0\tt\0';
  assert.equal((await deletion.removeWorktree(f.root, f.root, shown, read, async () => assert.fail('must not remove'))).refresh, true);
});

test('content changes inside a dirty submodule invalidate explicit force consent', async t => {
  const f = fixture(t);
  const sub = path.join(f.root, 'sub');
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, 't'), 'before');
  const runGit = async args => {
    if (args.includes('rev-parse')) return path.join(f.root, '.git', 'locked') + '\n';
    if (args.includes('list')) return `worktree ${f.root}\nHEAD abc\n\n`;
    const nested = args[1] === sub;
    if (args.includes('ls-files')) return nested ? '100644 abc 0\tt\0' : '160000 abc 0\tsub\0';
    return nested ? ' M t\0' : ' M sub\0';
  };
  const read = () => deletion.readStatus(f.root, f.root, runGit);
  const shown = await read();
  fs.writeFileSync(path.join(sub, 't'), 'after!');
  assert.equal((await deletion.removeWorktree(f.root, f.root, { ...shown, confirmSubmodules: true },
    read, async () => assert.fail('must not remove'))).refresh, true);
});
