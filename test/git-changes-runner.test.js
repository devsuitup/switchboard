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
  isSafeNoIndexPath,
  resolveLocalNoIndexOperand,
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

test('isSafeGitPath rejects ".." as a whole path segment, in either separator (mutation target: only checking the first segment)', () => {
  assert.equal(isSafeGitPath('..'), false);
  assert.equal(isSafeGitPath('../x'), false);
  assert.equal(isSafeGitPath('a/..'), false);
  assert.equal(isSafeGitPath('a/../../b'), false);
  assert.equal(isSafeGitPath('a/../b'), false);
  assert.equal(isSafeGitPath('..\\windows\\x'), false);
  assert.equal(isSafeGitPath('a\\..\\b'), false);
});

test('isSafeGitPath accepts ".." inside a filename — it is a name, not a traversal (mutation target: a substring test)', () => {
  assert.equal(isSafeGitPath('has..dots.txt'), true);
  assert.equal(isSafeGitPath('v1..v2.diff'), true);
  assert.equal(isSafeGitPath('..leading.txt'), true);
  assert.equal(isSafeGitPath('trailing..'), true);
  assert.equal(isSafeGitPath('src/archive..2024.tar'), true);
  assert.equal(isSafeNoIndexPath('has..dots.txt'), true, 'the untracked operand guard inherits the same rule');
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

// --- isSafeNoIndexPath: the guard for a --no-index filesystem operand -------

test('isSafeNoIndexPath rejects an absolute path — --no-index has no repository-containment check of its own (mutation target: reusing isSafeGitPath here)', () => {
  assert.equal(isSafeNoIndexPath('/etc/passwd'), false);
  assert.equal(isSafeNoIndexPath('\\\\host\\share\\secret'), false);
  assert.equal(isSafeNoIndexPath('C:/Users/dev/.ssh/id_rsa'), false);
  assert.equal(isSafeNoIndexPath('c:\\Users\\dev\\.ssh\\id_rsa'), false);
  assert.equal(isSafeGitPath('/etc/passwd'), true, 'the pathspec guard accepts it — git itself refuses it there, but --no-index would not');
});

test('isSafeNoIndexPath rejects a leading "-" — a --no-index operand sits where git parses options', () => {
  assert.equal(isSafeNoIndexPath('-R'), false);
  assert.equal(isSafeNoIndexPath('--output=/tmp/x'), false);
  assert.equal(isSafeNoIndexPath('src/-dash.txt'), true, 'a dash that is not in the first position is an ordinary filename');
});

test('isSafeNoIndexPath keeps the pathspec guard\'s rejections and accepts an ordinary relative path', () => {
  assert.equal(isSafeNoIndexPath('../escape.txt'), false);
  assert.equal(isSafeNoIndexPath('a\0b'), false);
  assert.equal(isSafeNoIndexPath(':(exclude)x'), false);
  assert.equal(isSafeNoIndexPath('newdir/sub/b.txt'), true);
  assert.equal(isSafeNoIndexPath('café/déjà vu.txt'), true);
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

test('local runner .status(): status runs with -uall so a wholly-untracked directory is listed file by file, never as one directory row (mutation target: dropping -uall)', async () => {
  const { exec, calls } = localFakeExec({});
  const runner = createGitChangesRunner({ kind: 'local', cwd: '/repo', exec });
  await runner.status();

  const statusArgs = calls.find((args) => args[1] === 'status');
  assert.deepEqual(statusArgs, ['--literal-pathspecs', 'status', '--porcelain=v2', '--branch', '-uall', '-z']);
  for (const args of calls) {
    if (args[1] === 'diff') assert.ok(!args.includes('-uall'), '-uall belongs to status only, it is not a diff option');
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

// --- local runner: .diff({untracked:true}) ----------------------------------

// The fs seam the local containment check goes through. By default every path
// is its own real path and every leaf is a regular file; `links` redirects a
// single path the way a symlink would.
function fakeFsOps({ links = {}, type = 'file' } = {}) {
  return {
    realpath: (p) => {
      if (Object.prototype.hasOwnProperty.call(links, p)) return links[p];
      return p;
    },
    lstat: () => ({ isFile: () => type === 'file', isSymbolicLink: () => type === 'symlink' }),
  };
}

const UNTRACKED_DIFF = [
  'diff --git a/new.txt b/new.txt',
  'new file mode 100644',
  'index 0000000..2cdcdb0',
  '--- /dev/null',
  '+++ b/new.txt',
  '@@ -0,0 +1,2 @@',
  '+a1',
  '+a2',
  '',
].join('\n');

test('local runner .diff({untracked:true}): exit code 1 with a diff on stdout is SUCCESS — git diff --no-index exits 1 whenever the two inputs differ (mutation target: the usual code !== 0 check)', async () => {
  const exec = () => Promise.resolve({ code: 1, stdout: UNTRACKED_DIFF, stderr: '' });
  const runner = createGitChangesRunner({ kind: 'local', cwd: '/repo', exec, fsOps: fakeFsOps() });
  const result = await runner.diff('new.txt', { untracked: true });

  assert.equal(result.ok, true, 'exit 1 from --no-index means "they differ", not "it failed"');
  assert.equal(result.content, UNTRACKED_DIFF);
  assert.equal(result.truncated, false);
});

test('local runner .diff({untracked:true}): builds a --no-index invocation against /dev/null, with -- before the two operands', async () => {
  const calls = [];
  const exec = (args) => { calls.push(args); return Promise.resolve({ code: 1, stdout: UNTRACKED_DIFF, stderr: '' }); };
  const runner = createGitChangesRunner({ kind: 'local', cwd: '/repo', exec, fsOps: fakeFsOps() });
  await runner.diff('new.txt', { untracked: true });

  assert.deepEqual(calls[0], ['--literal-pathspecs', 'diff', '--no-index', '--', '/dev/null', 'new.txt']);
  assert.ok(!calls[0].includes('--cached'), 'an untracked file has nothing in the index');
});

test('local runner .diff({untracked:true}): returns the added-line count the status pass could not know, with deleted 0', async () => {
  const exec = () => Promise.resolve({ code: 1, stdout: UNTRACKED_DIFF, stderr: '' });
  const runner = createGitChangesRunner({ kind: 'local', cwd: '/repo', exec, fsOps: fakeFsOps() });
  const result = await runner.diff('new.txt', { untracked: true });

  assert.equal(result.added, 2);
  assert.equal(result.deleted, 0);
});

test('local runner .diff({untracked:true}): a binary file reports null counts and git\'s own note, not garbage', async () => {
  const binary = 'diff --git a/bin.dat b/bin.dat\nnew file mode 100644\nBinary files /dev/null and b/bin.dat differ\n';
  const exec = () => Promise.resolve({ code: 1, stdout: binary, stderr: '' });
  const runner = createGitChangesRunner({ kind: 'local', cwd: '/repo', exec, fsOps: fakeFsOps() });
  const result = await runner.diff('bin.dat', { untracked: true });

  assert.equal(result.ok, true);
  assert.match(result.content, /Binary files .* differ/);
  assert.equal(result.added, null, 'a binary file has no line count — null, not 0');
  assert.equal(result.deleted, null);
});

test('local runner .diff({untracked:true}): a truncated diff reports null counts — a partial diff cannot be counted', async () => {
  const head = 'diff --git a/big.txt b/big.txt\n--- /dev/null\n+++ b/big.txt\n@@ -0,0 +1,6000 @@\n';
  const exec = () => Promise.resolve({ code: 1, stdout: head + ('+' + 'a'.repeat(100) + '\n').repeat(6000), stderr: '' });
  const runner = createGitChangesRunner({ kind: 'local', cwd: '/repo', exec, fsOps: fakeFsOps() });
  const result = await runner.diff('big.txt', { untracked: true });

  assert.equal(result.truncated, true);
  assert.equal(result.added, null);
  assert.equal(result.deleted, null);
});

test('local runner .diff({untracked:true}): any exit code other than 0 or 1 is still an error', async () => {
  const exec = () => Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: not a git repository' });
  const runner = createGitChangesRunner({ kind: 'local', cwd: '/repo', exec, fsOps: fakeFsOps() });
  const result = await runner.diff('new.txt', { untracked: true });

  assert.equal(result.ok, false);
  assert.match(result.error, /not a git repository/);
});

test('local runner .diff({untracked:true}): exit 1 with NO stdout and a message on stderr is an error — that is how --no-index reports an inaccessible operand', async () => {
  const exec = () => Promise.resolve({ code: 1, stdout: '', stderr: "error: Could not access 'gone.txt'" });
  const runner = createGitChangesRunner({ kind: 'local', cwd: '/repo', exec, fsOps: fakeFsOps() });
  const result = await runner.diff('gone.txt', { untracked: true });

  assert.equal(result.ok, false);
  assert.match(result.error, /Could not access/);
});

test('local runner .diff({untracked:true}): an operand outside the working directory never reaches exec — --no-index would happily read it', async () => {
  let calls = 0;
  const exec = () => { calls++; return Promise.resolve({ code: 1, stdout: 'SECRET', stderr: '' }); };
  const runner = createGitChangesRunner({ kind: 'local', cwd: '/repo', exec, fsOps: fakeFsOps() });

  for (const bad of ['/etc/passwd', '../../etc/passwd', 'C:/Users/dev/.ssh/id_rsa', '--output=/tmp/pwn']) {
    const result = await runner.diff(bad, { untracked: true });
    assert.equal(result.ok, false, `${bad} must be refused`);
    assert.equal(result.error, 'invalid path');
  }
  assert.equal(calls, 0, 'no unsafe operand may ever reach exec');
});

test('local runner .diff({untracked:true}): a symlinked directory inside the repo cannot be used to read outside it (mutation target: a syntax-only guard)', async () => {
  let calls = 0;
  const exec = () => { calls++; return Promise.resolve({ code: 1, stdout: 'SUPER_SECRET_OUTSIDE_THE_REPO', stderr: '' }); };
  // repo/link-to-dir is a symlink to /elsewhere: the operand has no "..", is not
  // absolute, and every syntactic check passes.
  const fsOps = fakeFsOps({ links: { '/repo/link-to-dir': '/elsewhere' } });
  const runner = createGitChangesRunner({ kind: 'local', cwd: '/repo', exec, fsOps });

  const result = await runner.diff('link-to-dir/outside-secret.txt', { untracked: true });
  assert.equal(isSafeNoIndexPath('link-to-dir/outside-secret.txt'), true, 'the syntactic guard alone accepts this operand');
  assert.equal(result.ok, false, 'containment must be resolved on disk, not inferred from the string');
  assert.equal(result.error, 'invalid path');
  assert.equal(calls, 0, 'git must never be handed an operand that resolves outside the working directory');
});

test('local runner .diff({untracked:true}): git receives the guard\'s resolved operand, not the caller\'s string', async () => {
  const calls = [];
  const exec = (args) => { calls.push(args); return Promise.resolve({ code: 1, stdout: UNTRACKED_DIFF, stderr: '' }); };
  // The repo is reached through a symlinked ancestor: cwd and the operand's real
  // parent are spelled differently, and the operand must come out relative to the
  // resolved root.
  const fsOps = fakeFsOps({ links: { '/repo': '/real/repo', '/real/repo/sub': '/real/repo/sub' } });
  const runner = createGitChangesRunner({ kind: 'local', cwd: '/repo', exec, fsOps });

  const result = await runner.diff('sub/new.txt', { untracked: true });
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], ['--literal-pathspecs', 'diff', '--no-index', '--', '/dev/null', 'sub/new.txt']);
});

test('local runner .diff({untracked:true}): a leaf symlink is still diffable (git lstats it — the link target string, never the target\'s content)', async () => {
  const exec = () => Promise.resolve({ code: 1, stdout: 'diff --git a/l b/l\nnew file mode 120000\n@@ -0,0 +1 @@\n+/etc/passwd\n', stderr: '' });
  const fsOps = fakeFsOps({ type: 'symlink' });
  const runner = createGitChangesRunner({ kind: 'local', cwd: '/repo', exec, fsOps });

  const result = await runner.diff('link-to-file', { untracked: true });
  assert.equal(result.ok, true, 'a symlink row that git lists must stay openable');
  assert.match(result.content, /new file mode 120000/);
});

test('local runner .diff({untracked:true}): an operand that is neither a file nor a symlink (fifo, device, directory) never reaches git', async () => {
  let calls = 0;
  const exec = () => { calls++; return Promise.resolve({ code: 1, stdout: '', stderr: '' }); };
  const fsOps = fakeFsOps({ type: 'fifo' });
  const runner = createGitChangesRunner({ kind: 'local', cwd: '/repo', exec, fsOps });

  const result = await runner.diff('afifo', { untracked: true });
  assert.equal(result.ok, false);
  assert.equal(calls, 0, 'git would block on a fifo until the timeout');
});

test('local runner .diff({untracked:true}): a vanished operand is refused before git runs', async () => {
  let calls = 0;
  const exec = () => { calls++; return Promise.resolve({ code: 1, stdout: '', stderr: '' }); };
  const fsOps = {
    realpath: (p) => p,
    lstat: () => { throw new Error('ENOENT: no such file or directory'); },
  };
  const runner = createGitChangesRunner({ kind: 'local', cwd: '/repo', exec, fsOps });

  const result = await runner.diff('gone.txt', { untracked: true });
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
});

// --- resolveLocalNoIndexOperand: the containment helper on its own -----------

test('resolveLocalNoIndexOperand: returns the operand relative to the resolved root, or null when it escapes', () => {
  const plain = fakeFsOps();
  assert.equal(resolveLocalNoIndexOperand('/repo', 'newdir/a.txt', plain), 'newdir/a.txt');
  assert.equal(resolveLocalNoIndexOperand('/repo', 'a.txt', plain), 'a.txt');
  assert.equal(resolveLocalNoIndexOperand('/repo', '../a.txt', plain), null);
  assert.equal(resolveLocalNoIndexOperand('/repo', '/etc/passwd', plain), null);

  const escaping = fakeFsOps({ links: { '/repo/link': '/elsewhere' } });
  assert.equal(resolveLocalNoIndexOperand('/repo', 'link/secret.txt', escaping), null);

  const sibling = fakeFsOps({ links: { '/repo/link': '/repository-evil' } });
  assert.equal(resolveLocalNoIndexOperand('/repo', 'link/x.txt', sibling), null, 'a sibling sharing the root as a string prefix is not inside it');
});

test('local runner .diff({untracked:true}): a thrown exec rejects gracefully', async () => {
  const runner = createGitChangesRunner({ kind: 'local', cwd: '/repo', exec: () => { throw new Error('ENOENT'); }, fsOps: fakeFsOps() });
  const result = await runner.diff('new.txt', { untracked: true });
  assert.equal(result.ok, false);
  assert.match(result.error, /ENOENT/);
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
  assert.equal(
    commands.find((c) => c.includes("'status'")),
    "git -C '/srv/app' '--literal-pathspecs' 'status' '--porcelain=v2' '--branch' '-uall' '-z'"
  );
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

test('remote runner .diff({untracked:true}): every token of the --no-index command is individually quoted, and no backtick is ever emitted', async () => {
  const commands = [];
  const seenOpts = [];
  const hostilePath = "weird `name`$(x).txt";
  const exec = (command, opts) => {
    commands.push(command);
    seenOpts.push(opts);
    if (command.includes("'ls-files'")) return Promise.resolve({ code: 0, stdout: hostilePath + '\0', stderr: '' });
    return Promise.resolve({ code: 1, stdout: UNTRACKED_DIFF, stderr: '' });
  };
  const runner = createGitChangesRunner({ kind: 'remote', cwd: '/srv/app', alias: 'vps', exec });
  const result = await runner.diff(hostilePath, { untracked: true });

  assert.equal(result.ok, true);
  assert.equal(commands.length, 2);
  assert.equal(commands[0], "git -C '/srv/app' '--literal-pathspecs' 'ls-files' '--others' '--exclude-standard' '-z' '--' 'weird `name`$(x).txt'");
  assert.equal(commands[1], "git -C '/srv/app' '--literal-pathspecs' 'diff' '--no-index' '--' '/dev/null' 'weird `name`$(x).txt'");
  for (const cmd of commands) {
    assert.match(cmd, /^git -C '[^']*' ('[^']*' )*'[^']*'$/s, 'the backtick never sits outside a quoted token');
  }
  assert.equal(seenOpts[1].maxStdoutBytes, DIFF_MAX_STDOUT_BYTES);
});

test('remote runner .diff({untracked:true}): git itself must list the path as untracked before any diff runs — no local filesystem to resolve against', async () => {
  const commands = [];
  const exec = (command) => {
    commands.push(command);
    if (command.includes("'ls-files'")) return Promise.resolve({ code: 0, stdout: 'new.txt\0', stderr: '' });
    return Promise.resolve({ code: 1, stdout: UNTRACKED_DIFF, stderr: '' });
  };
  const runner = createGitChangesRunner({ kind: 'remote', cwd: '/srv/app', alias: 'vps', exec });
  const result = await runner.diff('new.txt', { untracked: true });

  assert.equal(result.ok, true);
  assert.equal(commands.length, 2, 'the listing check runs before the diff, not alongside it');
  assert.equal(commands[0], "git -C '/srv/app' '--literal-pathspecs' 'ls-files' '--others' '--exclude-standard' '-z' '--' 'new.txt'");
  assert.ok(commands[1].includes("'--no-index'"));
});

test('remote runner .diff({untracked:true}): a path git does not list as untracked never reaches the diff (mutation target: skipping the listing check)', async () => {
  const commands = [];
  const exec = (command) => {
    commands.push(command);
    // A path reached through a symlinked directory: git's own traversal never
    // lists it, so the listing comes back empty.
    if (command.includes("'ls-files'")) return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    return Promise.resolve({ code: 1, stdout: 'SUPER_SECRET_OUTSIDE_THE_REPO', stderr: '' });
  };
  const runner = createGitChangesRunner({ kind: 'remote', cwd: '/srv/app', alias: 'vps', exec });
  const result = await runner.diff('link-to-dir/outside-secret.txt', { untracked: true });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid path');
  assert.equal(commands.length, 1, 'no diff command may be sent for an unlisted path');
});

test('remote runner .diff({untracked:true}): a prefix match is not a match — the listed path must be the requested one', async () => {
  const exec = (command) => (command.includes("'ls-files'")
    ? Promise.resolve({ code: 0, stdout: 'new.txt.bak\0', stderr: '' })
    : Promise.resolve({ code: 1, stdout: UNTRACKED_DIFF, stderr: '' }));
  const runner = createGitChangesRunner({ kind: 'remote', cwd: '/srv/app', alias: 'vps', exec });
  const result = await runner.diff('new.txt', { untracked: true });
  assert.equal(result.ok, false);
});

test('remote runner .diff({untracked:true}): a failing listing surfaces git\'s error instead of running the diff', async () => {
  const exec = (command) => (command.includes("'ls-files'")
    ? Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: not a git repository' })
    : Promise.resolve({ code: 1, stdout: UNTRACKED_DIFF, stderr: '' }));
  const runner = createGitChangesRunner({ kind: 'remote', cwd: '/srv/app', alias: 'vps', exec });
  const result = await runner.diff('new.txt', { untracked: true });
  assert.equal(result.ok, false);
  assert.match(result.error, /not a git repository/);
});

// --- status(): the -uall fallback ------------------------------------------

test('status(): when -uall overruns the transport cap, tracked changes still render, flagged as a collapsed untracked listing (mutation target: returning ok:false)', async () => {
  const calls = [];
  const exec = (args) => {
    calls.push(args);
    if (args[1] !== 'status') return Promise.resolve({ code: 0, stdout: '1\t2\tfoo.js\0', stderr: '' });
    if (args.includes('-uall')) return Promise.resolve({ code: -1, stdout: '', stderr: 'stdout exceeded 2097152 bytes' });
    return Promise.resolve({ code: 0, stdout: '# branch.head main\x001 .M N... 100644 100644 100644 abc123 def456 foo.js\x00? vendor/\x00', stderr: '' });
  };
  const runner = createGitChangesRunner({ kind: 'local', cwd: '/repo', exec });
  const result = await runner.status();

  assert.equal(result.ok, true, 'the panel must not go dark because there are too many untracked files');
  assert.equal(result.untrackedCollapsed, true);
  assert.equal(result.files.length, 2);
  assert.equal(result.files[0].path, 'foo.js', 'the tracked change is still there');
  assert.equal(calls.filter((a) => a[1] === 'status').length, 2, 'exactly one retry, with git\'s default untracked mode');
});

test('status(): a healthy -uall run reports untrackedCollapsed false and never retries', async () => {
  const calls = [];
  const exec = (args) => {
    calls.push(args);
    return Promise.resolve({ code: 0, stdout: args[1] === 'status' ? '# branch.head main\x00' : '', stderr: '' });
  };
  const runner = createGitChangesRunner({ kind: 'local', cwd: '/repo', exec });
  const result = await runner.status();

  assert.equal(result.ok, true);
  assert.equal(result.untrackedCollapsed, false);
  assert.equal(calls.filter((a) => a[1] === 'status').length, 1);
});

test('status(): a genuine status failure is still an error — the fallback must not swallow it', async () => {
  const exec = (args) => Promise.resolve(args[1] === 'status'
    ? { code: 128, stdout: '', stderr: 'fatal: not a git repository' }
    : { code: 0, stdout: '', stderr: '' });
  const runner = createGitChangesRunner({ kind: 'local', cwd: '/repo', exec });
  const result = await runner.status();

  assert.equal(result.ok, false);
  assert.match(result.error, /not a git repository/);
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
