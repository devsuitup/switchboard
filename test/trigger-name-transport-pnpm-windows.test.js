'use strict';

// platform: windows
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const profiles = require('../src/main/terminals/shell-profiles');
const { writeNpmClaude } = require('./fixtures/npm-claude.cjs');

const win = process.platform === 'win32';
const shells = ['powershell.exe', 'pwsh.exe'];
const multiline = ['--append-system-prompt', 'first line\nsecond line', '--name', 'after'];
const cases = [
  ['a pnpm layout with a multiline prompt', multiline, { shim: 'pnpm' }, false],
  ['a pnpm layout with a 12000-character prompt', ['--append-system-prompt', 'x'.repeat(12000), '--name', 'after'], { shim: 'pnpm' }, false],
  ['an unrecognised claude.cmd beside claude.ps1 with a multiline prompt', multiline, { shim: 'opaque' }, true],
  ['a claude.cmd whose node line carries a --require option, beside claude.ps1', multiline, { shim: 'options' }, true],
];

test('the headless resolver unwraps a pnpm shim, which spells its target with %~dp0', { skip: !win && 'requires Windows' }, () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb pnpm plan ')));
  try {
    writeNpmClaude(root, { bundled: true, shim: 'pnpm' });
    const plan = profiles.headlessClaudeLaunch('powershell.exe', multiline, { env: { PATH: root }, windows: true });
    assert.deepEqual(plan.args, [path.join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'), ...multiline]);
    assert.equal(plan.program, path.join(root, 'node.exe'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the headless resolver keeps a %~dp0 shim whose node line carries a --require option, so the bootstrap runs', { skip: !win && 'requires Windows' }, () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb options plan ')));
  try {
    writeNpmClaude(root, { shim: 'options' });
    const output = path.join(root, 'argv.json');
    const argv = ['--name', 'review'];
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^path$/i.test(key)));
    Object.assign(env, { PATH: `${root};${path.dirname(process.execPath)};${process.env.PATH || process.env.Path}`, SB_ARGV_OUT: output });
    const plan = profiles.headlessClaudeLaunch('powershell.exe', argv, { env, windows: true });
    assert.equal(plan.error, undefined, plan.error);
    const ran = spawnSync(plan.program, plan.args, { env, windowsVerbatimArguments: plan.verbatim, encoding: 'utf8', timeout: 30000 });
    assert.equal(fs.existsSync(output + '.setup'), true, `the shim's --require bootstrap must run; status=${ran.status}; stderr=${ran.stderr}`);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), argv);
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(plan.verbatim, true, 'a shim with interpreter options is not unwrapped');
    assert.match(path.basename(plan.program), /^cmd\.exe$/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const shell of shells) {
  const available = win && (shell === 'powershell.exe' || (process.env.PATH || process.env.Path || '').split(';').some(dir => fs.existsSync(path.join(dir, shell))));
  for (const [label, argv, layout, viaScript] of cases) {
    test(`${shell} launches ${label} with exact argv and without the batch shim`, { skip: !win ? 'requires Windows' : !available && `${shell} is not installed` }, t => {
      t.diagnostic('preparing fixture');
      const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb pnpm argv ')));
      try {
        writeNpmClaude(root, layout);
        t.diagnostic('fixture ready');
        const output = path.join(root, 'argv.json');
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^path$/i.test(key)));
        Object.assign(env, { PATH: `${root};${path.dirname(process.execPath)};${process.env.PATH || process.env.Path}`, SB_ARGV_OUT: output });
        const command = profiles.claudeCommand(shell, argv, { env, windows: true });
        const args = profiles.shellArgs(shell, command, [], { pty: true, windows: true });
        const { argsToCommandLine } = require('node-pty/lib/windowsPtyAgent');
        const line = argsToCommandLine(shell, args);
        const rest = line.slice(argsToCommandLine(shell, []).length + 1);
        const ran = spawnSync(shell, [rest], { env, windowsVerbatimArguments: true, encoding: 'utf8', timeout: 120000 });
        const observed = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : null;
        assert.deepEqual(observed, argv, `exact argv; status=${ran.status}; stderr=${ran.stderr}`);
        assert.equal(ran.status, 0, ran.stderr);
        assert.equal(fs.existsSync(output + '.cmd'), false, 'the batch shim must not run');
        assert.equal(fs.existsSync(output + '.ps1'), viaScript, viaScript ? 'an unrecognised shim leaves the claude.ps1 to PowerShell' : 'a recognised shim is bypassed with its claude.ps1');
        if (layout.shim === 'options') assert.equal(fs.existsSync(output + '.setup'), true, "the shim's --require bootstrap must run");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
