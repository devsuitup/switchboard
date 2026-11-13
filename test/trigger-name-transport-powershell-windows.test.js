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
const profiles = require('../src/main/terminals/shell-profiles');

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
const PROBE_CS = `using System;
class P { static int Main(string[] a) {
  Console.CancelKeyPress += (sender, e) => { e.Cancel = true; Console.WriteLine("CTRLC"); Environment.Exit(130); };
  Console.WriteLine("ATTACHED=" + (!Console.IsInputRedirected && !Console.IsOutputRedirected));
  Console.WriteLine("READY");
  string line = Console.ReadLine();
  Console.WriteLine("ECHOED=" + line);
  return int.Parse(Environment.GetEnvironmentVariable("SB_EXIT"));
} }`;
const ECHO_JS = 'require("fs").writeFileSync(process.env.SB_ARGV_OUT, JSON.stringify(process.argv.slice(2)));';
const WRAPPER_CS = `using System; using System.Diagnostics; using System.Text;
class W {
  static string Q(string a) {
    if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\\t', '"' }) < 0) return a;
    var b = new StringBuilder("\\""); int bs = 0;
    foreach (char c in a) {
      if (c == '\\\\') bs++;
      else if (c == '"') { b.Append('\\\\', bs * 2 + 1); b.Append('"'); bs = 0; }
      else { b.Append('\\\\', bs); bs = 0; b.Append(c); }
    }
    b.Append('\\\\', bs * 2); b.Append('"'); return b.ToString();
  }
  static int Main(string[] a) {
    var rest = new StringBuilder();
    for (int i = 1; i < a.Length; i++) { if (i > 1) rest.Append(' '); rest.Append(Q(a[i])); }
    var p = Process.Start(new ProcessStartInfo(a[0], rest.ToString()) { UseShellExecute = false });
    p.WaitForExit(); return p.ExitCode;
  }
}`;
const RECORD = suffix => `[IO.File]::WriteAllText($env:SB_ARGV_OUT + '.${suffix}', (ConvertTo-Json -Compress -InputObject @($args)))`;

const bins = {};
function compile(dir, source, exe) {
  fs.writeFileSync(path.join(dir, exe + '.cs'), source);
  const built = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath $env:SB_CS) -OutputType ConsoleApplication -OutputAssembly $env:SB_EXE'],
  { encoding: 'utf8', env: { ...process.env, SB_CS: path.join(dir, exe + '.cs'), SB_EXE: path.join(dir, exe + '.exe') } });
  assert.equal(built.status, 0, built.stderr + built.stdout);
}
function makeBin(kind) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `sb-ps-argv-${kind}-`)));
  if (kind === 'exe') compile(dir, CS, 'claude');
  if (kind === 'pty') compile(dir, PROBE_CS, 'claude');
  if (kind === 'wrapper') compile(dir, WRAPPER_CS, 'wrapper');
  if (kind === 'wrapcmd') fs.writeFileSync(path.join(dir, 'wrap.cmd'), '@echo off\r\n%*\r\n');
  if (kind === 'cmd' || kind === 'ps1cmd') {
    fs.writeFileSync(path.join(dir, 'echo.js'), ECHO_JS);
    fs.writeFileSync(path.join(dir, 'claude.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0echo.js" %*\r\n`);
  }
  if (kind === 'ps1' || kind === 'ps1cmd') fs.writeFileSync(path.join(dir, 'claude.ps1'), RECORD('ps1') + '\r\n');
  return dir;
}
const KINDS = ['exe', 'cmd', 'ps1', 'ps1cmd', 'pty', 'wrapper', 'wrapcmd'];
const present = exe => win && spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { encoding: 'utf8' }).status === 0;
const shells = [['powershell.exe', win], ['pwsh.exe', present('pwsh.exe')]];
before(() => { if (!skip) for (const kind of KINDS) bins[kind] = makeBin(kind); });
after(() => { for (const dir of Object.values(bins)) fs.rmSync(dir, { recursive: true, force: true }); });

const envFor = (kinds, extra = {}) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^path$/i.test(key)));
  return { ...env, PATH: `${kinds.map(k => bins[k]).join(';')};${process.env.PATH ?? process.env.Path}`,
    SB_ARGV_OUT: path.join(bins[kinds[0]], 'argv.json'), ...extra };
};
const cleanOutputs = kind => { for (const name of ['argv.json', 'argv.json.ps1', 'argv.json.fn']) fs.rmSync(path.join(bins[kind], name), { force: true }); };
function runPlan(shell, args, env, mutate = a => a) {
  const { argsToCommandLine } = require('node-pty/lib/windowsPtyAgent');
  const line = argsToCommandLine(shell, mutate(args));
  const rest = line.slice(argsToCommandLine(shell, []).length + 1);
  const ran = spawnSync(shell, [rest], { windowsVerbatimArguments: true, encoding: 'utf8', env });
  assert.equal(ran.status, 0, `${line}\n${ran.stdout}${ran.stderr}`);
}
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const outputOf = (kind, ext = '') => path.join(bins[kind], 'argv.json' + ext);

async function run(shell, kind, request) {
  cleanOutputs(kind);
  const env = envFor([kind]);
  const spawned = await launch(shell, { ...request, env });
  runPlan(shell, spawned.args, env);
  if (kind.startsWith('ps1')) {
    assert.equal(fs.existsSync(outputOf(kind)), false, 'the claude.cmd ran although claude.ps1 comes first');
    return read(outputOf(kind, '.ps1'));
  }
  return read(outputOf(kind));
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
  ['a launch with IDE emulation', { isNew: true, options: { mcpEmulation: true } }, ['--session-id', ID, '--ide']],
];
const DIRECT = ['--x', '', 'a b', 'a" b', 'a\\', 'say "hi"', '\\"', "it's", '$env:PATH', '%PATH%', 'a;b&c', ' "a" "b" ', 'a b\\\\'];

for (const [shell, available] of shells) {
  const options = { skip: skip || (!available && `${shell} is not installed`), timeout: 90000 };
  for (const kind of ['exe', 'cmd', 'ps1', 'ps1cmd']) {
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
  for (const kind of ['exe', 'cmd']) {
    test(`${shell} hands a claude (${kind}) quotes, backslashes and an empty argument exactly`, options, async () => {
      cleanOutputs(kind);
      const env = envFor([kind]);
      const cmd = profiles.claudeCommand(shell, DIRECT, { env, windows: true });
      runPlan(shell, profiles.shellArgs(shell, cmd, [], { pty: true, windows: true }), env);
      assert.deepEqual(read(outputOf(kind)), DIRECT);
    });
  }
  test(`${shell} runs a profile function named claude as itself and hands it the plain tokens`, options, async () => {
    cleanOutputs('exe');
    const env = envFor(['exe']);
    const spawned = await launch(shell, { name: 'say "hi" a" b', env });
    runPlan(shell, spawned.args, env, args => [args[0], args[1], `function claude { ${RECORD('fn')} }; ${args[2]}`]);
    assert.equal(fs.existsSync(outputOf('exe')), false, 'claude.exe ran although a function named claude exists');
    assert.deepEqual(read(outputOf('exe', '.fn')), ['--session-id', ID, '--name', 'say "hi" a" b']);
  });
  const wrapper = () => path.join(bins.wrapper, 'wrapper.exe');
  for (const name of ['smithy hardening', 'say "hi"', 'a" b', 'a b" c', 'a\\', 'C:\\dir\\', 'a b\\\\', 'say "hi\\"', '"', '""', 'x"&echo pwned', '%PATH% $env:PATH']) {
    test(`${shell} gives a native launch prefix the exact name ${JSON.stringify(name)}`, options, async () => {
      cleanOutputs('exe');
      const env = envFor(['exe', 'wrapper']);
      const spawned = await launch(shell, { name, env, options: { preLaunchCmd: wrapper() } });
      runPlan(shell, spawned.args, env);
      assert.deepEqual(read(outputOf('exe')), ['--session-id', ID, '--name', name]);
    });
  }
  test(`${shell} gives a native launch prefix an empty argument and every awkward argument exactly`, options, async () => {
    cleanOutputs('exe');
    const env = envFor(['exe', 'wrapper']);
    const cmd = profiles.claudeCommand(shell, DIRECT, { env, windows: true, prefix: wrapper() });
    runPlan(shell, profiles.shellArgs(shell, cmd, [], { pty: true, windows: true }), env);
    assert.deepEqual(read(outputOf('exe')), DIRECT);
  });
  test(`${shell} gives a native launch prefix its resume and fork options exactly`, options, async () => {
    for (const [, request, expected] of EXISTING.slice(1, 3)) {
      cleanOutputs('exe');
      const env = envFor(['exe', 'wrapper']);
      const spawned = await launch(shell, { ...request, env, options: { ...request.options, preLaunchCmd: wrapper() } });
      runPlan(shell, spawned.args, env);
      assert.deepEqual(read(outputOf('exe')), expected);
    }
  });

  const batch = () => path.join(bins.wrapcmd, 'wrap.cmd');
  for (const spelling of ['wrap', 'wrap.cmd', 'absolute']) {
    test(`${shell} gives a batch launch prefix spelled ${spelling} awkward arguments and an empty argument exactly`, options, async () => {
      cleanOutputs('exe');
      const env = envFor(['exe', 'wrapcmd']);
      const argv = ['--x', '', 'a" b', '%PATH%', '^', '&', 'a\\', 'a b\\', 'say "hi"', '$env:PATH', "it's"];
      const cmd = profiles.claudeCommand(shell, argv, { env, windows: true, prefix: spelling === 'absolute' ? batch() : spelling });
      runPlan(shell, profiles.shellArgs(shell, cmd, [], { pty: true, windows: true }), env);
      assert.deepEqual(read(outputOf('exe')), argv);
    });
  }
  test(`${shell} runs a 20000 character existing argument without exceeding the command line limit`, options, async () => {
    cleanOutputs('exe');
    const env = envFor(['exe']);
    const prompt = 'long "prompt" \\ '.repeat(1200).slice(0, 20000);
    const spawned = await launch(shell, { isNew: false, transcript: true, env, options: { appendSystemPrompt: prompt } });
    runPlan(shell, spawned.args, env);
    assert.deepEqual(read(outputOf('exe')), ['--resume', ID, '--append-system-prompt', prompt]);
  });

  test(`${shell} keeps the console, standard input and exit status of claude under a pseudo console`, options, async () => {
    const env = envFor(['pty'], { SB_EXIT: '37' });
    const spawned = await launch(shell, { name: 'say "hi"', env });
    const term = require('node-pty').spawn(shell, spawned.args, { name: 'xterm-256color', cols: 100, rows: 30, cwd: process.cwd(), env });
    let output = '';
    const plain = () => output.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '').replace(/\r/g, '');
    const exited = new Promise(resolve => term.onExit(resolve));
    term.onData(chunk => { output += chunk; });
    const until = async (done, label) => {
      for (let waited = 0; !done(); waited += 100) {
        if (waited > 45000) { term.kill(); assert.fail(`${label}; output so far: ${JSON.stringify(plain())}`); }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    };
    await until(() => plain().includes('READY'), 'claude never reported ready');
    term.write('round-trip\r');
    const { exitCode } = await Promise.race([exited, until(() => false, 'claude never exited')]);
    assert.match(plain(), /ATTACHED=True/);
    assert.match(plain(), /ECHOED=round-trip/);
    assert.equal(exitCode, 37);
  });

  test(`${shell} delivers Ctrl+C under a pseudo console to claude through the helper`, options, async () => {
    const env = envFor(['pty'], { SB_EXIT: '0' });
    const spawned = await launch(shell, { name: 'a b', env });
    const term = require('node-pty').spawn(shell, spawned.args, { name: 'xterm-256color', cols: 100, rows: 30, cwd: process.cwd(), env });
    let output = '';
    const exited = new Promise(resolve => term.onExit(resolve));
    term.onData(chunk => { output += chunk; });
    const wait = async (done, label) => {
      for (let waited = 0; !done(); waited += 100) {
        if (waited > 45000) { term.kill(); assert.fail(`${label}; output so far: ${JSON.stringify(output)}`); }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    };
    await wait(() => output.includes('READY'), 'claude never reported ready');
    term.write('\x03');
    await wait(() => output.includes('CTRLC'), 'claude never saw Ctrl+C');
    await Promise.race([exited, wait(() => false, 'the terminal never closed')]);
  });
}
