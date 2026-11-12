'use strict';

// Establishes argv and launch-plan construction through injected boundaries (the extracted
// open-terminal handler, the real shell encoders, an injected PTY edge). It is not a live shell
// or Claude Code qualification.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fixture, ID } = require('./fixtures/trigger-main-open.cjs');
const profiles = require('../src/main/terminals/shell-profiles');
const { validatePreLaunchCmd } = require('../src/main/terminals/pre-launch-cmd-guard');
const { resolveWindowsClaude } = require('../claude-binary');

const NAMES = ['smithy hardening', `it's "quoted"`, 'a\\', 'C:\\dir\\', 'say "hi\\"', '$HOME `id` $(id) ${x} %PATH% !x ^y',
  'a&b|c>d<e (f) ; g', '--dangerously-skip-permissions', '-n', 'cafe\u0301 \u{1F600}', "'; touch pwned; '", '"; touch pwned; "'];

function launch(shellPath, name, options = {}) {
  const f = fixture({ resolveShell: () => ({ path: shellPath }), quoteArgvForShell: profiles.quoteArgvForShell,
    shellArgs: profiles.shellArgs, isWslShell: profiles.isWslShell, windowsToWslPath: profiles.windowsToWslPath, os, validatePreLaunchCmd,
    sandboxScriptPath: () => '/opt/switchboard/claude-sandbox.sh', sandboxBindEnv: () => null,
    parseAddDirs: value => String(value || '').split(',').map(dir => dir.trim()).filter(Boolean) });
  f.permit.mode = 'new'; f.permit.requestedSessionId = null; f.permit.name = name; f.authorize();
  return f.open('permit', true, options).then(result => { assert.equal(result.ok, true, JSON.stringify(result)); return f.spawns[0]; });
}
const posixArgv = (shellPath, script, cwd) => {
  const ran = spawnSync(shellPath, ['-c', script], { encoding: 'utf8', cwd, env: { PATH: process.env.PATH } });
  assert.equal(ran.status, 0, ran.stderr);
  return ran.stdout.split('\0').slice(0, -1);
};

for (const shellPath of ['/bin/bash', '/bin/sh']) {
  for (const name of NAMES) {
    test(`${shellPath} parses the launch command of ${JSON.stringify(name)} into the exact argv`, async t => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-name-'));
      t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
      const spawned = await launch(shellPath, name);
      const command = spawned.args[spawned.args.length - 1];
      const argv = posixArgv(shellPath, `claude() { printf '%s\\0' "$@"; }; ${command.replace(/^'cd' '[^']*' && /, '')}`, cwd);
      assert.deepEqual(argv, ['--session-id', ID, '--name', name]);
      assert.equal(fs.existsSync(path.join(cwd, 'pwned')), false);
    });
  }
}

test('a sandbox launch passes the name to the sandbox script after the script path', async t => {
  const triggers = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-triggers-'));
  process.env.SWITCHBOARD_TRIGGERS_DIR = triggers;
  t.after(() => { delete process.env.SWITCHBOARD_TRIGGERS_DIR; fs.rmSync(triggers, { recursive: true, force: true }); });
  const spawned = await launch('/bin/bash', 'it\'s "x"', { sandbox: true });
  const command = spawned.args[3].replace(/^'cd' '[^']*' && /, '');
  const argv = posixArgv('/bin/bash', `bash() { printf '%s\\0' "$@"; }; ${command}`);
  assert.deepEqual(argv, ['/opt/switchboard/claude-sandbox.sh', '--session-id', ID, '--name', 'it\'s "x"']);
});
test('a launch prefix wraps the quoted name unchanged', async () => {
  const spawned = await launch('/bin/bash', 'a b$(id)', { preLaunchCmd: 'FOO=1' });
  const command = spawned.args[3].replace(/^'cd' '[^']*' && /, '');
  assert.match(command, /^FOO=1 claude /);
  const argv = posixArgv('/bin/bash', `claude() { printf '%s\\0' "$@"; }; ${command}`);
  assert.deepEqual(argv, ['--session-id', ID, '--name', 'a b$(id)']);
});

const q = (shell, name) => profiles.quoteArgvForShell(shell, ['--name', name]);
test('POSIX encodings are single-quoted with embedded quotes closed and reopened', () => {
  assert.equal(q('/bin/zsh', `it's "quoted"`), `'--name' 'it'\\''s "quoted"'`);
  assert.equal(q('/bin/bash', 'a\\'), `'--name' 'a\\'`);
  assert.equal(q('/bin/bash', '$HOME `id`'), `'--name' '$HOME \`id\`'`);
});
test('fish encoding escapes backslashes inside single quotes', () => {
  assert.equal(q('/usr/bin/fish', 'a\\'), `'--name' 'a\\\\'`);
  assert.equal(q('/usr/bin/fish', `it's \\'`), `'--name' 'it'\\''s \\\\'\\'''`);
});
test('PowerShell encoding doubles single quotes inside a single-quoted string', () => {
  assert.equal(q('C:\\Program Files\\PowerShell\\7\\pwsh.exe', `it's "x" & $y`), `'--name' 'it''s "x" & $y'`);
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
    assert.equal(profiles.quoteArgForShell('C:\\Windows\\System32\\cmd.exe', name), expected);
  });
}
test('the cmd.exe and PowerShell launch commands carry the name through the injected PTY', async () => {
  const cmd = await launch('C:\\Windows\\System32\\cmd.exe', 'a&b');
  assert.deepEqual(cmd.args, ['/C', `claude ^"--session-id^" ^"${ID}^" ^"--name^" ^"a^&b^"`]);
  const pwsh = await launch('C:\\Program Files\\PowerShell\\7\\pwsh.exe', "it's");
  assert.deepEqual(pwsh.args, ['-NoLogo', '-Command', `claude '--session-id' '${ID}' '--name' 'it''s'`]);
});
test('WSL receives the POSIX encoding through the distribution shell', async () => {
  const wsl = await launch('wsl.exe', "it's");
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
