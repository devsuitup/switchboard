'use strict';

// git-changes-runner.js — local (execFile, no shell) and remote (ssh, shell on
// the far end) command construction, fully injected: no real git, no ssh, no
// network. See .ai/contexts/ipc-bridge.md ("Changes panel") and issue #251.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  createGitChangesRunner,
  buildRemoteGitCommand,
  buildGitArgs,
  truncateDiffContent,
  boundErrorMessage,
  shQuote,
  isSafeCwd,
  isSafeGitPath,
  isSafeNoIndexPath,
  resolveLocalNoIndexOperand,
  MAX_DIFF_BYTES,
  STATUS_MAX_STDOUT_BYTES,
  DIFF_MAX_STDOUT_BYTES,
  MAX_ERROR_LINES,
  MAX_ERROR_CHARS,
  NOT_A_REPO_REASON,
} = require('../git-changes-runner');

// The guard resolves against the running platform's path rules, so a fixture
// cwd must be absolute FOR THAT PLATFORM: "/repo" is a drive-relative path on
// Windows, which the guard rightly refuses. REPO is "/repo" on POSIX and
// "<drive>:\repo" on Windows.
const REPO = path.resolve('/repo');
const REAL_REPO = path.resolve('/real/repo');
const OUTSIDE = path.resolve('/elsewhere');
const SIBLING = path.resolve('/repository-evil');
const inRepo = (...segments) => path.join(REPO, ...segments);

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
  const runner = createGitChangesRunner({ kind: 'local', cwd: REPO, exec });
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
  const runner = createGitChangesRunner({ kind: 'local', cwd: REPO, exec });
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
  const runner = createGitChangesRunner({ kind: 'local', cwd: REPO, exec });
  const result = await runner.status();
  assert.equal(result.ok, false);
  assert.match(result.error, /not a git repository/);
});

test('local runner .status(): a thrown exec rejects gracefully', async () => {
  const runner = createGitChangesRunner({ kind: 'local', cwd: REPO, exec: () => { throw new Error('ENOENT'); } });
  const result = await runner.status();
  assert.equal(result.ok, false);
  assert.match(result.error, /ENOENT/);
});

// --- local runner: .diff() --------------------------------------------------

test('local runner .diff(): unstaged diff args carry --literal-pathspecs, refuses an unsafe path before calling exec', async () => {
  const calls = [];
  const exec = (args) => { calls.push(args); return Promise.resolve({ code: 0, stdout: 'diff --git a/x b/x\n+line\n', stderr: '' }); };
  const runner = createGitChangesRunner({ kind: 'local', cwd: REPO, exec });

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
  const runner = createGitChangesRunner({ kind: 'local', cwd: REPO, exec });
  await runner.diff('src/x.js', { staged: true });
  assert.deepEqual(calls[0], ['--literal-pathspecs', 'diff', '--cached', '--', 'src/x.js']);
});

test('local runner .diff(): truncates content past 512 KB, on a line boundary, measured in bytes', async () => {
  const line = 'a'.repeat(100) + '\n'; // 101 bytes/line, ASCII
  const big = line.repeat(6000); // ~600 KB, well past the 512 KB cap
  const exec = () => Promise.resolve({ code: 0, stdout: big, stderr: '' });
  const runner = createGitChangesRunner({ kind: 'local', cwd: REPO, exec });
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
  const runner = createGitChangesRunner({ kind: 'local', cwd: REPO, exec });
  const result = await runner.diff('x.js');
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.content, 'utf8') <= MAX_DIFF_BYTES, 'a char-length cap would overshoot the byte cap here');
});

test('local runner .diff(): a diff under the cap is not marked truncated', async () => {
  const exec = () => Promise.resolve({ code: 0, stdout: 'small diff\n', stderr: '' });
  const runner = createGitChangesRunner({ kind: 'local', cwd: REPO, exec });
  const result = await runner.diff('x.js');
  assert.equal(result.truncated, false);
  assert.equal(result.content, 'small diff\n');
});

// --- local runner: .diff({untracked:true}) ----------------------------------

// The fs seam the local containment check goes through. By default every path
// is its own real path and every leaf is a regular file; `links` redirects a
// single path the way a symlink would.
// `type` is what lstat() sees; `target` is what stat() sees through a symlink
// ('missing' throws, the way a dangling link does).
function fakeFsOps({ links = {}, type = 'file', target = 'file' } = {}) {
  return {
    realpath: (p) => {
      if (Object.prototype.hasOwnProperty.call(links, p)) return links[p];
      return p;
    },
    lstat: () => ({ isFile: () => type === 'file', isSymbolicLink: () => type === 'symlink' }),
    stat: () => {
      if (target === 'missing') throw new Error('ENOENT: no such file or directory');
      return { isFile: () => target === 'file', isDirectory: () => target === 'dir' };
    },
  };
}

// A --no-index diff whose header names `p`, the way real git spells it.
function untrackedDiffFor(p) {
  return `diff --git a/${p} b/${p}\nnew file mode 100644\nindex 0000000..2cdcdb0\n--- /dev/null\n+++ b/${p}\n@@ -0,0 +1,2 @@\n+a1\n+a2\n`;
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
  const runner = createGitChangesRunner({ kind: 'local', cwd: REPO, exec, fsOps: fakeFsOps() });
  const result = await runner.diff('new.txt', { untracked: true });

  assert.equal(result.ok, true, 'exit 1 from --no-index means "they differ", not "it failed"');
  assert.equal(result.content, UNTRACKED_DIFF);
  assert.equal(result.truncated, false);
});

test('local runner .diff({untracked:true}): builds a --no-index invocation against /dev/null, with -- before the two operands', async () => {
  const calls = [];
  const exec = (args) => { calls.push(args); return Promise.resolve({ code: 1, stdout: UNTRACKED_DIFF, stderr: '' }); };
  const runner = createGitChangesRunner({ kind: 'local', cwd: REPO, exec, fsOps: fakeFsOps() });
  await runner.diff('new.txt', { untracked: true });

  assert.deepEqual(calls[0], ['--literal-pathspecs', '-c', 'core.quotepath=false', 'diff', '--no-index', '--', '/dev/null', 'new.txt']);
  assert.ok(!calls[0].includes('--cached'), 'an untracked file has nothing in the index');
});

test('local runner .diff({untracked:true}): returns the added-line count the status pass could not know, with deleted 0', async () => {
  const exec = () => Promise.resolve({ code: 1, stdout: UNTRACKED_DIFF, stderr: '' });
  const runner = createGitChangesRunner({ kind: 'local', cwd: REPO, exec, fsOps: fakeFsOps() });
  const result = await runner.diff('new.txt', { untracked: true });

  assert.equal(result.added, 2);
  assert.equal(result.deleted, 0);
});

test('local runner .diff({untracked:true}): a binary file reports null counts and git\'s own note, not garbage', async () => {
  const binary = 'diff --git a/bin.dat b/bin.dat\nnew file mode 100644\nBinary files /dev/null and b/bin.dat differ\n';
  const exec = () => Promise.resolve({ code: 1, stdout: binary, stderr: '' });
  const runner = createGitChangesRunner({ kind: 'local', cwd: REPO, exec, fsOps: fakeFsOps() });
  const result = await runner.diff('bin.dat', { untracked: true });

  assert.equal(result.ok, true);
  assert.match(result.content, /Binary files .* differ/);
  assert.equal(result.added, null, 'a binary file has no line count — null, not 0');
  assert.equal(result.deleted, null);
});

test('local runner .diff({untracked:true}): a truncated diff reports null counts — a partial diff cannot be counted', async () => {
  const head = 'diff --git a/big.txt b/big.txt\n--- /dev/null\n+++ b/big.txt\n@@ -0,0 +1,6000 @@\n';
  const exec = () => Promise.resolve({ code: 1, stdout: head + ('+' + 'a'.repeat(100) + '\n').repeat(6000), stderr: '' });
  const runner = createGitChangesRunner({ kind: 'local', cwd: REPO, exec, fsOps: fakeFsOps() });
  const result = await runner.diff('big.txt', { untracked: true });

  assert.equal(result.truncated, true);
  assert.equal(result.added, null);
  assert.equal(result.deleted, null);
});

test('local runner .diff({untracked:true}): any exit code other than 0 or 1 is still an error', async () => {
  const exec = () => Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: not a git repository' });
  const runner = createGitChangesRunner({ kind: 'local', cwd: REPO, exec, fsOps: fakeFsOps() });
  const result = await runner.diff('new.txt', { untracked: true });

  assert.equal(result.ok, false);
  assert.match(result.error, /not a git repository/);
});

test('local runner .diff({untracked:true}): exit 1 with NO stdout and a message on stderr is an error — that is how --no-index reports an inaccessible operand', async () => {
  const exec = () => Promise.resolve({ code: 1, stdout: '', stderr: "error: Could not access 'gone.txt'" });
  const runner = createGitChangesRunner({ kind: 'local', cwd: REPO, exec, fsOps: fakeFsOps() });
  const result = await runner.diff('gone.txt', { untracked: true });

  assert.equal(result.ok, false);
  assert.match(result.error, /Could not access/);
});

test('local runner .diff({untracked:true}): an operand outside the working directory never reaches exec — --no-index would happily read it', async () => {
  let calls = 0;
  const exec = () => { calls++; return Promise.resolve({ code: 1, stdout: 'SECRET', stderr: '' }); };
  const runner = createGitChangesRunner({ kind: 'local', cwd: REPO, exec, fsOps: fakeFsOps() });

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
  const fsOps = fakeFsOps({ links: { [inRepo('link-to-dir')]: OUTSIDE } });
  const runner = createGitChangesRunner({ kind: 'local', cwd: REPO, exec, fsOps });

  const result = await runner.diff('link-to-dir/outside-secret.txt', { untracked: true });
  assert.equal(isSafeNoIndexPath('link-to-dir/outside-secret.txt'), true, 'the syntactic guard alone accepts this operand');
  assert.equal(result.ok, false, 'containment must be resolved on disk, not inferred from the string');
  assert.equal(result.error, 'invalid path');
  assert.equal(calls, 0, 'git must never be handed an operand that resolves outside the working directory');
});

test('local runner .diff({untracked:true}): git receives the guard\'s resolved operand, not the caller\'s string', async () => {
  const calls = [];
  const exec = (args) => { calls.push(args); return Promise.resolve({ code: 1, stdout: untrackedDiffFor('sub/new.txt'), stderr: '' }); };
  // The repo is reached through a symlinked ancestor: cwd and the operand's real
  // parent are spelled differently, and the operand must come out relative to the
  // resolved root.
  const fsOps = fakeFsOps({ links: { [REPO]: REAL_REPO } });
  const runner = createGitChangesRunner({ kind: 'local', cwd: REPO, exec, fsOps });

  const result = await runner.diff('sub/new.txt', { untracked: true });
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], ['--literal-pathspecs', '-c', 'core.quotepath=false', 'diff', '--no-index', '--', '/dev/null', 'sub/new.txt']);
});

test('local runner .diff({untracked:true}): a leaf symlink to a FILE is still diffable (git lstats that one — the link target string, never the target\'s content)', async () => {
  const exec = () => Promise.resolve({ code: 1, stdout: 'diff --git a/link-to-file b/link-to-file\nnew file mode 120000\n--- /dev/null\n+++ b/link-to-file\n@@ -0,0 +1 @@\n+/etc/passwd\n', stderr: '' });
  const fsOps = fakeFsOps({ type: 'symlink', target: 'file' });
  const runner = createGitChangesRunner({ kind: 'local', cwd: REPO, exec, fsOps });

  const result = await runner.diff('link-to-file', { untracked: true });
  assert.equal(result.ok, true, 'a symlink row that git lists must stay openable');
  assert.match(result.content, /new file mode 120000/);
});

test('local runner .diff({untracked:true}): a leaf symlink to a DIRECTORY never reaches git — it follows that one and pairs the operands by basename (mutation target: lstat alone)', async () => {
  let calls = 0;
  const exec = () => { calls++; return Promise.resolve({ code: 1, stdout: untrackedDiffFor('dirlink/null'), stderr: '' }); };
  const fsOps = fakeFsOps({ type: 'symlink', target: 'dir' });
  const runner = createGitChangesRunner({ kind: 'local', cwd: REPO, exec, fsOps });

  const result = await runner.diff('dirlink', { untracked: true });
  assert.equal(result.ok, false, 'git would diff <dirlink>/null, a file outside the repository');
  assert.equal(result.error, 'invalid path');
  assert.equal(calls, 0);
});

test('local runner .diff({untracked:true}): a dangling leaf symlink stays diffable — there is nothing for git to follow', async () => {
  const exec = () => Promise.resolve({ code: 1, stdout: 'diff --git a/dangling b/dangling\nnew file mode 120000\n--- /dev/null\n+++ b/dangling\n@@ -0,0 +1 @@\n+/gone\n', stderr: '' });
  const fsOps = fakeFsOps({ type: 'symlink', target: 'missing' });
  const runner = createGitChangesRunner({ kind: 'local', cwd: REPO, exec, fsOps });

  const result = await runner.diff('dangling', { untracked: true });
  assert.equal(result.ok, true);
});

// --- the diff header must name the file that was asked for ------------------

test('.diff({untracked:true}): a diff naming a path other than the one requested is refused, on either transport (mutation target: dropping the header check)', async () => {
  const leak = untrackedDiffFor('dirlink/null');

  // Local: the fs seam is made to lie about the leaf, so only the header check
  // can catch the basename pairing.
  const local = createGitChangesRunner({
    kind: 'local',
    cwd: REPO,
    exec: () => Promise.resolve({ code: 1, stdout: leak, stderr: '' }),
    fsOps: fakeFsOps({ type: 'file' }),
  });
  const localResult = await local.diff('dirlink', { untracked: true });
  assert.equal(localResult.ok, false);
  assert.equal(localResult.error, 'invalid path');

  // Remote: git's own listing returns the symlink itself, so the oracle passes
  // and the header check is the only thing left.
  const remote = createGitChangesRunner({
    kind: 'remote',
    cwd: '/srv/app',
    alias: 'vps',
    exec: (command) => (command.includes("'ls-files'")
      ? Promise.resolve({ code: 0, stdout: 'dirlink\0', stderr: '' })
      : Promise.resolve({ code: 1, stdout: leak, stderr: '' })),
  });
  const remoteResult = await remote.diff('dirlink', { untracked: true });
  assert.equal(remoteResult.ok, false, 'the remote transport has no filesystem to resolve against — the header is the check');
  assert.equal(remoteResult.error, 'invalid path');
  assert.ok(!String(remoteResult.content || '').includes('a1'), 'no content from the wrong file is returned');
});

test('.diff({untracked:true}): a quoted header (a name git cannot print verbatim) still matches its own path', async () => {
  const quoted = 'diff --git "a/quote\\".txt" "b/quote\\".txt"\nnew file mode 100644\n--- /dev/null\n+++ "b/quote\\".txt"\n@@ -0,0 +1 @@\n+x\n';
  const runner = createGitChangesRunner({
    kind: 'local',
    cwd: REPO,
    exec: () => Promise.resolve({ code: 1, stdout: quoted, stderr: '' }),
    fsOps: fakeFsOps(),
  });
  const result = await runner.diff('quote".txt', { untracked: true });
  assert.equal(result.ok, true, 'a legitimately named file must not be refused by the header check');
  assert.equal(result.added, 1);
});

test('.diff({untracked:true}): a binary diff has no "+++" line at all and is still matched, by its "diff --git" line', async () => {
  const binary = 'diff --git a/bin.dat b/bin.dat\nnew file mode 100644\nindex 0000000..c94be36\nBinary files /dev/null and b/bin.dat differ\n';
  const runner = createGitChangesRunner({
    kind: 'local',
    cwd: REPO,
    exec: () => Promise.resolve({ code: 1, stdout: binary, stderr: '' }),
    fsOps: fakeFsOps(),
  });
  const result = await runner.diff('bin.dat', { untracked: true });
  assert.equal(result.ok, true);
  assert.equal(result.added, null);
});

test('local runner .diff({untracked:true}): an operand that is neither a file nor a symlink (fifo, device, directory) never reaches git', async () => {
  let calls = 0;
  const exec = () => { calls++; return Promise.resolve({ code: 1, stdout: '', stderr: '' }); };
  const fsOps = fakeFsOps({ type: 'fifo' });
  const runner = createGitChangesRunner({ kind: 'local', cwd: REPO, exec, fsOps });

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
  const runner = createGitChangesRunner({ kind: 'local', cwd: REPO, exec, fsOps });

  const result = await runner.diff('gone.txt', { untracked: true });
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
});

// --- resolveLocalNoIndexOperand: the containment helper on its own -----------

// Both path flavours run on both platforms: `path.win32` and `path.posix` are
// available everywhere, so the Windows drive/separator arithmetic is exercised
// from a POSIX machine and vice versa — the failure that shipped was visible
// only on Windows CI.
const PATH_FLAVOURS = [
  { name: 'win32', pathOps: path.win32, root: 'C:\\Serveur\\repo', sep: '\\', outside: 'D:\\secrets', sibling: 'C:\\Serveur\\repo-evil' },
  { name: 'posix', pathOps: path.posix, root: '/srv/repo', sep: '/', outside: '/secrets', sibling: '/srv/repo-evil' },
];

for (const flavour of PATH_FLAVOURS) {
  const { name, pathOps, root, sep, outside, sibling } = flavour;

  test(`resolveLocalNoIndexOperand [${name}]: a legitimate path resolves to a git-spelled operand, always forward-slashed (mutation target: returning the native separator)`, () => {
    assert.equal(resolveLocalNoIndexOperand(root, 'a.txt', fakeFsOps(), pathOps), 'a.txt');
    assert.equal(resolveLocalNoIndexOperand(root, 'newdir/a.txt', fakeFsOps(), pathOps), 'newdir/a.txt');
    assert.equal(resolveLocalNoIndexOperand(root, 'deep/sub/dir/a.txt', fakeFsOps(), pathOps), 'deep/sub/dir/a.txt');
    assert.equal(resolveLocalNoIndexOperand(root, 'has..dots.txt', fakeFsOps(), pathOps), 'has..dots.txt');
  });

  test(`resolveLocalNoIndexOperand [${name}]: traversal and escapes are refused`, () => {
    assert.equal(resolveLocalNoIndexOperand(root, '../x.txt', fakeFsOps(), pathOps), null);
    assert.equal(resolveLocalNoIndexOperand(root, 'sub/../../x.txt', fakeFsOps(), pathOps), null);
    assert.equal(resolveLocalNoIndexOperand(root, '/etc/passwd', fakeFsOps(), pathOps), null);

    const escaping = fakeFsOps({ links: { [root + sep + 'link']: outside } });
    assert.equal(resolveLocalNoIndexOperand(root, 'link/secret.txt', escaping, pathOps), null,
      'a symlinked directory pointing out of the tree (another drive, on Windows) must not resolve inside it');

    const nextDoor = fakeFsOps({ links: { [root + sep + 'link']: sibling } });
    assert.equal(resolveLocalNoIndexOperand(root, 'link/x.txt', nextDoor, pathOps), null,
      'a sibling sharing the root as a string prefix is not inside it');
  });

  test(`resolveLocalNoIndexOperand [${name}]: a root that realpath spells differently from the cwd still resolves`, () => {
    // The leaf's parent IS the root, reached by another spelling — path.relative
    // returns '' for that, which is "the same directory", not "outside".
    const spelled = fakeFsOps({ links: { [root]: root + sep + '.' } });
    assert.equal(resolveLocalNoIndexOperand(root, 'a.txt', spelled, pathOps), 'a.txt');
  });

  test(`resolveLocalNoIndexOperand [${name}]: the leaf type rules hold whatever the separator`, () => {
    assert.equal(resolveLocalNoIndexOperand(root, 'link', fakeFsOps({ type: 'symlink', target: 'file' }), pathOps), 'link');
    assert.equal(resolveLocalNoIndexOperand(root, 'dirlink', fakeFsOps({ type: 'symlink', target: 'dir' }), pathOps), null);
    assert.equal(resolveLocalNoIndexOperand(root, 'afifo', fakeFsOps({ type: 'fifo' }), pathOps), null);
  });
}

test('resolveLocalNoIndexOperand [win32]: the same directory spelled two ways is inside itself, not outside (mutation target: treating an empty path.relative as "not inside")', () => {
  // The Windows CI failure in one line: "/repo" and the parent of its own
  // resolved child are the same directory under two spellings, and
  // path.relative says so by returning the empty string.
  const parentOfChild = path.win32.dirname(path.win32.resolve('/repo', 'new.txt'));
  assert.notEqual(parentOfChild, '/repo', 'win32 resolves a drive-less root to a different spelling');
  assert.equal(path.win32.relative('/repo', parentOfChild), '');
  assert.equal(resolveLocalNoIndexOperand('/repo', 'new.txt', fakeFsOps(), path.win32), 'new.txt');
});

test('resolveLocalNoIndexOperand: returns the operand relative to the resolved root, or null when it escapes', () => {
  const plain = fakeFsOps();
  assert.equal(resolveLocalNoIndexOperand(REPO, 'newdir/a.txt', plain), 'newdir/a.txt');
  assert.equal(resolveLocalNoIndexOperand(REPO, 'a.txt', plain), 'a.txt');
  assert.equal(resolveLocalNoIndexOperand(REPO, '../a.txt', plain), null);
  assert.equal(resolveLocalNoIndexOperand(REPO, '/etc/passwd', plain), null);

  const escaping = fakeFsOps({ links: { [inRepo('link')]: OUTSIDE } });
  assert.equal(resolveLocalNoIndexOperand(REPO, 'link/secret.txt', escaping), null);

  const sibling = fakeFsOps({ links: { [inRepo('link')]: SIBLING } });
  assert.equal(resolveLocalNoIndexOperand(REPO, 'link/x.txt', sibling), null, 'a sibling sharing the root as a string prefix is not inside it');
});

test('local runner .diff({untracked:true}): a thrown exec rejects gracefully', async () => {
  const runner = createGitChangesRunner({ kind: 'local', cwd: REPO, exec: () => { throw new Error('ENOENT'); }, fsOps: fakeFsOps() });
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
    return Promise.resolve({ code: 1, stdout: untrackedDiffFor(hostilePath), stderr: '' });
  };
  const runner = createGitChangesRunner({ kind: 'remote', cwd: '/srv/app', alias: 'vps', exec });
  const result = await runner.diff(hostilePath, { untracked: true });

  assert.equal(result.ok, true);
  assert.equal(commands.length, 2);
  assert.equal(commands[0], "git -C '/srv/app' '--literal-pathspecs' 'ls-files' '--others' '--exclude-standard' '-z' '--' 'weird `name`$(x).txt'");
  assert.equal(commands[1], "git -C '/srv/app' '--literal-pathspecs' '-c' 'core.quotepath=false' 'diff' '--no-index' '--' '/dev/null' 'weird `name`$(x).txt'");
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
  const runner = createGitChangesRunner({ kind: 'local', cwd: REPO, exec });
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
  const runner = createGitChangesRunner({ kind: 'local', cwd: REPO, exec });
  const result = await runner.status();

  assert.equal(result.ok, true);
  assert.equal(result.untrackedCollapsed, false);
  assert.equal(calls.filter((a) => a[1] === 'status').length, 1);
});

test('status(): a -uall failure that is not a stdout-cap overrun is reported, never relabelled as "too many untracked files" (mutation target: retrying on any non-zero exit)', async () => {
  const calls = [];
  const exec = (args) => {
    calls.push(args);
    if (args[1] !== 'status') return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    if (args.includes('-uall')) return Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: could not read directory: Permission denied' });
    return Promise.resolve({ code: 0, stdout: '# branch.head main\x00', stderr: '' });
  };
  const runner = createGitChangesRunner({ kind: 'local', cwd: REPO, exec });
  const result = await runner.status();

  assert.equal(result.ok, false, 'a permission error is not a volume problem');
  assert.match(result.error, /Permission denied/, 'the real error must not be discarded');
  assert.notEqual(result.untrackedCollapsed, true);
  assert.equal(calls.filter((a) => a[1] === 'status').length, 1, 'no retry for a failure the fallback cannot help with');
});

test('status(): the local maxBuffer overrun is recognised as a stdout-cap failure too, not only the remote transport\'s own message', async () => {
  const exec = (args) => {
    if (args[1] !== 'status') return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    if (args.includes('-uall')) return Promise.resolve({ code: -1, stdout: '', stderr: 'stdout maxBuffer length exceeded' });
    return Promise.resolve({ code: 0, stdout: '# branch.head main\x00', stderr: '' });
  };
  const runner = createGitChangesRunner({ kind: 'local', cwd: REPO, exec });
  const result = await runner.status();

  assert.equal(result.ok, true);
  assert.equal(result.untrackedCollapsed, true);
});

test('status(): a genuine status failure is still an error — the fallback must not swallow it', async () => {
  const exec = (args) => Promise.resolve(args[1] === 'status'
    ? { code: 128, stdout: '', stderr: 'fatal: not a git repository' }
    : { code: 0, stdout: '', stderr: '' });
  const runner = createGitChangesRunner({ kind: 'local', cwd: REPO, exec });
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

// --- Not a git work tree — see .ai/contexts/changes-view.md ("Not a repository") ---

// What git actually wrote on this host, in French, when the Changes panel was
// pointed at a directory outside any repository. The detection must not depend
// on a single byte of it.
const FRENCH_FATAL = 'fatal: ni ceci ni aucun de ses répertoires parents (jusqu\'au point de montage /) n\'est un dépôt git\nArrêt à la limite du système de fichiers (GIT_DISCOVERY_ACROSS_FILESYSTEM n\'est pas défini).';
const FRENCH_DIFF_USAGE = ['warning: Pas un dépôt git. Utilisez --no-index pour comparer deux chemins hors d\'un arbre de travail', 'usage : git diff --no-index [<options>] <path> <path> [<pathspec>...]']
  .concat(Array.from({ length: 150 }, (_, i) => `    --some-option-${i}      une description de l'option ${i}`)).join('\n');

// Every git command fails the way a non-repo cwd makes it fail, rev-parse included.
function nonRepoExec(calls) {
  return (args) => {
    calls.push(args);
    if (args[1] === 'rev-parse') return Promise.resolve({ code: 128, stdout: '', stderr: FRENCH_FATAL });
    if (args[1] === 'status') return Promise.resolve({ code: 128, stdout: '', stderr: FRENCH_FATAL });
    return Promise.resolve({ code: 129, stdout: '', stderr: FRENCH_DIFF_USAGE });
  };
}

test('status(): a cwd outside any repository is its own machine-readable outcome, not a git message (mutation target: returning firstError)', async () => {
  const calls = [];
  const runner = createGitChangesRunner({ kind: 'local', cwd: REPO, exec: nonRepoExec(calls) });
  const result = await runner.status();

  assert.equal(result.ok, false);
  assert.equal(result.reason, NOT_A_REPO_REASON, 'the renderer must key on a reason, not parse a string');
  assert.equal(result.error, 'not a git repository');
  assert.equal(calls.filter((a) => a[1] === 'rev-parse').length, 1, 'exactly one probe, after the failure');
});

test('status(): nothing git wrote reaches the caller when the cwd is outside a repository', async () => {
  const runner = createGitChangesRunner({ kind: 'local', cwd: REPO, exec: nonRepoExec([]) });
  const result = await runner.status();

  assert.doesNotMatch(result.error, /dépôt|fatal|usage|GIT_DISCOVERY/,
    'a localized fatal and a 150-line usage page are exactly what must not land in the panel');
  assert.ok(result.error.length < 60);
});

test('status(): the detection is the exit code, so a translated git says the same thing as an English one', async () => {
  const ENGLISH_FATAL = 'fatal: not a git repository (or any parent up to mount point /)\nStopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).';
  const english = (args) => Promise.resolve(args[1] === 'diff'
    ? { code: 129, stdout: '', stderr: 'usage: git diff --no-index' }
    : { code: 128, stdout: '', stderr: ENGLISH_FATAL });

  const fr = await createGitChangesRunner({ kind: 'local', cwd: REPO, exec: nonRepoExec([]) }).status();
  const en = await createGitChangesRunner({ kind: 'local', cwd: REPO, exec: english }).status();
  assert.deepEqual(en, fr);
});

test('status(): a healthy repository never pays for the probe (mutation target: probing on every refresh)', async () => {
  const calls = [];
  const exec = (args) => {
    calls.push(args);
    return Promise.resolve({ code: 0, stdout: args[1] === 'status' ? '# branch.head main\x00' : '', stderr: '' });
  };
  const result = await createGitChangesRunner({ kind: 'local', cwd: REPO, exec }).status();

  assert.equal(result.ok, true);
  assert.equal(calls.length, 3, 'three commands, not four — the probe is a diagnosis, not a precondition');
  assert.equal(calls.filter((a) => a[1] === 'rev-parse').length, 0);
});

test('status(): a failure inside a real repository keeps its own message and carries no reason', async () => {
  const exec = (args) => {
    if (args[1] === 'rev-parse') return Promise.resolve({ code: 0, stdout: 'true\n', stderr: '' });
    if (args[1] === 'status') return Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: could not read directory: Permission denied' });
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  };
  const result = await createGitChangesRunner({ kind: 'local', cwd: REPO, exec }).status();

  assert.equal(result.ok, false);
  assert.equal(result.reason, undefined, 'a broken repository is not the same condition as no repository');
  assert.match(result.error, /Permission denied/);
});

test('status(): an ssh transport failure is never mistaken for "no repository"', async () => {
  // ssh's own failure exit is 255, not git's 128; the probe cannot answer, so
  // the original error stands.
  const exec = () => Promise.resolve({ code: 255, stdout: '', stderr: 'ssh: connect to host build-01 port 22: Connection refused' });
  const result = await createGitChangesRunner({ kind: 'remote', cwd: '/srv/app', alias: 'build-01', exec }).status();

  assert.equal(result.ok, false);
  assert.equal(result.reason, undefined);
  assert.match(result.error, /Connection refused/);
});

test('status(): a remote cwd outside any repository reaches the same outcome as a local one', async () => {
  const calls = [];
  const exec = (command) => {
    calls.push(command);
    return Promise.resolve({ code: command.includes("'rev-parse'") || command.includes("'status'") ? 128 : 129, stdout: '', stderr: FRENCH_FATAL });
  };
  const result = await createGitChangesRunner({ kind: 'remote', cwd: '/srv/app', alias: 'build-01', exec }).status();

  assert.equal(result.reason, NOT_A_REPO_REASON, 'local and remote must not disagree about what the panel shows');
  assert.equal(result.error, 'not a git repository');
  assert.ok(calls.some((c) => c === "git -C '/srv/app' '--literal-pathspecs' 'rev-parse' '--is-inside-work-tree'"),
    'the probe goes through the same quoted transport as every other command');
});

// --- isWorkTree() ----------------------------------------------------------

test('isWorkTree(): the exit code and the printed answer, never the message', async () => {
  const run = (response) => createGitChangesRunner({ kind: 'local', cwd: REPO, exec: () => Promise.resolve(response) }).isWorkTree();

  assert.deepEqual(await run({ code: 0, stdout: 'true\n', stderr: '' }), { ok: true, isRepo: true });
  assert.deepEqual(await run({ code: 128, stdout: '', stderr: FRENCH_FATAL }), { ok: true, isRepo: false });
  assert.deepEqual(await run({ code: 0, stdout: 'false\n', stderr: '' }), { ok: true, isRepo: false },
    'a bare repository has no work tree, so it has no changes to show either');

  const broken = await run({ code: 255, stdout: '', stderr: 'ssh: Connection refused' });
  assert.equal(broken.ok, false, 'a transport failure is not an answer');
  assert.match(broken.error, /Connection refused/);

  const mute = await run({ code: 0, stdout: '', stderr: '' });
  assert.equal(mute.ok, false, 'no answer is not the same as "no"');
});

test('isWorkTree(): a thrown exec is reported, not treated as a missing repository', async () => {
  const runner = createGitChangesRunner({ kind: 'local', cwd: REPO, exec: () => { throw new Error('ENOENT'); } });
  const result = await runner.isWorkTree();
  assert.equal(result.ok, false);
  assert.match(result.error, /ENOENT/);
});

// --- Bounded error messages — see .ai/contexts/changes-view.md --------------

test('boundErrorMessage: git\'s 150-line usage page is cut to the stated bound (mutation target: dropping the cap)', () => {
  const bounded = boundErrorMessage(FRENCH_DIFF_USAGE);

  assert.ok(bounded.split('\n').length <= MAX_ERROR_LINES, `at most ${MAX_ERROR_LINES} lines`);
  assert.ok(bounded.length <= MAX_ERROR_CHARS + 1, `at most ${MAX_ERROR_CHARS} characters plus the ellipsis`);
  assert.ok(bounded.endsWith('…'), 'the cut is signalled, not silent');
  assert.match(bounded, /Pas un dépôt git/, 'the first, informative line survives');
  assert.ok(FRENCH_DIFF_USAGE.length > 4000, 'the fixture has to be big enough for the bound to bite');
});

test('boundErrorMessage: a short message passes through whole, with no ellipsis', () => {
  assert.equal(boundErrorMessage('fatal: could not read directory: Permission denied'),
    'fatal: could not read directory: Permission denied');
  assert.equal(boundErrorMessage('  \n  '), '');
});

test('boundErrorMessage: one enormous line is cut by characters, not only by lines', () => {
  const bounded = boundErrorMessage('x'.repeat(10_000));
  assert.ok(bounded.length <= MAX_ERROR_CHARS + 1);
  assert.ok(bounded.endsWith('…'));
});

test('.diff(): an unexpected git failure reaches the caller bounded, never as the whole usage page', async () => {
  const exec = () => Promise.resolve({ code: 129, stdout: '', stderr: FRENCH_DIFF_USAGE });
  const result = await createGitChangesRunner({ kind: 'local', cwd: REPO, exec }).diff('foo.js');

  assert.equal(result.ok, false);
  assert.ok(result.error.split('\n').length <= MAX_ERROR_LINES);
  assert.ok(result.error.length <= MAX_ERROR_CHARS + 1);
});
