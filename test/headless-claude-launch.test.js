'use strict';

// see .ai/contexts/schedule-runner.md ("Windows launches")
const test = require('node:test');
const assert = require('node:assert/strict');
const { headlessClaudeLaunch } = require('../src/main/terminals/shell-profiles');

const NPM = 'C:\\Users\\u\\AppData\\Roaming\\npm';
const SHIM = '@ECHO off\r\nSET dp0=%~dp0\r\n"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n';
const deps = files => ({ exists: p => Object.prototype.hasOwnProperty.call(files, p), readFile: p => files[p] });
const ARGV = ['--resume', 'id', '--append-system-prompt', 'say "hi" a" b\\'];

for (const shell of ['C:\\WINDOWS\\system32\\cmd.exe', 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe']) {
  test(`on Windows a schedule under ${shell.split('\\').pop()} starts a claude.exe directly, with the argv untouched`, () => {
    const launch = headlessClaudeLaunch(shell, ARGV, { env: { PATH: 'C:\\bin;C:\\tools' }, windows: true, deps: deps({ 'C:\\tools\\claude.exe': '' }) });
    assert.deepEqual(launch, { program: 'C:\\tools\\claude.exe', args: ARGV, verbatim: false });
  });
  test(`on Windows a schedule under ${shell.split('\\').pop()} unwraps an npm claude.cmd shim into node and its cli.js`, () => {
    const files = { [`${NPM}\\claude.cmd`]: SHIM, [`${NPM}\\claude.ps1`]: '', [`${NPM}\\claude`]: '#!/bin/sh',
      [`${NPM}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`]: '', 'C:\\node\\node.exe': '' };
    const launch = headlessClaudeLaunch(shell, ARGV, { env: { PATH: `${NPM};C:\\node` }, windows: true, deps: deps(files) });
    assert.deepEqual(launch, { program: 'C:\\node\\node.exe', args: [`${NPM}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`, ...ARGV], verbatim: false });
  });
  test(`on Windows a schedule under ${shell.split('\\').pop()} reports a missing claude instead of starting the shell`, () => {
    assert.deepEqual(headlessClaudeLaunch(shell, ARGV, { env: { PATH: 'C:\\bin' }, windows: true, deps: deps({}) }), { error: 'claude was not found on PATH' });
  });
}

test('on Windows a bash profile still runs claude through the login shell with POSIX quoting', () => {
  const launch = headlessClaudeLaunch('C:\\Program Files\\Git\\bin\\bash.exe', ARGV, { env: { PATH: 'C:\\bin' }, windows: true, deps: deps({ 'C:\\bin\\claude.exe': '' }) });
  assert.deepEqual(launch, { program: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['-l', '-i', '-c', `claude '--resume' 'id' '--append-system-prompt' 'say "hi" a" b\\'`], verbatim: false });
});

test('on Windows a WSL profile keeps its distribution arguments and the shell', () => {
  const launch = headlessClaudeLaunch('wsl.exe', ['--resume', 'id'], { env: {}, profileArgs: ['-d', 'Ubuntu'], windows: true, deps: deps({}) });
  assert.deepEqual(launch, { program: 'wsl.exe', args: ['-d', 'Ubuntu', '--', 'bash', '-l', '-i', '-c', `claude '--resume' 'id'`], verbatim: false });
});

test('off Windows every profile runs claude through its shell', () => {
  for (const [shell, args] of [['/bin/zsh', ['-l', '-i', '-c', `claude '--resume' 'id'`]], ['/usr/bin/fish', ['-l', '-c', `claude '--resume' 'id'`]],
    ['/usr/bin/pwsh', ['-NoLogo', '-Command', `claude '--resume' 'id'`]]]) {
    assert.deepEqual(headlessClaudeLaunch(shell, ['--resume', 'id'], { env: {}, windows: false, deps: deps({}) }), { program: shell, args, verbatim: false });
  }
});
