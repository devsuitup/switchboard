'use strict';

// git-changes-runner.js — local (execFile, no shell) and remote (ssh, shell on
// the far end) command construction, fully injected: no real git, no ssh, no
// network. See .ai/contexts/ipc-bridge.md ("Changes panel") and issue #251.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createGitChangesRunner,
  buildRemoteGitCommand,
  buildGitArgs,
  truncateDiffContent,
  shQuote,
  isSafeCwd,
  isSafeGitPath,
  MAX_DIFF_BYTES,
  STATUS_MAX_STDOUT_BYTES,
  DIFF_MAX_STDOUT_BYTES,
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

// --- buildGitArgs: --literal-pathspecs on every invocation -----------------

test('buildGitArgs: prepends --literal-pathspecs before the subcommand (mutation target: dropping the flag)', () => {
  assert.deepEqual(buildGitArgs(['status', '--porcelain=v2', '--branch']), ['--literal-pathspecs', 'status', '--porcelain=v2', '--branch']);
  assert.deepEqual(buildGitArgs(['diff', '--', 'x.js']), ['--literal-pathspecs', 'diff', '--', 'x.js']);
});

test('buildRemoteGitCommand carries --literal-pathspecs through as its own quoted token, still before the subcommand', () => {
  const cmd = buildRemoteGitCommand('/srv/app', buildGitArgs(['status', '--porcelain=v2', '--branch']));
  assert.equal(cmd, "git -C '/srv/app' '--literal-pathspecs' 'status' '--porcelain=v2' '--branch'");
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

test('isSafeGitPath rejects a leading ":" — git pathspec magic interpreted even after "--" (mutation target: dropping the check)', () => {
  assert.equal(isSafeGitPath(':(exclude)x'), false);
  assert.equal(isSafeGitPath(':/'), false);
  assert.equal(isSafeGitPath(':(top)src/x.js'), false);
  assert.equal(isSafeGitPath('src/:weird.js'), true, 'a colon not in the first position is not pathspec magic');
});

// --- truncateDiffContent: byte cap, cut on a line boundary -----------------

test('truncateDiffContent: content at or under the cap is returned unchanged', () => {
  assert.deepEqual(truncateDiffContent('small\n', 100), { content: 'small\n', truncated: false });
});

test('truncateDiffContent: cuts on a line boundary, never mid-line (mutation target: a naive .slice(0, maxBytes))', () => {
  const content = 'aaaaaaaaaa\nbbbbbbbbbb\ncccccccccc\n'; // 3 lines of 11 bytes each
  const result = truncateDiffContent(content, 15); // fits exactly 1 line (11) but not 2 (22)
  assert.equal(result.truncated, true);
  assert.equal(result.content, 'aaaaaaaaaa\n');
});

test('truncateDiffContent: measures UTF-8 bytes, not JS string length (mutation target: content.length instead of Buffer.byteLength)', () => {
  const content = 'é'.repeat(10) + '\n'; // 10 chars => 20 bytes, plus 1-byte \n = 21 bytes, 11 chars
  const result = truncateDiffContent(content, 20); // under 21 bytes but over 20 chars would wrongly pass a char-length check
  assert.equal(result.truncated, true);
  assert.equal(result.content, '', 'the only line exceeds the cap alone, so nothing whole fits');
});

test('truncateDiffContent: never exceeds maxBytes even when the very first line alone does', () => {
  const content = 'x'.repeat(50) + '\nshort\n';
  const result = truncateDiffContent(content, 10);
  assert.equal(result.truncated, true);
  assert.equal(result.content, '');
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

// Keyed on the subcommand (args[1]) — args[0] is always the prepended
// --literal-pathspecs flag (see buildGitArgs / .ai/contexts/changes-view.md).
function localFakeExec(responses) {
  const calls = [];
  const exec = (args) => {
    calls.push(args);
    const key = args[1] + (args.includes('--cached') ? ':cached' : '');
    return Promise.resolve(responses[key] || { code: 0, stdout: '', stderr: '' });
  };
  return { exec, calls };
}

test('local runner .status(): three commands, no -C flag (cwd passed via execFile options, not argv), --literal-pathspecs and -z on every one', async () => {
  const { exec, calls } = localFakeExec({
    status: { code: 0, stdout: '# branch.head main\x001 .M N... 100644 100644 100644 abc123 def456 foo.js\x00', stderr: '' },
    diff: { code: 0, stdout: '1\t2\tfoo.js\x00', stderr: '' },
    'diff:cached': { code: 0, stdout: '', stderr: '' },
  });
  const runner = createGitChangesRunner({ kind: 'local', cwd: '/repo', exec });
  const result = await runner.status();

  assert.equal(result.ok, true);
  assert.equal(result.branch.head, 'main');
  assert.equal(result.files.length, 1);
  assert.equal(calls.length, 3);
  for (const args of calls) {
    assert.ok(!args.includes('-C'), 'the local runner must not pass -C — cwd is execFile\'s own option');
    assert.equal(args[0], '--literal-pathspecs', 'every invocation must lead with --literal-pathspecs');
    assert.ok(args.includes('-z'), 'status/numstat must run with -z');
  }
});

test('local runner .status(): a failing git call surfaces stderr as the error, not a throw', async () => {
  const exec = (args) => Promise.resolve(
    args[1] === 'status' ? { code: 128, stdout: '', stderr: 'fatal: not a git repository' } : { code: 0, stdout: '', stderr: '' }
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

test('local runner .diff(): unstaged diff args carry --literal-pathspecs, refuses an unsafe path before calling exec', async () => {
  const calls = [];
  const exec = (args) => { calls.push(args); return Promise.resolve({ code: 0, stdout: 'diff --git a/x b/x\n+line\n', stderr: '' }); };
  const runner = createGitChangesRunner({ kind: 'local', cwd: '/repo', exec });

  const bad = await runner.diff('../escape.js');
  assert.equal(bad.ok, false);
  assert.equal(calls.length, 0, 'an unsafe path must never reach exec');

  const good = await runner.diff('src/x.js');
  assert.equal(good.ok, true);
  assert.deepEqual(calls[0], ['--literal-pathspecs', 'diff', '--', 'src/x.js']);
});

test('local runner .diff({staged:true}): includes --cached', async () => {
  const calls = [];
  const exec = (args) => { calls.push(args); return Promise.resolve({ code: 0, stdout: '', stderr: '' }); };
  const runner = createGitChangesRunner({ kind: 'local', cwd: '/repo', exec });
  await runner.diff('src/x.js', { staged: true });
  assert.deepEqual(calls[0], ['--literal-pathspecs', 'diff', '--cached', '--', 'src/x.js']);
});

test('local runner .diff(): truncates content past 512 KB, on a line boundary, measured in bytes', async () => {
  const line = 'a'.repeat(100) + '\n'; // 101 bytes/line, ASCII
  const big = line.repeat(6000); // ~600 KB, well past the 512 KB cap
  const exec = () => Promise.resolve({ code: 0, stdout: big, stderr: '' });
  const runner = createGitChangesRunner({ kind: 'local', cwd: '/repo', exec });
  const result = await runner.diff('x.js');
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.content, 'utf8') <= MAX_DIFF_BYTES, 'must never exceed the byte cap');
  assert.ok(result.content.endsWith('\n'), 'must cut on a line boundary, never mid-line');
  assert.equal(result.content.length % 101, 0, 'must consist of whole 101-byte lines only');
});

test('local runner .diff(): the byte cap is measured in UTF-8 bytes, not JS string length (mutation target: using .length instead of Buffer.byteLength)', async () => {
  // 'é' is 1 JS string char but 2 UTF-8 bytes — a char-length cap would let
  // roughly twice MAX_DIFF_BYTES worth of such lines through uncaught.
  const line = 'é'.repeat(100) + '\n'; // 100 chars => 201 bytes/line
  const big = line.repeat(4000); // ~400,000 chars / ~804,000 bytes
  const exec = () => Promise.resolve({ code: 0, stdout: big, stderr: '' });
  const runner = createGitChangesRunner({ kind: 'local', cwd: '/repo', exec });
  const result = await runner.diff('x.js');
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.content, 'utf8') <= MAX_DIFF_BYTES, 'a char-length cap would overshoot the byte cap here');
});

test('local runner .diff(): a diff under the cap is not marked truncated', async () => {
  const exec = () => Promise.resolve({ code: 0, stdout: 'small diff\n', stderr: '' });
  const runner = createGitChangesRunner({ kind: 'local', cwd: '/repo', exec });
  const result = await runner.diff('x.js');
  assert.equal(result.truncated, false);
  assert.equal(result.content, 'small diff\n');
});

// --- remote runner: command shape -------------------------------------------

test('remote runner .status(): three ssh calls, each a full "git -C <cwd> --literal-pathspecs ... -z" string', async () => {
  const commands = [];
  const exec = (command) => {
    commands.push(command);
    if (command.includes("'status'")) return Promise.resolve({ code: 0, stdout: '# branch.head main\x00', stderr: '' });
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  };
  const runner = createGitChangesRunner({ kind: 'remote', cwd: '/srv/app', alias: 'vps', exec });
  const result = await runner.status();

  assert.equal(result.ok, true);
  assert.equal(commands.length, 3);
  for (const cmd of commands) {
    assert.match(cmd, /^git -C '\/srv\/app' '--literal-pathspecs' /);
    assert.match(cmd, /'-z'$/, 'must end in a quoted -z token');
    assert.ok(!cmd.includes('`'), 'no backtick in any remote command string');
  }
});

test('remote runner .diff(): the built command carries --literal-pathspecs, quotes cwd and path, never a shell-interpreted concatenation', async () => {
  const commands = [];
  const exec = (command) => { commands.push(command); return Promise.resolve({ code: 0, stdout: 'diff text\n', stderr: '' }); };
  const runner = createGitChangesRunner({ kind: 'remote', cwd: '/srv/app', alias: 'vps', exec });
  await runner.diff('src/weird file.js', { staged: true });

  assert.equal(commands.length, 1);
  assert.equal(commands[0], "git -C '/srv/app' '--literal-pathspecs' 'diff' '--cached' '--' 'src/weird file.js'");
});

// --- remote runner: stdout cap wiring (adversarial review, CRITICAL finding 1) ---

test('remote runner .status(): passes an explicit maxStdoutBytes cap to the transport for each of the three commands', async () => {
  const seenOpts = [];
  const exec = (command, opts) => { seenOpts.push(opts); return Promise.resolve({ code: 0, stdout: '', stderr: '' }); };
  const runner = createGitChangesRunner({ kind: 'remote', cwd: '/srv/app', alias: 'vps', exec });
  await runner.status();

  assert.equal(seenOpts.length, 3);
  for (const opts of seenOpts) assert.equal(opts.maxStdoutBytes, STATUS_MAX_STDOUT_BYTES);
});

test('remote runner .diff(): passes MAX_DIFF_BYTES-plus-slack as the transport stdout cap', async () => {
  const seenOpts = [];
  const exec = (command, opts) => { seenOpts.push(opts); return Promise.resolve({ code: 0, stdout: '', stderr: '' }); };
  const runner = createGitChangesRunner({ kind: 'remote', cwd: '/srv/app', alias: 'vps', exec });
  await runner.diff('x.js');

  assert.equal(seenOpts.length, 1);
  assert.equal(seenOpts[0].maxStdoutBytes, DIFF_MAX_STDOUT_BYTES);
  assert.ok(DIFF_MAX_STDOUT_BYTES > MAX_DIFF_BYTES, 'the transport cap must have slack above the display cap');
});

test('remote runner: a transport-level stdout-cap failure surfaces as ok:false with the cap message, not silently truncated', async () => {
  const exec = () => Promise.resolve({ code: -1, stdout: '', stderr: 'stdout exceeded 2097152 bytes' });
  const runner = createGitChangesRunner({ kind: 'remote', cwd: '/srv/app', alias: 'vps', exec });
  const result = await runner.status();
  assert.equal(result.ok, false);
  assert.match(result.error, /stdout exceeded 2097152 bytes/);
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
