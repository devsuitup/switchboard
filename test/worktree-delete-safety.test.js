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
  const state = { removes: [], calls: [], paths: ['t'], submodule: false, ignored: ['!! node_modules/'], ...options };
  const runGit = async args => {
    state.calls.push(args);
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
  fs.writeFileSync(path.join(sub, '.git'), 'gitdir: unused-test-metadata');
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

test('directory links are refused at preview and again at removal, including ignored nested links', async t => {
  const f = fixture(t, { paths: [] });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-delete-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'precious'), 'keep');
  fs.mkdirSync(path.join(f.root, 'node_modules'));
  const shown = await f.read();
  const link = path.join(f.root, 'node_modules/pkg');
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    await assert.rejects(f.read(), /directory link.*node_modules[\\/]pkg/is);
    await assert.rejects(f.remove(shown), /remove the link first/i);
    assert.equal(f.state.removes.length, 0);
    assert.equal(fs.readFileSync(path.join(outside, 'precious'), 'utf8'), 'keep');
  } finally { fs.unlinkSync(link); }
});

test('uninitialised gitlink directories do not recurse into the parent repository', async t => {
  const f = fixture(t, { paths: ['sub'], submodule: true });
  fs.mkdirSync(path.join(f.root, 'sub'));
  const shown = await f.read();
  assert.deepEqual(shown.submodules, ['sub']);
  assert.equal(f.state.calls.some(args => args[1] === path.join(f.root, 'sub')), false);
  assert.equal((await f.remove({ ...shown, confirmSubmodules: true })).ok, true);
});

test('preview refuses clearly above the total hash budget and names the oversized file', async t => {
  const f = fixture(t, { paths: ['huge.bin'] });
  const fd = fs.openSync(path.join(f.root, 'huge.bin'), 'w');
  fs.ftruncateSync(fd, 513 * 1024 * 1024);
  fs.closeSync(fd);
  await assert.rejects(f.read(), /512 MiB.*huge\.bin/s);
});

test('the hash cap applies to the total of multiple files and names the largest ones encountered', async t => {
  const f = fixture(t, { paths: ['first.bin', 'second.bin'] });
  for (const name of f.state.paths) {
    const fd = fs.openSync(path.join(f.root, name), 'w');
    fs.ftruncateSync(fd, 257 * 1024 * 1024);
    fs.closeSync(fd);
  }
  await assert.rejects(f.read(), /512 MiB.*first\.bin.*second\.bin/s);
});

test('index output can be streamed beyond maxBuffer without buffering its contents', async t => {
  const f = fixture(t, { paths: [] });
  const git = async (args, consume) => {
    if (args.includes('ls-files')) {
      assert.equal(typeof consume, 'function', 'index must use the stream');
      const chunk = Buffer.from('100644 abc 0\tt\0'.repeat(10000));
      for (let i = 0; i < 130; i++) consume(chunk);
      return;
    }
    if (args.includes('list')) return `worktree ${f.root}\nHEAD abc\n\n`;
    if (args.includes('rev-parse')) return path.join(f.root, '.git', 'locked') + '\n';
    return '';
  };
  assert.equal((await deletion.readStatus(f.root, f.root, git)).ok, true);
});

for (const error of [Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }),
  Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' })]) {
  test(`preview explains Git resource refusal: ${error.message}`, async t => {
    const f = fixture(t);
    await assert.rejects(deletion.readStatus(f.root, f.root, async () => { throw error; }), /preview.*(?:too large|timed out).*review/is);
  });
}

test('interrupted removal warns about partial deletion without attempting a fresh preview', async () => {
  const shown = { fingerprint: 'same', dirty: [], locked: false };
  let reads = 0;
  const result = await deletion.removeWorktree('/temp/task', '/temp/repo', shown, async () => {
    assert.equal(++reads, 1);
    return shown;
  }, async () => { throw Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM' }); });
  assert.equal(result.ok, false);
  assert.match(result.error, /removal was interrupted; the folder may be partly deleted/i);
  assert.match(result.error, /review/i);
});

test('an untracked embedded repository is named as a nested repository', async t => {
  const f = fixture(t, { paths: ['embedded/'] });
  fs.mkdirSync(path.join(f.root, 'embedded/.git'), { recursive: true });
  await assert.rejects(f.read(), /embedded.*nested repository.*review/is);
});

test('on-disk containment blocks a directory link created after the initial scan', async t => {
  const f = fixture(t, { paths: [] });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-delete-raced-link-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'precious'), 'keep');
  const link = path.join(f.root, 'lnk');
  const git = async args => {
    if (args.includes('list')) return `worktree ${f.root}\nHEAD abc\n\n`;
    if (args.includes('rev-parse')) return path.join(f.root, '.git', 'locked') + '\n';
    if (args.includes('status')) {
      if (!fs.existsSync(link)) fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
      return '?? lnk/precious\0';
    }
    return '';
  };
  try { await assert.rejects(deletion.readStatus(f.root, f.root, git), /outside the worktree/i); }
  finally { if (fs.existsSync(link)) fs.unlinkSync(link); }
});

test('the last check before removal refuses links even when the supplied reader misses them', async t => {
  const f = fixture(t, { paths: [] });
  const shown = await f.read();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-delete-last-link-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'precious'), 'keep');
  const links = Array.from({ length: 12 }, (_, i) => path.join(f.root, `lnk-${i}`));
  for (const link of links) fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    await assert.rejects(deletion.removeWorktree(f.root, f.root, shown, async () => shown,
      async () => assert.fail('must not remove')), error => {
      assert.match(error.message, /12 directory link/);
      assert.match(error.message, /2 more/);
      assert.equal((error.message.match(/lnk-/g) || []).length, 10);
      return true;
    });
    assert.equal(fs.existsSync(path.join(outside, 'precious')), true);
  } finally { for (const link of links) fs.unlinkSync(link); }
});
