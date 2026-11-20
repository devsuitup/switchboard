'use strict';

// platform: windows
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveWindowsClaude, SHIM_INVOCATION } = require('../claude-binary');
const profiles = require('../src/main/terminals/shell-profiles');
const { writeNpmClaude, NPM_TRAILERS } = require('./fixtures/npm-claude.cjs');

const win = process.platform === 'win32';
const skip = !win && 'requires Windows';
const TARGET = 'node_modules\\@anthropic-ai\\claude-code\\cli.js';

function withNpmLayout(trailer, run) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb stock npm ')));
  try {
    writeNpmClaude(root, { trailer });
    const output = path.join(root, 'argv.json');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^path$/i.test(key)));
    Object.assign(env, { PATH: `${root};${path.dirname(process.execPath)};${process.env.PATH || process.env.Path}`, SB_ARGV_OUT: output });
    run({ root, output, env });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

for (const trailer of Object.keys(NPM_TRAILERS)) {
  test(`a stock npm shim with the ${trailer} trailer is unwrapped, so a headless multi-line launch runs with exact argv`, { skip }, () => withNpmLayout(trailer, ({ root, output, env }) => {
    const argv = ['--append-system-prompt', 'first line\nsecond line', '--name', 'say "hi"', ''];
    const plan = resolveWindowsClaude(argv, env);
    assert.equal(plan.error, undefined, 'the stock npm shim must not be opaque');
    assert.deepEqual(plan.args, [path.join(root, TARGET), ...argv]);
    const ran = spawnSync(plan.program, plan.args, { env, windowsVerbatimArguments: plan.verbatim, encoding: 'utf8', timeout: 20000 });
    assert.equal(ran.status, 0, ran.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), argv);
    assert.equal(fs.existsSync(output + '.cmd'), false, 'npm batch shim must not run');
  }));

  test(`Windows PowerShell bypasses the npm .ps1 of a stock shim with the ${trailer} trailer and keeps quotes and empty tokens`, { skip }, () => withNpmLayout(trailer, ({ output, env }) => {
    const argv = ['--name', 'say "hi"', '--model', ''];
    const shell = 'powershell.exe';
    const command = profiles.claudeCommand(shell, argv, { env, windows: true });
    const args = profiles.shellArgs(shell, command, [], { pty: true, windows: true });
    const { argsToCommandLine } = require('node-pty/lib/windowsPtyAgent');
    const line = argsToCommandLine(shell, args);
    const ran = spawnSync(shell, [line.slice(argsToCommandLine(shell, []).length + 1)], { env, windowsVerbatimArguments: true, encoding: 'utf8', timeout: 25000 });
    assert.equal(ran.status, 0, ran.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), argv);
    assert.equal(fs.existsSync(output + '.ps1'), false, 'npm PowerShell shim must not run');
    assert.equal(fs.existsSync(output + '.cmd'), false, 'npm batch shim must not run');
  }));
}

test('the PowerShell helper embeds the resolver regex and .NET reads the stock npm lines the same way', { skip }, () => {
  const rows = [
    ...Object.values(NPM_TRAILERS).map(trailer => [`${trailer}"%_prog%"  "%dp0%\\${TARGET}" %*`, TARGET]),
    [`endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set NODE_OPTIONS=--require x & "%_prog%"  "%dp0%\\${TARGET}" %*`, ''],
    [`endLocal & goto #_undefined_# 2>NUL & "%_prog%"  "%dp0%\\${TARGET}" %*`, ''],
    [`"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*`, 'node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'],
  ];
  const cases = rows.flatMap(([text, target]) => ['\n', '\r\n'].map(eol => ({ text: '@ECHO off' + eol + text + eol, target })));
  const helper = profiles.shellArgs('powershell.exe', '__switchboard_launch claude', [], { windows: true })[2];
  assert.ok(helper.includes("'" + SHIM_INVOCATION.source + "','IgnoreCase,Multiline'"), 'the helper carries the resolver regex');
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb stock npm parity ')));
  try {
    const input = path.join(root, 'input.json');
    const output = path.join(root, 'output.json');
    fs.writeFileSync(input, JSON.stringify({ pattern: SHIM_INVOCATION.source, cases }));
    const script = '$d=Get-Content -Raw -LiteralPath $env:SB_INPUT|ConvertFrom-Json;'
      + '$r=@($d.cases|ForEach-Object{$m=[regex]::Match($_.text,$d.pattern,"IgnoreCase,Multiline");$m.Groups[1].Value+$m.Groups[2].Value});'
      + '[IO.File]::WriteAllText($env:SB_OUTPUT,(ConvertTo-Json -Compress -InputObject $r))';
    const ran = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, SB_INPUT: input, SB_OUTPUT: output }, encoding: 'utf8', timeout: 25000 });
    assert.equal(ran.status, 0, ran.stderr);
    const net = JSON.parse(fs.readFileSync(output, 'utf8'));
    cases.forEach((entry, i) => {
      const match = SHIM_INVOCATION.exec(entry.text);
      assert.equal(match ? match[1] || match[2] : '', entry.target, JSON.stringify(entry.text));
      assert.equal(net[i], entry.target, 'in .NET: ' + JSON.stringify(entry.text));
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
