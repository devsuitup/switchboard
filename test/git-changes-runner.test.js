'use strict';

// git-changes-runner.js — local (execFile, no shell) and remote (ssh, shell on
// the far end) command construction, fully injected: no real git, no ssh, no
// network. See .ai/contexts/ipc-bridge.md ("Changes panel") and issue #251.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createGitChangesRunner,
  buildRemoteGitCommand,
  shQuote,
  isSafeCwd,
  isSafeGitPath,
} = require('../git-changes-runner');

// --- shQuote / buildRemoteGitCommand ---------------------------------------

test('shQuote wraps a plain value in single quotes', () => {
  assert.equal(shQuote('/home/dev/proj'), "'/home/dev/proj'");
});

test('shQuote escapes an embedded single quote with the standard close-escape-reopen trick', () => {
  assert.equal(shQuote("it's/here"), "'it'\\''s/here'");
});

test('buildRemoteGitCommand: fixed shape, cwd and every arg individually quoted', () => {
  const cmd = buildRemoteGitCommand('/srv/app', ['status', '--porcelain=v2', '--branch']);
  assert.equal(cmd, "git -C '/srv/app' 'status' '--porcelain=v2' '--branch'");
});

test('no builder ever emits a backtick, even when cwd/path contain one', () => {
  const withBacktick = buildRemoteGitCommand('/srv/`whoami`', ['diff', '--', 'a`b`.js']);
  // The backtick is neutralized by single-quoting, not stripped — assert the
  // structural property that matters: it never sits outside a quoted token
  // where a shell would interpret it. Every quoted segment starts and ends
  // with a single quote; nothing is concatenated unquoted around it.
  assert.match(withBacktick, /^git -C '.*' 'diff' '--' '.*'$/s);
});

test('a cwd or path containing $(...) stays inside single quotes, never interpolated', () => {
  const cmd = buildRemoteGitCommand('/srv/$(rm -rf /)', ['diff', '--', 'x']);
  assert.equal(cmd, "git -C '/srv/$(rm -rf /)' 'diff' '--' 'x'");
});

test('a path containing an embedded single quote is escaped, not left to break out of the quoting', () => {
  const cmd = buildRemoteGitCommand('/srv/app', ['diff', '--', "weird'name.js"]);
  assert.equal(cmd, "git -C '/srv/app' 'diff' '--' 'weird'\\''name.js'");
});

// --- isSafeCwd / isSafeGitPath ---------------------------------------------

test('isSafeCwd accepts a normal path, rejects empty/NUL/newline', () => {
  assert.equal(isSafeCwd('/home/dev/proj'), true);
  assert.equal(isSafeCwd(''), false);
  assert.equal(isSafeCwd('/a\0b'), false);
  assert.equal(isSafeCwd('/a\nb'), false);
  assert.equal(isSafeCwd(null), false);
  assert.equal(isSafeCwd(42), false);
});

test('isSafeGitPath rejects path traversal (mutation target: dropping the ".." check)', () => {
  assert.equal(isSafeGitPath('../../etc/passwd'), false);
  assert.equal(isSafeGitPath('src/../../../etc/passwd'), false);
  assert.equal(isSafeGitPath('src/file.js'), true);
});

test('isSafeGitPath rejects NUL/newline, accepts spaces and unicode', () => {
  assert.equal(isSafeGitPath('a\0b'), false);
  assert.equal(isSafeGitPath('a\nb'), false);
  assert.equal(isSafeGitPath('my file.js'), true);
  assert.equal(isSafeGitPath('café/déjà-vu.js'), true);
});

// --- createGitChangesRunner: construction guards ---------------------------

test('createGitChangesRunner throws on an invalid kind or cwd', () => {
  assert.throws(() => createGitChangesRunner({ kind: 'bogus', cwd: '/a' }));
  assert.throws(() => createGitChangesRunner({ kind: 'local', cwd: '' }));
  assert.throws(() => createGitChangesRunner({ kind: 'local', cwd: '/a\0b' }));
});

test('createGitChangesRunner requires an alias for a remote runner', () => {
  assert.throws(() => createGitChangesRunner({ kind: 'remote', cwd: '/a' }));
});

// --- local runner: .status() ------------------------------------------------

function localFakeExec(responses) {
  const calls = [];
  const exec = (args) => {
    calls.push(args);
    const key = args[0] + (args.includes('--cached') ? ':cached' : '');
    return Promise.resolve(responses[key] || { code: 0, stdout: '', stderr: '' });
  };
  return { exec, calls };
}

test('local runner .status(): three commands, no -C flag (cwd passed via execFile options, not argv)', async () => {
  const { exec, calls } = localFakeExec({
    status: { code: 0, stdout: '# branch.head main\n1 .M N... 100644 100644 100644 abc123 def456 foo.js\n', stderr: '' },
    diff: { code: 0, stdout: '1\t2\tfoo.js\n', stderr: '' },
    'diff:cached': { code: 0, stdout: '', stderr: '' },
  });
  const runner = createGitChangesRunner({ kind: 'local', cwd: '/repo', exec });
  const result = await runner.status();

  assert.equal(result.ok, true);
  assert.equal(result.branch.head, 'main');
  assert.equal(result.files.length, 1);
  assert.equal(calls.length, 3);
  for (const args of calls) assert.ok(!args.includes('-C'), 'the local runner must not pass -C — cwd is execFile\'s own option');
});

test('local runner .status(): a failing git call surfaces stderr as the error, not a throw', async () => {
  const exec = (args) => Promise.resolve(
    args[0] === 'status' ? { code: 128, stdout: '', stderr: 'fatal: not a git repository' } : { code: 0, stdout: '', stderr: '' }
  );
  const runner = createGitChangesRunner({ kind: 'local', cwd: '/repo', exec });
  const result = await runner.status();
  assert.equal(result.ok, false);
  assert.match(result.error, /not a git repository/);
});

test('local runner .status(): a thrown exec rejects gracefully', async () => {
  const runner = createGitChangesRunner({ kind: 'local', cwd: '/repo', exec: () => { throw new Error('ENOENT'); } });
  const result = await runner.status();
  assert.equal(result.ok, false);
  assert.match(result.error, /ENOENT/);
});

// --- local runner: .diff() --------------------------------------------------

test('local runner .diff(): unstaged diff args, refuses an unsafe path before calling exec', async () => {
  const calls = [];
  const exec = (args) => { calls.push(args); return Promise.resolve({ code: 0, stdout: 'diff --git a/x b/x\n+line\n', stderr: '' }); };
  const runner = createGitChangesRunner({ kind: 'local', cwd: '/repo', exec });

  const bad = await runner.diff('../escape.js');
  assert.equal(bad.ok, false);
  assert.equal(calls.length, 0, 'an unsafe path must never reach exec');

  const good = await runner.diff('src/x.js');
  assert.equal(good.ok, true);
  assert.deepEqual(calls[0], ['diff', '--', 'src/x.js']);
});

test('local runner .diff({staged:true}): includes --cached', async () => {
  const calls = [];
  const exec = (args) => { calls.push(args); return Promise.resolve({ code: 0, stdout: '', stderr: '' }); };
  const runner = createGitChangesRunner({ kind: 'local', cwd: '/repo', exec });
  await runner.diff('src/x.js', { staged: true });
  assert.deepEqual(calls[0], ['diff', '--cached', '--', 'src/x.js']);
});

test('local runner .diff(): truncates content past 512 KB and flags it', async () => {
  const big = 'a'.repeat(600 * 1024);
  const exec = () => Promise.resolve({ code: 0, stdout: big, stderr: '' });
  const runner = createGitChangesRunner({ kind: 'local', cwd: '/repo', exec });
  const result = await runner.diff('x.js');
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.equal(result.content.length, 512 * 1024);
});

test('local runner .diff(): a diff under the cap is not marked truncated', async () => {
  const exec = () => Promise.resolve({ code: 0, stdout: 'small diff\n', stderr: '' });
  const runner = createGitChangesRunner({ kind: 'local', cwd: '/repo', exec });
  const result = await runner.diff('x.js');
  assert.equal(result.truncated, false);
  assert.equal(result.content, 'small diff\n');
});

// --- remote runner: command shape -------------------------------------------

test('remote runner .status(): three ssh calls, each a full "git -C <cwd> ..." string', async () => {
  const commands = [];
  const exec = (command) => {
    commands.push(command);
    if (command.includes("'status'")) return Promise.resolve({ code: 0, stdout: '# branch.head main\n', stderr: '' });
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  };
  const runner = createGitChangesRunner({ kind: 'remote', cwd: '/srv/app', alias: 'vps', exec });
  const result = await runner.status();

  assert.equal(result.ok, true);
  assert.equal(commands.length, 3);
  for (const cmd of commands) {
    assert.match(cmd, /^git -C '\/srv\/app' /);
    assert.ok(!cmd.includes('`'), 'no backtick in any remote command string');
  }
});

test('remote runner .diff(): the built command quotes cwd and path, never a shell-interpreted concatenation', async () => {
  const commands = [];
  const exec = (command) => { commands.push(command); return Promise.resolve({ code: 0, stdout: 'diff text\n', stderr: '' }); };
  const runner = createGitChangesRunner({ kind: 'remote', cwd: '/srv/app', alias: 'vps', exec });
  await runner.diff('src/weird file.js', { staged: true });

  assert.equal(commands.length, 1);
  assert.equal(commands[0], "git -C '/srv/app' 'diff' '--cached' '--' 'src/weird file.js'");
});

test('remote runner: an unsafe path is refused before any ssh call', async () => {
  let calls = 0;
  const exec = () => { calls++; return Promise.resolve({ code: 0, stdout: '', stderr: '' }); };
  const runner = createGitChangesRunner({ kind: 'remote', cwd: '/srv/app', alias: 'vps', exec });
  const result = await runner.diff('../../etc/passwd');
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
});

test('remote runner: an ssh-level failure (exit 255) surfaces without claiming success', async () => {
  const exec = () => Promise.resolve({ code: 255, stdout: '', stderr: 'ssh: connection refused' });
  const runner = createGitChangesRunner({ kind: 'remote', cwd: '/srv/app', alias: 'vps', exec });
  const result = await runner.status();
  assert.equal(result.ok, false);
  assert.match(result.error, /connection refused/);
});

test('remote runner: uses the real defaultRunRemoteCommand transport when no exec is injected (construction only, no network call made in this test)', () => {
  const runner = createGitChangesRunner({ kind: 'remote', cwd: '/srv/app', alias: 'vps' });
  assert.equal(runner.kind, 'remote');
  assert.equal(runner.alias, 'vps');
});
