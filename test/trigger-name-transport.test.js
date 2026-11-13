'use strict';

// see .ai/contexts/trigger-watcher.md ("Naming a new session")
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { launch, ID } = require('./fixtures/trigger-name-launch.cjs');
const profiles = require('../src/main/terminals/shell-profiles');
const { resolveWindowsClaude, cmdEscapePasses } = require('../claude-binary');

const NAMES = ['smithy hardening', `it's "quoted"`, 'a\\', 'C:\\dir\\', 'say "hi\\"', '$HOME `id` $(id) ${x} %PATH% !x ^y',
  'a&b|c>d<e (f) ; g', '--dangerously-skip-permissions', '-n', 'cafe\u0301 \u{1F600}', "'; touch pwned; '", '"; touch pwned; "'];
const posix = ['/bin/bash', '/bin/sh'].filter(shell => process.platform !== 'win32' && fs.existsSync(shell));

const strip = command => command.replace(/^'cd' '[^']*' && /, '');
const argvOf = (shellPath, command, cwd, fn = 'claude') => {
  const ran = spawnSync(shellPath, ['-c', `${fn}() { printf '%s\\0' "$@"; }; ${strip(command)}`], { encoding: 'utf8', cwd, env: { PATH: process.env.PATH } });
  assert.equal(ran.status, 0, ran.stderr);
  return ran.stdout.split('\0').slice(0, -1);
};
const tmp = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-name-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

for (const shellPath of posix) {
  for (const name of NAMES) {
    test(`${shellPath} parses the launch command of ${JSON.stringify(name)} into the exact argv`, async t => {
      const cwd = tmp(t);
      const spawned = await launch(shellPath, { name });
      assert.deepEqual(argvOf(shellPath, spawned.args.at(-1), cwd), ['--session-id', ID, '--name', name]);
      assert.equal(fs.existsSync(path.join(cwd, 'pwned')), false);
    });
  }
  const existing = [
    ['an unnamed fresh launch', { isNew: true, options: { addDirs: 'C:\\space dir\\', appendSystemPrompt: `it's "x" a\\` } },
      ['--session-id', ID, '--add-dir', 'C:\\space dir\\', '--append-system-prompt', `it's "x" a\\`]],
    ['a resume', { isNew: false, transcript: true, options: { addDirs: 'C:\\space dir\\', appendSystemPrompt: 'two  spaces & $x' } },
      ['--resume', ID, '--add-dir', 'C:\\space dir\\', '--append-system-prompt', 'two  spaces & $x']],
    ['a fork', { isNew: true, options: { forkFrom: 'src id', permissionMode: 'plan' } },
      ['--resume', 'src id', '--fork-session', '--permission-mode', 'plan']],
    ['a prefixed resume', { isNew: false, transcript: true, options: { preLaunchCmd: 'FOO=1', addDirs: 'C:\\space dir\\', appendSystemPrompt: 'safe$(printf MUTATED) `id` it\'s' } },
      ['--resume', ID, '--add-dir', 'C:\\space dir\\', '--append-system-prompt', 'safe$(printf MUTATED) `id` it\'s']],
    ['a prefixed fork', { isNew: true, options: { preLaunchCmd: 'FOO=1', forkFrom: 'src id', appendSystemPrompt: 'a; echo pwned', addDirs: '/a b' } },
      ['--resume', 'src id', '--fork-session', '--add-dir', '/a b', '--append-system-prompt', 'a; echo pwned']],
    ['a fresh launch with a worktree', { isNew: true, git: true, options: { worktree: true, worktreeName: 'topic$SUFFIX' } },
      ['--session-id', ID, '--worktree', 'topic$SUFFIX']],
    ['a fork with a worktree', { isNew: true, git: true, options: { forkFrom: 'src', worktree: true, worktreeName: 'a b`id`' } },
      ['--resume', 'src', '--fork-session', '--worktree', 'a b`id`']],
  ];
  for (const [label, request, expected] of existing) {
    test(`${shellPath} parses ${label} with its existing options into the exact argv`, async t => {
      const spawned = await launch(shellPath, request);
      assert.deepEqual(argvOf(shellPath, spawned.args.at(-1), tmp(t)), expected);
    });
  }
}

const sandboxIt = process.platform === 'linux' && posix.length ? test : test.skip;
sandboxIt('a sandbox launch passes the name to the sandbox script after the script path', async t => {
  const triggers = tmp(t);
  process.env.SWITCHBOARD_TRIGGERS_DIR = triggers;
  t.after(() => { delete process.env.SWITCHBOARD_TRIGGERS_DIR; });
  const spawned = await launch('/bin/bash', { name: 'it\'s "x"', options: { sandbox: true } });
  assert.deepEqual(argvOf('/bin/bash', spawned.args[3], tmp(t), 'bash'), ['/opt/switchboard/claude-sandbox.sh', '--session-id', ID, '--name', 'it\'s "x"']);
});
const prefixIt = posix.length ? test : test.skip;
prefixIt('a launch prefix wraps the quoted name unchanged', async t => {
  const spawned = await launch('/bin/bash', { name: 'a b$(id)', options: { preLaunchCmd: 'FOO=1' } });
  assert.match(strip(spawned.args[3]), /^FOO=1 claude /);
  assert.deepEqual(argvOf('/bin/bash', spawned.args[3], tmp(t)), ['--session-id', ID, '--name', 'a b$(id)']);
});

const q = (shell, name) => profiles.quoteArgvForShell(shell, ['--name', name]);
test('POSIX encodings are single-quoted with embedded quotes closed and reopened', () => {
  assert.equal(q('/bin/zsh', `it's "quoted"`), `'--name' 'it'\\''s "quoted"'`);
  assert.equal(q('/bin/bash', 'a\\'), `'--name' 'a\\'`);
  assert.equal(q('/bin/bash', '$HOME `id`'), `'--name' '$HOME \`id\`'`);
});
const fishCases = [
  ['a\\', `'a\\\\'`], [`it's \\'`, `'it'\\''s \\\\'\\'''`], ['C:\\dir\\file', `'C:\\\\dir\\\\file'`],
  ['a\\\\b', `'a\\\\\\\\b'`], ['\\\\server\\share\\x', `'\\\\\\\\server\\\\share\\\\x'`], ['x\\', `'x\\\\'`],
];
for (const [name, expected] of fishCases) {
  test(`fish encoding of ${JSON.stringify(name)} escapes every backslash`, () => {
    assert.equal(q('/usr/bin/fish', name), `'--name' ${expected}`);
  });
}
const nuCases = [
  ['it\'s', '"it\'s"'], ['a\\', '"a\\\\"'], ['say "hi"', '"say \\"hi\\""'], ['a; echo marker', '"a; echo marker"'],
  ['$x (y) `z`', '"$x (y) `z`"'], ['--name', '"--name"'], ['C:\\dir\\file', '"C:\\\\dir\\\\file"'],
];
for (const [name, expected] of nuCases) {
  test(`nushell encoding of ${JSON.stringify(name)} is one escaped double-quoted string`, () => {
    assert.equal(q('/usr/bin/nu', name), `"--name" ${expected}`);
  });
}
const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
const psq = (argv, o = {}) => profiles.quoteArgvForShell(PWSH, argv, { windows: true, ...o });
test('PowerShell on Windows receives the whole argument line as one literal holding CommandLineToArgvW tokens', () => {
  assert.equal(psq(['--name', 'smithy hardening']), `'"--name" "smithy hardening"'`);
  assert.equal(psq(['--name', 'say "hi"']), `'"--name" "say \\"hi\\""'`);
  assert.equal(psq(['--name', 'a" b']), `'"--name" "a\\" b"'`);
  assert.equal(psq(['--name', 'a\\']), `'"--name" "a\\\\"'`);
  assert.equal(psq(['--name', 'say "hi\\"']), `'"--name" "say \\"hi\\\\\\""'`);
  assert.equal(psq(['--name', '']), `'"--name" ""'`);
  assert.equal(psq(['--name', "it's \u2019x\u2019"]), `'"--name" "it''s \u2019\u2019x\u2019\u2019"'`);
  assert.equal(psq(['--name', '$env:PATH `x` ; & %PATH%']), `'"--name" "$env:PATH \`x\` ; & %PATH%"'`);
});
test('PowerShell on Windows escapes the line twice when the claude it resolves is a .cmd shim', t => {
  claudeOnDisk(t, 'C:\\bin\\claude.cmd');
  assert.equal(psq(['a b', 'c"d'], { env: { PATH: 'C:\\bin' } }), `'^^^"a^^^ b^^^" ^^^"c\\^^^"d^^^"'`);
  assert.equal(psq(['a b'], { env: { PATH: 'C:\\bin' }, wrapped: true }), `'"a b"'`);
  assert.equal(psq(['a b'], { env: { PATH: 'C:\\none' } }), `'"a b"'`);
});
test('PowerShell on Windows keeps one literal per token behind a launch prefix', () => {
  assert.equal(psq(['--name', 'say "hi"'], { wrapped: true }), `'"--name"' '"say \\"hi\\""'`);
});
test('PowerShell off Windows keeps plain single-quoted tokens and no preamble', () => {
  assert.equal(profiles.quoteArgvForShell(PWSH, ['--name', `it's "x"`], { windows: false }), `'--name' 'it''s "x"'`);
  assert.deepEqual(profiles.shellArgs(PWSH, 'claude x', [], { windows: false }), ['-NoLogo', '-Command', 'claude x']);
});
test('the PowerShell launch defines the claude function ahead of the command', async () => {
  for (const shell of ['pwsh.exe', 'powershell.exe']) {
    const spawned = await launch(shell, { name: `say "hi"` });
    const [flag, mode, command] = spawned.args;
    assert.deepEqual([flag, mode], ['-NoLogo', '-Command']);
    assert.ok(command.startsWith("$PSNativeCommandArgumentPassing='Legacy';function claude{param([string]$l)"), command);
    assert.ok(command.endsWith(`exit $p.ExitCode};claude '"--session-id" "${ID}" "--name" "say \\"hi\\""'`), command);
  }
});
test('a launch prefix runs the bare claude with one literal per token', async () => {
  const spawned = await launch('pwsh.exe', { name: 'a b', options: { preLaunchCmd: 'wrap.exe' } });
  assert.ok(spawned.args[2].endsWith(`;wrap.exe claude '"--session-id"' '"${ID}"' '"--name"' '"a b"'`), spawned.args[2]);
});

function commandLineToArgv(line) {
  const argv = []; let i = 0;
  while (i < line.length) {
    while (line[i] === ' ') i++;
    if (i >= line.length) break;
    let cur = ''; let inQuotes = false;
    while (i < line.length && (inQuotes || line[i] !== ' ')) {
      let bs = 0;
      while (line[i] === '\\') { bs++; i++; }
      if (line[i] === '"') {
        cur += '\\'.repeat(bs >> 1);
        if (bs & 1) cur += '"'; else inQuotes = !inQuotes;
        i++;
      } else cur += '\\'.repeat(bs) + (i < line.length ? line[i++] : '');
    }
    argv.push(cur);
  }
  return argv;
}
const MODEL_INPUTS = ['smithy hardening', 'say "hi"', 'a" b', 'a\\', 'C:\\dir\\', 'a\\b c', 'say "hi\\"', '\\"', 'a b\\\\', '', "it's",
  '$env:PATH', '`x`', 'a;b', 'a&b', '%PATH%', 'cafe\u0301 \u{1F600}', '"', '""', ' "a" "b" ', 'it\u2019s'];
test('the argument line handed to the claude function decodes to the exact argv', async () => {
  for (const name of MODEL_INPUTS.filter(Boolean)) {
    const spawned = await launch('pwsh.exe', { name });
    const literal = /claude '((?:[^']|'')*)'$/.exec(spawned.args[2])[1].replace(/''/g, "'").replace(/\u2019\u2019/g, '\u2019');
    assert.deepEqual(commandLineToArgv(literal), ['--session-id', ID, '--name', name], JSON.stringify(name));
  }
});
const cmdCases = [
  ['smithy hardening', '^"smithy^ hardening^"'],
  [`it's "quoted"`, '^"it\'s^ \\^"quoted\\^"^"'],
  ['a\\', '^"a\\\\^"'],
  ['C:\\dir\\', '^"C:\\dir\\\\^"'],
  ['say "hi\\"', '^"say^ \\^"hi\\\\\\^"^"'],
  ['$HOME `id` %PATH% !x ^y', '^"$HOME^ ^`id^`^ ^%PATH^%^ ^!x^ ^^y^"'],
  ['a&b|c>d<e (f)', '^"a^&b^|c^>d^<e^ ^(f^)^"'],
];
for (const [name, expected] of cmdCases) {
  test(`cmd.exe encoding of ${JSON.stringify(name)} leaves no unescaped metacharacter`, () => {
    assert.equal(profiles.quoteArgForShell('cmd.exe', name), expected);
  });
}
test('the cmd.exe launch hands node-pty one command line and PowerShell an argument list', async () => {
  const cmd = await launch('cmd.exe', { name: 'a&b' });
  assert.equal(cmd.args, `/s /c "claude ^"--session-id^" ^"${ID}^" ^"--name^" ^"a^&b^""`);
  const pwsh = await launch('pwsh.exe', { name: "it's" });
  assert.deepEqual(pwsh.args.slice(0, 2), ['-NoLogo', '-Command']);
  assert.ok(pwsh.args[2].endsWith(`claude '"--session-id" "${ID}" "--name" "it''s"'`), pwsh.args[2]);
});
test('the cmd.exe launch does not disable the Command Processor AutoRun commands', async () => {
  const cmd = await launch('cmd.exe', { isNew: false, transcript: true });
  assert.doesNotMatch(cmd.args, /(^|\s)\/d(\s|$)/i);
  assert.match(cmd.args, /^\/s \/c "claude /);
});
const exists = (...files) => file => files.includes(file);
test('cmd escaping depth follows the command cmd will execute', () => {
  const env = { PATH: 'C:\\bin' };
  assert.equal(cmdEscapePasses(env, { exists: exists('C:\\bin\\claude.cmd') }), 2);
  assert.equal(cmdEscapePasses(env, { exists: exists('C:\\bin\\claude.bat') }), 2);
  assert.equal(cmdEscapePasses(env, { exists: exists('C:\\bin\\claude.exe') }), 1);
  assert.equal(cmdEscapePasses({ PATH: 'C:\\none' }, { exists: exists('C:\\bin\\claude.exe') }), 1);
  assert.equal(cmdEscapePasses(env, { cwd: 'C:\\project', exists: exists('C:\\project\\claude.exe', 'C:\\bin\\claude.cmd') }), 1);
  assert.equal(cmdEscapePasses(env, { cwd: 'C:\\project', exists: exists('C:\\project\\claude.cmd', 'C:\\bin\\claude.exe') }), 2);
  assert.equal(cmdEscapePasses(env, { cwd: 'C:\\project', exists: exists('C:\\bin\\claude.cmd') }), 2);
  assert.equal(cmdEscapePasses({ PATH: 'C:\\bin', PATHEXT: '.CMD;.EXE' }, { exists: exists('C:\\bin\\claude.exe', 'C:\\bin\\claude.cmd') }), 2);
  assert.equal(cmdEscapePasses(env, { exists: exists('C:\\bin\\claude.exe', 'C:\\bin\\claude.cmd') }), 1);
});
test('a launch prefix, which parses the arguments first, is escaped once', () => {
  assert.equal(cmdEscapePasses({ PATH: 'C:\\bin' }, { wrapped: true, exists: exists('C:\\bin\\claude.cmd') }), 1);
});
test('quoteArgvForShell applies the resolved depth to cmd.exe only', () => {
  const env = { PATH: 'C:\\none' };
  assert.equal(profiles.quoteArgvForShell('cmd.exe', ['a b'], { env }), '^"a^ b^"');
  assert.equal(profiles.quoteArgvForShell('/bin/bash', ['a b'], { env }), "'a b'");
});
function claudeOnDisk(t, ...files) {
  const original = fs.existsSync;
  t.mock.method(fs, 'existsSync', file => files.includes(file) || original(file));
}
test('the cmd.exe launch picks its escaping depth from the command cmd runs in the launch directory', async t => {
  const env = { PATH: 'C:\\bin' }; const cwd = path.win32.join(process.cwd(), 'claude.exe');
  claudeOnDisk(t, 'C:\\bin\\claude.cmd');
  assert.match((await launch('cmd.exe', { name: 'a b', env })).args, /\^\^\^"--name\^\^\^" \^\^\^"a\^\^\^ b\^\^\^"/);
  claudeOnDisk(t, 'C:\\bin\\claude.cmd', cwd);
  assert.match((await launch('cmd.exe', { name: 'a b', env })).args, / \^"--name\^" \^"a\^ b\^"/);
});
test('a launch prefix keeps the single escaping depth under cmd.exe', async t => {
  claudeOnDisk(t, 'C:\\bin\\claude.cmd');
  const spawned = await launch('cmd.exe', { name: 'a b', env: { PATH: 'C:\\bin' }, options: { preLaunchCmd: 'FOO=1' } });
  assert.match(spawned.args, /^\/s \/c "FOO=1 claude \^"--session-id\^"/);
});
test('a prefix of only whitespace is not a wrapper and is not prepended', async t => {
  claudeOnDisk(t, 'C:\\bin\\claude.cmd');
  const spawned = await launch('cmd.exe', { name: 'a b', env: { PATH: 'C:\\bin' }, options: { preLaunchCmd: '   ' } });
  assert.match(spawned.args, /^\/s \/c "claude \^\^\^"--session-id\^\^\^"/);
});
test('a wrapped cmd.exe resume and fork escape every existing option once', async () => {
  const env = { PATH: 'C:\\none' };
  const resume = await launch('cmd.exe', { isNew: false, transcript: true, env, options: { preLaunchCmd: 'wrapper.exe',
    addDirs: 'C:\\space dir\\', appendSystemPrompt: 'safe & echo MUTATED' } });
  assert.equal(resume.args, `/s /c "wrapper.exe claude ^"--resume^" ^"${ID}^" ^"--add-dir^" ^"C:\\space^ dir\\\\^" ^"--append-system-prompt^" ^"safe^ ^&^ echo^ MUTATED^""`);
  const fork = await launch('cmd.exe', { isNew: true, env, options: { preLaunchCmd: 'wrapper.exe', forkFrom: 'src id', appendSystemPrompt: 'a|b %PATH%', addDirs: 'C:\\x' } });
  assert.equal(fork.args, '/s /c "wrapper.exe claude ^"--resume^" ^"src^ id^" ^"--fork-session^" ^"--add-dir^" ^"C:\\x^" ^"--append-system-prompt^" ^"a^|b^ ^%PATH^%^""');
});
test('WSL receives the POSIX encoding through the distribution shell', async () => {
  const wsl = await launch('wsl.exe', { name: "it's" });
  assert.deepEqual(wsl.args.slice(2), ['--', 'bash', '-l', '-i', '-c', `claude '--session-id' '${ID}' '--name' 'it'\\''s'`]);
});

const files = new Set();
const deps = (found, shim) => ({ exists: file => files.has(file) || file === found, readFile: () => shim });
const env = { PATH: 'C:\\bin', PATHEXT: '.EXE;.CMD' };
const argv = ['--session-id', ID, '--name', 'say "hi" & %PATH%\\'];
test('a native Windows executable receives the name as one untouched argument', () => {
  const plan = resolveWindowsClaude(argv, env, { exists: file => file === 'C:\\bin\\claude.exe' });
  assert.deepEqual(plan, { program: 'C:\\bin\\claude.exe', args: argv, verbatim: false });
});
test('a recognized npm JavaScript shim runs node with the script and the untouched argument', () => {
  const shim = '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js"';
  files.clear(); files.add('C:\\bin\\node_modules\\@anthropic-ai\\claude-code\\cli.js'); files.add('C:\\bin\\node.exe');
  const plan = resolveWindowsClaude(argv, env, deps('C:\\bin\\claude.cmd', shim));
  assert.deepEqual(plan, { program: 'C:\\bin\\node.exe', args: ['C:\\bin\\node_modules\\@anthropic-ai\\claude-code\\cli.js', ...argv], verbatim: false });
});
test('a recognized npm executable shim runs the executable with the untouched argument', () => {
  const shim = '"%dp0%\\node_modules\\claude\\claude.exe"';
  files.clear(); files.add('C:\\bin\\node_modules\\claude\\claude.exe');
  const plan = resolveWindowsClaude(argv, env, deps('C:\\bin\\claude.cmd', shim));
  assert.deepEqual(plan, { program: 'C:\\bin\\node_modules\\claude\\claude.exe', args: argv, verbatim: false });
});
test('an opaque command shim gets a doubly caret-escaped command line with doubled trailing backslashes', () => {
  files.clear();
  const plan = resolveWindowsClaude(['--name', 'a&b\\'], { ...env, ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, deps('C:\\bin\\claude.cmd', 'opaque'));
  assert.equal(plan.program, 'C:\\Windows\\System32\\cmd.exe'); assert.equal(plan.verbatim, true);
  assert.deepEqual(plan.args, ['/d', '/s', '/c', '"^^^"C:\\bin\\claude.cmd^^^" ^^^"--name^^^" ^^^"a^^^&b\\\\^^^""']);
});
