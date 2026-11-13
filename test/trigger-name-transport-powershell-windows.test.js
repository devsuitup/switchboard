'use strict';

// platform: windows
// see .ai/contexts/trigger-watcher.md ("Naming a new session")
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { launch, ID } = require('./fixtures/trigger-name-launch.cjs');

const win = process.platform === 'win32';
const skip = !win && 'requires Windows PowerShell and node-pty command-line serialization';

const CS = `using System; using System.IO; using System.Text;
class P { static int Main(string[] a) {
  var b = new StringBuilder("[");
  for (int i = 0; i < a.Length; i++) {
    if (i > 0) b.Append(',');
    b.Append('"');
    foreach (char c in a[i]) { if (c < 32 || c > 126 || c == '"' || c == '\\\\') b.Append("\\\\u" + ((int)c).ToString("x4")); else b.Append(c); }
    b.Append('"');
  }
  b.Append(']');
  File.WriteAllText(Environment.GetEnvironmentVariable("SB_ARGV_OUT"), b.ToString());
  return 0;
} }`;
const ECHO_JS = 'require("fs").writeFileSync(process.env.SB_ARGV_OUT, JSON.stringify(process.argv.slice(2)));';

// the shape npm's cmd-shim generates for a bin script
const PS1_SHIM = `#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent
$ret=0
& "NODE" "$basedir/echo.js" $args
$ret=$LASTEXITCODE
exit $ret
`;
const KINDS = ['exe', 'cmd', 'ps1', 'ps1cmd'];
const bins = {};
function makeBin(kind) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `sb-ps-argv-${kind}-`)));
  if (kind !== 'exe') {
    fs.writeFileSync(path.join(dir, 'echo.js'), ECHO_JS);
    if (kind !== 'cmd') fs.writeFileSync(path.join(dir, 'claude.ps1'), PS1_SHIM.replace('NODE', process.execPath));
  }
  if (kind === 'cmd' || kind === 'ps1cmd') {
    fs.writeFileSync(path.join(dir, 'claude.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0echo.js" %*\r\n`);
  } else if (kind === 'exe') {
    fs.writeFileSync(path.join(dir, 'echo.cs'), CS);
    const built = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath $env:SB_CS) -OutputType ConsoleApplication -OutputAssembly $env:SB_EXE'],
    { encoding: 'utf8', env: { ...process.env, SB_CS: path.join(dir, 'echo.cs'), SB_EXE: path.join(dir, 'claude.exe') } });
    assert.equal(built.status, 0, built.stderr + built.stdout);
  }
  return dir;
}
const present = exe => win && spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { encoding: 'utf8' }).status === 0;
const shells = [['powershell.exe', win], ['pwsh.exe', present('pwsh.exe')]];
before(() => { if (!skip) for (const kind of KINDS) bins[kind] = makeBin(kind); });
after(() => { for (const dir of Object.values(bins)) fs.rmSync(dir, { recursive: true, force: true }); });

async function run(shell, kind, request) {
  const out = path.join(bins[kind], 'argv.json');
  fs.rmSync(out, { force: true });
  const env = { ...process.env, PATH: `${bins[kind]};${process.env.PATH}`, SB_ARGV_OUT: out };
  const spawned = await launch(shell, { ...request, env });
  const { argsToCommandLine } = require('node-pty/lib/windowsPtyAgent');
  const line = argsToCommandLine(shell, spawned.args);
  const rest = line.slice(argsToCommandLine(shell, []).length + 1);
  const ran = spawnSync(shell, [rest], { windowsVerbatimArguments: true, encoding: 'utf8', env });
  assert.equal(ran.status, 0, `${line}\n${ran.stdout}${ran.stderr}`);
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

const NAMES = ['smithy hardening', 'say "hi"', 'a" b', 'a b" c', 'a\\', 'C:\\dir\\', 'a\\b c', 'a b\\\\', 'say "hi\\"', '\\"', '"', '""', ' "a" "b" ', 'a"b',
  "it's", 'it\u2019s \u2018x\u2019', '$env:PATH', '$(whoami)', '`x`', 'a;b', 'a&b', 'a|b', 'a<b>c', '%PATH%', 'x^y', '100%', 'wow!', '(paren)',
  'cafe\u0301 \u{1F600}', '--dangerously-skip-permissions', '-n', 'x"&echo pwned', '"; echo pwned; "'];
const EXISTING = [
  ['an unnamed fresh launch', { isNew: true, options: { addDirs: 'C:\\space dir\\', appendSystemPrompt: `it's "x" a\\` } },
    ['--session-id', ID, '--add-dir', 'C:\\space dir\\', '--append-system-prompt', `it's "x" a\\`]],
  ['a resume', { isNew: false, transcript: true, options: { addDirs: 'C:\\space dir\\', appendSystemPrompt: 'two  spaces & ^ %PATH% |<> $env:PATH `x` ;' } },
    ['--resume', ID, '--add-dir', 'C:\\space dir\\', '--append-system-prompt', 'two  spaces & ^ %PATH% |<> $env:PATH `x` ;']],
  ['a fork', { isNew: true, options: { forkFrom: 'src id', permissionMode: 'plan', appendSystemPrompt: 'say "hi" a" b\\' } },
    ['--resume', 'src id', '--fork-session', '--permission-mode', 'plan', '--append-system-prompt', 'say "hi" a" b\\']],
];

for (const [shell, available] of shells) {
  for (const kind of KINDS) {
    const options = { skip: skip || (!available && `${shell} is not installed`), timeout: 90000 };
    for (const name of NAMES) {
      test(`${shell} hands a claude (${kind}) the exact name ${JSON.stringify(name)}`, options, async () => {
        assert.deepEqual(await run(shell, kind, { name }), ['--session-id', ID, '--name', name]);
      });
    }
    for (const [label, request, expected] of EXISTING) {
      test(`${shell} hands a claude (${kind}) ${label} its exact arguments`, options, async () => {
        assert.deepEqual(await run(shell, kind, request), expected);
      });
    }
  }
}
