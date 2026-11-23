'use strict';

// platform: windows
// see .ai/contexts/schedule-runner.md ("Windows launches")
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { extractFunction } = require('./app-source');
const profiles = require('../src/main/terminals/shell-profiles');

const win = process.platform === 'win32';
const skip = !win && 'requires cmd.exe, Windows PowerShell and Windows process creation';
const ROOT = path.join(__dirname, '..');
const ID = '01234567-89ab-cdef-0123-456789abcdef';

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
const NPM_PS1 = [
  '#!/usr/bin/env pwsh', '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent', '',
  '$exe=""', 'if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {', '  $exe=".exe"', '}', '$ret=0',
  '$env:SB_ARGV_OUT="$env:SB_ARGV_OUT.ps1"',
  'if (Test-Path "$basedir/node$exe") {',
  '  if ($MyInvocation.ExpectingInput) {', '    $input | & "$basedir/node$exe"  "$basedir/echo.js" $args',
  '  } else {', '    & "$basedir/node$exe"  "$basedir/echo.js" $args', '  }', '  $ret=$LASTEXITCODE',
  '} else {',
  '  if ($MyInvocation.ExpectingInput) {', '    $input | & "node$exe"  "$basedir/echo.js" $args',
  '  } else {', '    & "node$exe"  "$basedir/echo.js" $args', '  }', '  $ret=$LASTEXITCODE',
  '}', 'exit $ret', ''].join('\r\n');

const bins = {};
function makeBin(kind) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `sb-sched-${kind}-`)));
  if (kind === 'exe') {
    fs.writeFileSync(path.join(dir, 'claude.cs'), CS);
    const built = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath $env:SB_CS) -OutputType ConsoleApplication -OutputAssembly $env:SB_EXE'],
    { encoding: 'utf8', env: { ...process.env, SB_CS: path.join(dir, 'claude.cs'), SB_EXE: path.join(dir, 'claude.exe') } });
    assert.equal(built.status, 0, built.stderr + built.stdout);
  } else {
    fs.writeFileSync(path.join(dir, 'echo.js'), ECHO_JS);
    fs.writeFileSync(path.join(dir, 'claude.cmd'), kind === 'npm'
      ? '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL & "%_prog%"  "%dp0%\\echo.js" %*\r\n'
      : `@ECHO off\r\nSET dp0=%~dp0\r\n"${process.execPath}"  "%dp0%\\echo.js" %*\r\n`);
    if (kind === 'npm') {
      fs.writeFileSync(path.join(dir, 'claude.ps1'), NPM_PS1);
      fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\nexec node "$0.js" "$@"\n');
    }
  }
  return dir;
}
const KINDS = ['exe', 'cmd', 'npm'];
before(() => { if (!skip) for (const kind of KINDS) bins[kind] = makeBin(kind); });
after(() => { for (const dir of Object.values(bins)) fs.rmSync(dir, { recursive: true, force: true }); });

const present = exe => win && spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { encoding: 'utf8' }).status === 0;
const shells = [['powershell.exe', win], ['pwsh.exe', present('pwsh.exe')], [process.env.ComSpec || 'cmd.exe', win]];

function envFor(kind) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^path$/i.test(key)));
  return { ...env, PATH: `${bins[kind]};${path.dirname(process.execPath)};${process.env.PATH ?? process.env.Path}`, SB_ARGV_OUT: path.join(bins[kind], 'argv.json') };
}

async function runSchedule(shell, kind, claudeArgv, customArgs = '') {
  for (const suffix of ['', '.ps1']) fs.rmSync(path.join(bins[kind], 'argv.json' + suffix), { force: true });
  const env = envFor(kind);
  const log = { info() {}, warn() {}, error() {} };
  const ctx = vm.createContext({
    require: createRequire(path.join(ROOT, 'main.js')), fs, path, os, process, Date, setTimeout, clearTimeout,
    DB_PATH: path.join(bins[kind], 'db'), getSetting: () => ({ customArgs }), isProjectSettingsArchived: () => false,
    SETTING_DEFAULTS: { shellProfile: 'test', sandbox: false }, resolveShell: () => ({ path: shell }),
    quoteArgvForShell: profiles.quoteArgvForShell, shellArgs: profiles.shellArgs, headlessClaudeLaunch: profiles.headlessClaudeLaunch,
    cleanPtyEnv: env, resolveScheduleSandbox: () => false,
    scheduleLaunchRefusal: require('../src/main/schedules/schedule-runner').scheduleLaunchRefusal,
    scheduleProjects: () => ({ list: async () => [] }), sandboxScriptPath: () => 'sandbox', sandboxBindEnv: () => '', encodeProjectPath: () => 'project',
    cpSpawn: require('node:child_process').spawn,
    cliSessionState: { trackScheduleRun() {} }, activityReporter: { sessionStarted() {}, sessionEnded() {} },
    scheduleIpc: { reportRunExit() {} }, mainWindow: null, log,
  });
  const source = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8').replace(/^    (async )?function runScheduleCommand/m, '$1function runScheduleCommand');
  vm.runInContext(extractFunction(source, 'runScheduleCommand'), ctx, { filename: path.join(ROOT, 'main.js') });
  let exited;
  const done = new Promise(resolve => { exited = resolve; });
  const started = await ctx.runScheduleCommand(claudeArgv, bins[kind], 'Nightly', exited);
  assert.equal(started.ok, true, started.error);
  await done;
  const viaScript = fs.existsSync(path.join(bins[kind], 'argv.json.ps1'));
  const argv = JSON.parse(fs.readFileSync(path.join(bins[kind], 'argv.json' + (viaScript ? '.ps1' : '')), 'utf8'));
  return { argv, viaScript };
}

const ARGV = ['--resume', ID, '-p', 'Run the scheduled task', '--permission-mode', 'auto', '--allowedTools', 'Bash,Read',
  '--add-dir', 'C:\\space dir\\', '--append-system-prompt', 'say "hi" a" b\\ & %PATH% ^ |<> $env:PATH `x` ;', '--model', ''];

for (const [shell, available] of shells) {
  test(`${shell}: scheduled custom arguments preserve generated argv and shell-quoted values`, { skip: !available || skip }, async () => {
    const generated = ['--resume', ID, '-p', 'Run the scheduled task'];
    const result = await runSchedule(shell, 'npm', generated, '--model "custom model"');
    assert.deepEqual(result.argv, [...generated, '--model', 'custom model']);
  });
}

for (const [shell, available] of shells) {
  const options = { skip: skip || (!available && `${shell} is not installed`), timeout: 90000 };
  for (const kind of KINDS) {
    test(`a schedule under ${path.basename(shell)} hands a claude (${kind}) its exact arguments`, options, async () => {
      const { argv, viaScript } = await runSchedule(shell, kind, ARGV);
      assert.deepEqual(argv, ARGV);
      assert.equal(viaScript, false, 'the npm claude.ps1 forwarded the arguments');
    });
  }
}

test('a schedule under cmd.exe or PowerShell with no claude on PATH is refused with a recovery step', { skip, timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-sched-empty-'));
  try {
    const recorded = [];
    const ctx = vm.createContext({
      require: createRequire(path.join(ROOT, 'main.js')), fs, path, os, process, Date,
      DB_PATH: path.join(dir, 'db'), getSetting: () => ({}), isProjectSettingsArchived: () => false,
      SETTING_DEFAULTS: { shellProfile: 'test', sandbox: false }, resolveShell: () => ({ path: 'powershell.exe' }),
      quoteArgvForShell: profiles.quoteArgvForShell, shellArgs: profiles.shellArgs, headlessClaudeLaunch: profiles.headlessClaudeLaunch,
      cleanPtyEnv: { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, resolveScheduleSandbox: () => false,
      cpSpawn: () => { throw new Error('spawn must not be reached'); },
      cliSessionState: { trackScheduleRun() {} }, activityReporter: { sessionStarted() {}, sessionEnded() {} },
      scheduleIpc: { reportRunExit() {} }, mainWindow: null, log: { info() {}, warn() {}, error: (...args) => recorded.push(args.join(' ')) },
    });
    const source = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8').replace(/^    (async )?function runScheduleCommand/m, '$1function runScheduleCommand');
    vm.runInContext(extractFunction(source, 'runScheduleCommand'), ctx, { filename: path.join(ROOT, 'main.js') });
    let done = 0;
    const result = await ctx.runScheduleCommand(['--resume', ID], dir, 'Nightly', () => { done++; });
    assert.equal(result.ok, false);
    assert.match(result.error, /^Could not start the schedule: claude was not found on PATH\. Check the shell settings/);
    assert.equal(done, 1, 'the completion callback releases the run');
    assert.equal(recorded.length, 1, 'the refusal is logged once');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
