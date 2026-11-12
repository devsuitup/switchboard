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

const skip = process.platform !== 'win32' && 'requires Windows cmd.exe and node-pty command-line serialization';

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

const bins = {};
const SHIMS = { cmd: 'claude.cmd', bat: 'claude.bat' };
function makeBin(kind) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `sb-argv-${kind}-`)));
  if (SHIMS[kind]) {
    fs.writeFileSync(path.join(dir, 'echo.js'), ECHO_JS);
    fs.writeFileSync(path.join(dir, SHIMS[kind]), `@echo off\r\n"${process.execPath}" "%~dp0echo.js" %*\r\n`);
  } else {
    fs.writeFileSync(path.join(dir, 'echo.cs'), CS);
    const built = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath $env:SB_CS) -OutputType ConsoleApplication -OutputAssembly $env:SB_EXE'],
    { encoding: 'utf8', env: { ...process.env, SB_CS: path.join(dir, 'echo.cs'), SB_EXE: path.join(dir, 'claude.exe') } });
    assert.equal(built.status, 0, built.stderr + built.stdout);
  }
  return dir;
}
before(() => { if (!skip) for (const kind of ['exe', 'cmd', 'bat']) bins[kind] = makeBin(kind); });
after(() => { for (const dir of Object.values(bins)) fs.rmSync(dir, { recursive: true, force: true }); });

async function runThroughNodePty(kind, request, { cwdKind } = {}) {
  const out = path.join(bins[kind], 'argv.json');
  fs.rmSync(out, { force: true });
  const env = { ...process.env, PATH: `${bins[kind]};${process.env.PATH}`, SB_ARGV_OUT: out };
  const shell = process.env.ComSpec;
  const original = process.cwd();
  if (cwdKind) process.chdir(bins[cwdKind]);
  try {
    const spawned = await launch(shell, { ...request, env });
    const { argsToCommandLine } = require('node-pty/lib/windowsPtyAgent');
    const line = argsToCommandLine(shell, spawned.args);
    const rest = line.slice(argsToCommandLine(shell, []).length + 1);
    const ran = spawnSync(shell, [rest], { windowsVerbatimArguments: true, encoding: 'utf8', env, cwd: process.cwd() });
    assert.equal(ran.status, 0, `${line}\n${ran.stdout}${ran.stderr}`);
    return JSON.parse(fs.readFileSync(out, 'utf8'));
  } finally { process.chdir(original); }
}

const NAMES = ['smithy hardening', `it's "quoted"`, 'a\\', 'C:\\dir\\', 'say "hi\\"', 'a"', '100%', '%PATH%', 'x^y', '^', 'a&b', 'a|b', 'a<b>c',
  'wow!', '(paren)', 'cafe\u0301 \u{1F600}', '--dangerously-skip-permissions', '-n', 'x"&echo pwned'];
const EXISTING = [
  ['an unnamed fresh launch', { isNew: true, options: { addDirs: 'C:\\space dir\\', appendSystemPrompt: `it's "x" a\\` } },
    ['--session-id', ID, '--add-dir', 'C:\\space dir\\', '--append-system-prompt', `it's "x" a\\`]],
  ['a resume', { isNew: false, transcript: true, options: { addDirs: 'C:\\space dir\\', appendSystemPrompt: 'two  spaces & ^ %PATH% |<>' } },
    ['--resume', ID, '--add-dir', 'C:\\space dir\\', '--append-system-prompt', 'two  spaces & ^ %PATH% |<>']],
  ['a fork', { isNew: true, options: { forkFrom: 'src id', permissionMode: 'plan' } }, ['--resume', 'src id', '--fork-session', '--permission-mode', 'plan']],
  ['a fresh launch with a worktree', { isNew: true, git: true, options: { worktree: true, worktreeName: 'topic$SUFFIX' } },
    ['--session-id', ID, '--worktree', 'topic$SUFFIX']],
  ['a fork with a worktree', { isNew: true, git: true, options: { forkFrom: 'src', worktree: true, worktreeName: 'a b%PATH%^&' } },
    ['--resume', 'src', '--fork-session', '--worktree', 'a b%PATH%^&']],
];

for (const kind of ['exe', 'cmd', 'bat']) {
  for (const name of NAMES) {
    test(`cmd.exe through node-pty hands a claude.${kind} the exact name ${JSON.stringify(name)}`, { skip, timeout: 60000 }, async () => {
      assert.deepEqual(await runThroughNodePty(kind, { name }), ['--session-id', ID, '--name', name]);
    });
  }
  for (const [label, request, expected] of EXISTING) {
    test(`cmd.exe through node-pty hands a claude.${kind} ${label} its exact arguments`, { skip, timeout: 60000 }, async () => {
      assert.deepEqual(await runThroughNodePty(kind, request), expected);
    });
  }
}

const TRICKY = { name: `say "hi" & %PATH% ^ \\`, args: ['--session-id', ID, '--name', `say "hi" & %PATH% ^ \\`] };
for (const [pathKind, cwdKind] of [['cmd', 'exe'], ['bat', 'exe'], ['exe', 'cmd'], ['exe', 'bat']]) {
  test(`a claude.${cwdKind} in the working directory shadows a claude.${pathKind} on PATH and still gets exact arguments`, { skip, timeout: 60000 }, async () => {
    assert.deepEqual(await runThroughNodePty(pathKind, { name: TRICKY.name }, { cwdKind }), TRICKY.args);
  });
}
