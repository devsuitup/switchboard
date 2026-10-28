'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const deletion = require('../worktree-delete');
const vm = require('node:vm');

function fixture(t, options = {}) {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-delete-safety-'));
  const root = options.preserveSpelling ? created : fs.realpathSync.native(created);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 't'), 'dirty one');
  const state = { removes: [], calls: [], paths: ['t'], submodule: false, ignored: ['!! node_modules/'], ...options };
  const runGit = async args => {
    state.calls.push(args);
    if (args.includes('rev-parse')) return path.join(root, '.git', 'locked') + '\n';
    if (args.includes('list')) {
      if (options.oldGit) assert.equal(args.includes('-z'), false, 'Git 2.24 cannot list worktrees with -z');
      const fields = [`worktree ${args.includes('-z') ? root : JSON.stringify(root)}`, 'HEAD abc', 'branch refs/heads/topic'];
      return 'worktree /main-checkout\nHEAD def\n\n' + fields.join(args.includes('-z') ? '\0' : '\n') + (args.includes('-z') ? '\0\0' : '\n\n');
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
  return { root, state, read, runGit, remove: shown => deletion.removeWorktree(root, root, shown, read, runGit) };
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
      ? `worktree /main-checkout\nHEAD def\n\nworktree ${listed}\nHEAD abc\nbranch refs/heads/topic\n\n` : args.includes('rev-parse') ? '.git/locked\n' : '');
  });
  assert.equal(shown.branch, 'topic');
});

test('a rename source beginning with !! is not counted as ignored', async t => {
  const f = fixture(t);
  const shown = await deletion.readStatus(f.root, f.root, async args => {
    if (args.includes('rev-parse')) return path.join(f.root, '.git', 'locked') + '\n';
    if (args.includes('list')) return `worktree /main-checkout\nHEAD def\n\nworktree ${f.root}\nHEAD abc\n\n`;
    if (args.includes('ls-files')) return '';
    return 'R  destination\0!! source\0';
  });
  assert.equal(shown.ignoredCount, 0);
});

test('a staged content change invalidates confirmation even when working bytes stay identical', async t => {
  const f = fixture(t);
  let index = '100644 abc 0\tt\0';
  const runGit = async args => args.includes('list') ? `worktree /main-checkout\nHEAD def\n\nworktree ${f.root}\nHEAD abc\n\n`
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
    if (args.includes('list')) return `worktree /main-checkout\nHEAD def\n\nworktree ${f.root}\nHEAD abc\n\n`;
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
    if (args.includes('list')) return `worktree /main-checkout\nHEAD def\n\nworktree ${f.root}\nHEAD abc\n\n`;
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
    if (args.includes('list')) return `worktree /main-checkout\nHEAD def\n\nworktree ${f.root}\nHEAD abc\n\n`;
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

function instrumentDeletion(overrides = {}, extra = {}) {
  const filename = path.join(__dirname, '../worktree-delete.js');
  const module = { exports: {} };
  const productionRequire = require('node:module').createRequire(filename);
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, Buffer, setTimeout, clearTimeout, process, ...extra,
    require: id => id === 'node:fs' ? { ...fs, promises: { ...fs.promises, ...overrides } } : productionRequire(id),
  }, { filename });
  return module.exports;
}

for (const platform of ['win32', 'linux']) {
  test(`a linked worktree is previewed through an alias ancestor on ${platform}`, async t => {
    const f = fixture(t, { paths: [] });
    const alias = path.join(path.dirname(f.root), path.basename(f.root) + '-ancestor');
    fs.symlinkSync(path.dirname(f.root), alias, process.platform === 'win32' ? 'junction' : 'dir');
    t.after(() => fs.unlinkSync(alias));
    const requested = path.join(alias, path.basename(f.root));
    const instrumented = instrumentDeletion({}, { process: { platform } });
    assert.equal((await instrumented.readStatus(requested, f.root, f.runGit)).branch, 'topic');
    const aliasList = async args => args.includes('list')
      ? `worktree /main-checkout\nHEAD def\n\nworktree ${JSON.stringify(requested)}\nHEAD abc\n\n` : f.runGit(args);
    assert.equal((await instrumented.readStatus(f.root, f.root, aliasList)).ok, true);
    assert.equal(f.state.removes.length, 0);
  });

  for (const kind of ['main checkout', 'registered worktree']) {
    test(`a path that is itself an alias of the ${kind} is refused on ${platform}`, async t => {
      const f = fixture(t, { paths: [] });
      const alias = path.join(path.dirname(f.root), path.basename(f.root) + '-alias');
      fs.symlinkSync(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
      t.after(() => fs.unlinkSync(alias));
      const runGit = async args => args.includes('list')
        ? `${kind === 'main checkout' ? '' : 'worktree /main-checkout\nHEAD def\n\n'}worktree ${JSON.stringify(f.root)}\nHEAD abc\n\n`
        : f.runGit(args);
      const instrumented = instrumentDeletion({}, { process: { platform } });
      const read = () => instrumented.readStatus(alias, f.root, runGit);
      await assert.rejects(read(), /no longer a registered worktree/);
      await assert.rejects(instrumented.removeWorktree(alias, f.root, { fingerprint: 'old' }, read, runGit), /no longer a registered worktree/);
      assert.equal(f.state.removes.length, 0);
    });
  }

  test(`alias-of-main through an ancestor refuses explicitly on ${platform}`, async t => {
    const f = fixture(t, { paths: [] });
    const alias = path.join(path.dirname(f.root), path.basename(f.root) + '-ancestor');
    fs.symlinkSync(path.dirname(f.root), alias, process.platform === 'win32' ? 'junction' : 'dir');
    t.after(() => fs.unlinkSync(alias));
    const requested = path.join(alias, path.basename(f.root));
    const runGit = async args => args.includes('list') ? `worktree ${JSON.stringify(f.root)}\nHEAD abc\n\n` : f.runGit(args);
    const instrumented = instrumentDeletion({}, { process: { platform } });
    const read = () => instrumented.readStatus(requested, f.root, runGit);
    await assert.rejects(read(), /main worktree.*cannot be deleted/i);
    await assert.rejects(instrumented.removeWorktree(requested, f.root, { fingerprint: 'old' }, read, runGit), /main worktree.*cannot be deleted/i);
    assert.equal(f.state.removes.length, 0);
  });

  test(`a worktree root link is refused by the final scan on ${platform}`, async t => {
    const f = fixture(t, { paths: [] });
    const shown = await f.read();
    const alias = path.join(path.dirname(f.root), path.basename(f.root) + '-root');
    fs.symlinkSync(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    t.after(() => fs.unlinkSync(alias));
    const instrumented = instrumentDeletion({}, { process: { platform } });
    await assert.rejects(instrumented.removeWorktree(alias, f.root, shown, async () => shown, f.runGit), /worktree path itself.*directory link/i);
    assert.equal(f.state.removes.length, 0);
  });
}

test('preview walks each directory once and Delete adds exactly one fresh pre-removal walk, including submodules', async t => {
  const f = fixture(t, { paths: [], submodule: true });
  fs.mkdirSync(path.join(f.root, 'sub/.git'), { recursive: true });
  fs.mkdirSync(path.join(f.root, 'node_modules/pkg'), { recursive: true });
  const visits = new Map();
  const record = name => visits.set(name, (visits.get(name) || 0) + 1);
  const instrumented = instrumentDeletion({
    opendir: async (...args) => { record(args[0]); return fs.promises.opendir(...args); },
    readdir: async (...args) => { if (args[1]?.withFileTypes) record(args[0]); return fs.promises.readdir(...args); },
  });
  const git = async args => {
    if (args.includes('list')) return `worktree /main-checkout\nHEAD def\n\nworktree ${f.root}\nHEAD abc\n\n`;
    if (args.includes('rev-parse')) return path.join(f.root, '.git/locked') + '\n';
    if (args.includes('ls-files')) return args[1] === f.root ? '160000 abc 0\tsub\0' : '';
    if (args.includes('remove')) {
      assert.equal(visits.get(f.root), 2, 'fresh status walk plus exactly one walk immediately before remove');
      assert.equal(visits.get(path.join(f.root, 'sub')), 2, 'nested snapshot must not repeat the walk');
    }
    return '';
  };
  const read = () => instrumented.readStatus(f.root, f.root, git);
  const shown = await read();
  assert.equal(visits.size, 5);
  for (const count of visits.values()) assert.equal(count, 1, 'one walk per preview');
  visits.clear();
  assert.equal((await instrumented.removeWorktree(f.root, f.root,
    { ...shown, confirmSubmodules: true }, read, git)).ok, true);
  for (const count of visits.values()) assert.equal(count, 2, 'one status walk and one final safety walk');
});

for (const platform of ['win32', 'linux']) test(`inside-pointing directory links follow the ${platform} rule at preview and removal`, async t => {
  const f = fixture(t, { paths: [] });
  fs.mkdirSync(path.join(f.root, 'node_modules/pkg'), { recursive: true });
  const link = path.join(f.root, 'node_modules/zz-alias');
  const instrumented = instrumentDeletion({}, { process: { platform } });
  const read = () => instrumented.readStatus(f.root, f.root, f.runGit);
  const shown = await read();
  fs.symlinkSync(path.join(f.root, 'node_modules/pkg'), link, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    if (platform === 'win32') {
      await assert.rejects(read(), error => {
        assert.match(error.message, /directory link.*zz-alias.*remove the link first/is);
        assert.ok(error.message.includes(link), 'name the absolute link inside this worktree');
        assert.match(error.message, /Git for Windows can follow links while removing/);
        assert.match(error.message, /rmdir <path>/);
        assert.doesNotMatch(error.message, /POSIX|rm <link>/);
        return true;
      });
      await assert.rejects(instrumented.removeWorktree(f.root, f.root, shown, async () => shown, f.runGit), /directory link/is);
      assert.equal(f.state.removes.length, 0);
    } else {
      assert.equal((await read()).ok, true);
      assert.equal((await instrumented.removeWorktree(f.root, f.root, shown, read, f.runGit)).ok, true);
      assert.equal(f.state.removes.length, 1);
    }
  } finally { fs.unlinkSync(link); }
});

test('a Git removal failure preserves its error when registration disappeared', async t => {
  const f = fixture(t, { paths: [] });
  const shown = await f.read();
  let reads = 0;
  let result;
  await assert.doesNotReject(async () => {
    result = await deletion.removeWorktree(f.root, f.root, shown, async () => {
      if (++reads === 1) return shown;
      throw new Error('This path is no longer a registered worktree.');
    }, async () => { throw new Error('Directory not empty'); });
  });
  assert.equal(reads, 2);
  assert.deepEqual(result, { ok: false, error: 'Git refused to remove the worktree: Directory not empty. Its registration may already be gone and the folder may be partly deleted; review it on disk.' });
});

for (const platform of ['win32', 'linux']) test(`self-resolving reparse directories are walked on ${platform}`, async t => {
  const f = fixture(t, { paths: [], preserveSpelling: true });
  const parent = path.join(f.root, 'ordinary');
  const placeholder = path.join(parent, 'placeholder');
  fs.mkdirSync(placeholder, { recursive: true });
  const visited = [];
  const instrumented = instrumentDeletion({
    readdir: async (directory, options) => {
      visited.push(directory);
      if (directory === parent) return [{ name: 'placeholder', isSymbolicLink: () => true, isDirectory: () => false }];
      return fs.promises.readdir(directory, options);
    },
  }, { process: { platform } });
  assert.equal((await instrumented.readStatus(f.root, f.root, f.runGit)).ok, true);
  assert.equal(visited.filter(directory => directory === placeholder).length, 1, 'walk the self-resolving directory instead of skipping its contents');
});

for (const platform of ['win32', 'linux']) test(`outside link refusal names the worktree and only the ${platform} removal command`, async t => {
  const f = fixture(t, { paths: [] });
  const link = path.join(f.root, 'outside');
  fs.symlinkSync(path.dirname(f.root), link, process.platform === 'win32' ? 'junction' : 'dir');
  const instrumented = instrumentDeletion({}, { process: { platform } });
  try {
    await assert.rejects(instrumented.readStatus(f.root, f.root, f.runGit), error => {
      assert.ok(error.message.includes(link));
      assert.match(error.message, platform === 'win32' ? /Git for Windows can follow links while removing.*rmdir <path>/ : /rm <link> without -r/);
      assert.doesNotMatch(error.message, platform === 'win32' ? /POSIX|rm <link>/ : /Windows|rmdir/);
      return true;
    });
    assert.equal(f.state.removes.length, 0);
  } finally { fs.unlinkSync(link); }
});

test('link containment resolves the root and targets with the same native resolver', async t => {
  const f = fixture(t, { paths: [] });
  const alias = path.join(f.root, 'alias');
  const nativeRoot = path.join(path.dirname(f.root), 'expanded-native-root');
  let rootResolutions = 0;
  const instrumented = instrumentDeletion({
    realpath: async directory => {
      if (directory === f.root) { rootResolutions++; return nativeRoot; }
      if (directory === alias) return path.join(nativeRoot, 'pkg');
      return fs.promises.realpath(directory);
    },
    stat: async directory => directory === alias ? { isFile: () => false, isDirectory: () => true } : fs.promises.stat(directory),
    readdir: async directory => directory === f.root ? [{ name: 'alias', isSymbolicLink: () => true }] : [],
  }, { process: { platform: 'linux' } });
  let shown;
  await assert.doesNotReject(async () => { shown = await instrumented.readStatus(f.root, f.root, f.runGit); });
  assert.equal(shown.ok, true);
  assert.equal(rootResolutions, 1, 'resolve the scan root with the same native resolver as its link targets');
});

test('nonempty uninitialised gitlinks refuse even when status does not list the gitlink', async t => {
  const f = fixture(t, { paths: [], submodule: true });
  fs.mkdirSync(path.join(f.root, 'sub'));
  const shown = await f.read();
  fs.writeFileSync(path.join(f.root, 'sub/stray.txt'), 'keep');
  await assert.rejects(f.read(), /uninitialised submodule.*sub.*not empty.*review/is);
  await assert.rejects(f.remove({ ...shown, confirmSubmodules: true }), /uninitialised submodule/is);
  assert.equal(f.state.removes.length, 0);
  assert.equal(fs.readFileSync(path.join(f.root, 'sub/stray.txt'), 'utf8'), 'keep');
});

test('link walk refuses explicitly at its directory cap before opening excess directories', async t => {
  const f = fixture(t, { paths: [] });
  const dirs = Array.from({ length: 200001 }, (_, i) => ({ name: 'd' + i,
    isDirectory: () => true, isSymbolicLink: () => false }));
  let opened = 0;
  const instrumented = instrumentDeletion({ readdir: async () => { opened++; return dirs; } });
  await assert.rejects(instrumented.readStatus(f.root, f.root, async args => {
    if (args.includes('list')) return `worktree /main-checkout\nHEAD def\n\nworktree ${f.root}\nHEAD abc\n\n`;
    if (args.includes('rev-parse')) return path.join(f.root, '.git/locked') + '\n';
    return '';
  }), /directory.*200[,.]?000.*review/is);
  assert.equal(opened, 1);
});

test('link walk time budget refuses preview and the final removal scan with an actionable error', async t => {
  const f = fixture(t, { paths: [] });
  const shown = await f.read();
  let clock = 0;
  const instrumented = instrumentDeletion({}, { Date: { now: () => { clock += 6000; return clock; } } });
  await assert.rejects(instrumented.readStatus(f.root, f.root, async args => {
    if (args.includes('list')) return `worktree /main-checkout\nHEAD def\n\nworktree ${f.root}\nHEAD abc\n\n`;
    if (args.includes('rev-parse')) return path.join(f.root, '.git/locked') + '\n';
    return '';
  }), /directory.*time budget.*review/is);
  await assert.rejects(instrumented.removeWorktree(f.root, f.root, shown, async () => shown,
    async () => assert.fail('must not remove')), /directory.*time budget.*review/is);
});

test('deep ignored outside junctions and dangling junctions refuse while file links remain safe', async t => {
  const f = fixture(t, { paths: [] });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-delete-deep-target-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'precious'), 'keep');
  const deep = path.join(f.root, 'node_modules/a/b/c/d/e/f');
  fs.mkdirSync(deep, { recursive: true });
  const link = path.join(deep, 'lnk');
  const shown = await f.read();
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    await assert.rejects(f.read(), /directory link/);
    await assert.rejects(deletion.removeWorktree(f.root, f.root, shown, async () => shown,
      async () => assert.fail('must not remove')), /directory link/);
    assert.equal(fs.readFileSync(path.join(outside, 'precious'), 'utf8'), 'keep');
  } finally { fs.unlinkSync(link); }
  fs.symlinkSync(path.join(outside, 'missing'), link, process.platform === 'win32' ? 'junction' : 'dir');
  try { await assert.rejects(f.read(), /directory link/); }
  finally { fs.unlinkSync(link); }
  fs.symlinkSync(path.join(outside, 'precious'), link, 'file');
  try { await assert.doesNotReject(f.read()); }
  finally { fs.unlinkSync(link); }
  assert.equal(fs.readFileSync(path.join(outside, 'precious'), 'utf8'), 'keep');
});
