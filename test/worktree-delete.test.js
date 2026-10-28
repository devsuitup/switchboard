'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadProjectActionHandlers } = require('./project-action-harness');
const { localGitEnv } = require('../git-changes-runner');
const deletion = require('../worktree-delete');

const target = '/home/jb/repo/.claude/worktrees/task';

function fixture() {
  const state = { dirty: '', lock: null, removes: [], cleaned: 0, failRemove: false };
  const handlers = loadProjectActionHandlers({
    getKnownProjectPaths: () => ['/home/jb/repo'], localGitEnv,
    os: { homedir: () => '/home/jb' },
    cliSessionState: { getSidebarDescriptors: () => [
      { sessionId: 'live', cwd: target + '/nested' },
      { sessionId: 'sibling', cwd: target + '-other' },
    ] },
    activeSessions: new Map([
      ['pty', { cwd: target, exited: false }],
      ['gone', { cwd: target, exited: true }],
      ['remote', { cwd: target, host: 'server', exited: false }],
    ]),
    execFile(_cmd, args, _options, cb) {
      if (args.includes('rev-parse')) return cb(null, target + '/.git/locked\n', '');
      if (args.includes('status')) return cb(null, state.dirty, '');
      if (args.includes('list')) return cb(null,
        `worktree ${target}\nHEAD abc\nbranch refs/heads/topic\n${state.lock === null ? '' : `locked${state.lock ? ' ' + state.lock : ''}\n`}\n`, '');
      if (args.includes('ls-files')) return cb(null, '', '');
      state.removes.push(Array.from(args));
      if (state.failRemove) {
        state.dirty = '?? late.txt\0';
        return cb(new Error('dirty'), '', 'fatal: contains modified or untracked files');
      }
      cb(null, '', '');
    },
    writer: { cleanupWorktree: async () => { state.cleaned++; return 1; } },
    log: { info() {} }, notifyRendererProjectsChanged() {},
  });
  return { state, preview: () => handlers.get('worktree-status')(null, target),
    remove: shown => handlers.get('delete-worktree')(null, target, shown) };
}

test('shown clean removes without force', async () => {
  const f = fixture();
  const shown = await f.preview();
  assert.equal((await f.remove(shown)).ok, true);
  assert.equal(f.state.removes[0].includes('-f'), false);
  assert.equal(f.state.cleaned, 1);
});

for (const before of ['', ' M first.txt\0']) {
  test(`changed dirty set refuses before removing (shown ${before ? 'dirty' : 'clean'})`, async () => {
    const f = fixture();
    f.state.dirty = before;
    const shown = await f.preview();
    f.state.dirty = ' M second.txt\0';
    const result = await f.remove(shown);
    assert.equal(result.ok, false);
    assert.equal(result.refresh, true);
    assert.match(result.error, /review|confirm/i);
    assert.equal(result.status.dirty[0], ' M second.txt');
    assert.equal(f.state.removes.length, 0);
    assert.equal(f.state.cleaned, 0);
  });
}

test('unchanged dirty set permits exactly one force', async () => {
  const f = fixture();
  f.state.dirty = ' M first.txt\0';
  assert.equal((await f.remove(await f.preview())).ok, true);
  assert.equal(f.state.removes[0].filter(a => a === '-f').length, 1);
});

test('locked removal needs explicit consent to the current lock reason', async () => {
  const f = fixture();
  f.state.lock = 'backup disk';
  const shown = await f.preview();
  assert.equal((await f.remove(shown)).ok, false);
  assert.equal(f.state.removes.length, 0);
  assert.equal((await f.remove({ ...shown, confirmLocked: true })).ok, true);
  assert.equal(f.state.removes[0].filter(a => a === '-f').length, 2);
  f.state.lock = 'different owner';
  assert.equal((await f.remove({ ...shown, confirmLocked: true })).refresh, true);
  assert.equal(f.state.removes.length, 1);
});

test('git refusing a shown-clean removal returns fresh status without retrying force', async () => {
  const f = fixture();
  const shown = await f.preview();
  f.state.failRemove = true;
  const result = await f.remove(shown);
  assert.equal(result.ok, false);
  assert.equal(result.refresh, true);
  assert.equal(result.status.dirty[0], '?? late.txt');
  assert.equal(f.state.removes.length, 1);
  assert.equal(f.state.removes[0].includes('-f'), false);
  assert.equal(f.state.cleaned, 0);
});

test('preview includes branch, ignored entries and only local live sessions inside the worktree', async () => {
  const f = fixture();
  f.state.dirty = ' M first.txt\0!! .env\0!! node_modules/\0';
  const result = await f.preview();
  assert.equal(result.branch, 'topic');
  assert.equal(result.path, target);
  assert.equal(result.homeDir, '/home/jb');
  assert.equal(result.ignoredCount, 2);
  assert.deepEqual(Array.from(result.dirty), [' M first.txt']);
  assert.deepEqual(Array.from(result.sessions, s => s.sessionId).sort(), ['live', 'pty']);
});

test('missing preview and changed ignored paths both refuse before removal', async () => {
  const f = fixture();
  assert.equal((await f.remove()).refresh, true);
  f.state.dirty = '!! .env\0';
  const shown = await f.preview();
  f.state.dirty = '!! secrets/\0';
  assert.equal((await f.remove(shown)).refresh, true);
  assert.equal(f.state.removes.length, 0);
});

test('preview parses detached HEAD, unnamed lock, renames, and filenames containing newlines', async () => {
  const output = 'R  new\nname\0old name\0!! cache/\0';
  const result = await deletion.readStatus(target, '/home/jb/repo', async args => args.includes('list')
    ? `worktree /other\nHEAD def\n\nworktree ${target}\nHEAD abc\ndetached\nlocked\n\n` : args.includes('ls-files') ? '' : output);
  assert.equal(result.branch, '(detached HEAD)');
  assert.equal(result.locked, true);
  assert.equal(result.lockReason, '');
  assert.deepEqual(result.dirty, ['R  old name -> new\nname']);
  assert.equal(result.ignoredCount, 1);
});

test('fingerprint preserves both rename paths even when display text is ambiguous', async () => {
  const read = output => deletion.readStatus(target, '/home/jb/repo', async args => args.includes('list')
    ? `worktree ${target}\nHEAD abc\n\n` : args.includes('rev-parse') ? target + '/.git/locked\n' : args.includes('ls-files') ? '' : output);
  const a = await read('R  c\0a -> b\0');
  const b = await read('R  b -> c\0a\0');
  assert.deepEqual(a.dirty, b.dirty);
  assert.notEqual(a.fingerprint, b.fingerprint);
});

test('unregistered worktrees, incomplete renames, and Git errors fail closed', async () => {
  await assert.rejects(deletion.readStatus(target, '/repo', async () => ''), /no longer a registered worktree/);
  await assert.rejects(deletion.readStatus(target, '/repo', async args => args.includes('list')
    ? `worktree ${target}\nHEAD abc\n\n` : args.includes('rev-parse') ? target + '/.git/locked\n' : 'R  destination\0'), /incomplete rename/);
  await assert.rejects(deletion.readStatus(target, '/repo', async () => { throw new Error('denied'); }), /denied/);
});

test('Windows cwd matching handles separators, case, descendants and duplicate live ids', () => {
  const pty = new Map([
    ['handle', { realSessionId: 'live', cwd: 'C:\\repo\\.worktrees\\task' }],
    ['other', { cwd: 'C:/repo/.worktrees/task-sibling' }],
    ['empty', {}],
  ]);
  const result = deletion.runningSessions('c:/Repo/.worktrees/task/', pty,
    [{ sessionId: 'live', cwd: 'c:/repo/.worktrees/task/sub' }]);
  assert.deepEqual(result, [{ sessionId: 'live', cwd: 'c:/repo/.worktrees/task/sub' }]);
});

test('old Git lock-file resolution detects locks and binds consent to their current reason', async () => {
  const root = path.resolve('virtual-worktree');
  for (const gitPath of ['../common.git/worktrees/task/locked', path.resolve('common.git/worktrees/task/locked')]) {
    const calls = [], reads = [];
    let reason = ' backup disk\n';
    const read = () => deletion.readStatus(root, '/repo', async args => {
      calls.push(args);
      if (args.includes('list')) return `worktree ${root}\nHEAD abc\nbranch refs/heads/topic\n\n`;
      if (args.includes('rev-parse')) return gitPath + '\n';
      return '';
    }, async (file, encoding) => {
      reads.push([file, encoding]);
      return reason;
    });
    const shown = await read();
    assert.equal(shown.locked, true);
    assert.equal(shown.lockReason, 'backup disk');
    assert.deepEqual(reads, [[path.resolve(root, gitPath), 'utf8']]);
    assert.deepEqual(calls.find(args => args.includes('rev-parse')), ['-C', root, 'rev-parse', '--git-path', 'locked']);
    const removes = [];
    const remove = consent => deletion.removeWorktree(root, '/repo', consent, read, async args => removes.push(args));
    assert.equal((await remove(shown)).refresh, true);
    assert.equal(removes.length, 0);
    reason = 'another owner\n';
    assert.equal((await remove({ ...shown, confirmLocked: true })).refresh, true);
    assert.equal(removes.length, 0);
    const fresh = await read();
    assert.equal((await remove({ ...fresh, confirmLocked: true })).ok, true);
    assert.equal(removes[0].filter(arg => arg === '-f').length, 2);
    reason = '';
    const unnamed = await read();
    assert.equal(unnamed.locked, true);
    assert.equal(unnamed.lockReason, '');
    assert.notEqual(unnamed.fingerprint, fresh.fingerprint);
  }
});

test('absent lock files are unlocked but unreadable lock metadata fails closed', async () => {
  const git = async args => args.includes('list') ? `worktree ${target}\nHEAD abc\n\n`
    : args.includes('rev-parse') ? '.git/locked\n' : '';
  const read = code => deletion.readStatus(target, '/repo', git, async () => {
    throw Object.assign(new Error('lock metadata ' + code), { code });
  });
  assert.equal((await read('ENOENT')).locked, false);
  await assert.rejects(read('EACCES'), /lock metadata EACCES/);
  const locked = await deletion.readStatus(target, '/repo', git, async () => 'backup');
  assert.notEqual((await read('ENOENT')).fingerprint, locked.fingerprint);
});
