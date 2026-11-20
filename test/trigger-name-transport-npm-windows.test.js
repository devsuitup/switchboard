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
const cases = [
  ['a real npm layout with bundled Node', ['--name', 'say "hi"', '', 'C:\\space dir\\'], { bundled: true }],
  ['a multiline prompt with PATH Node', ['--append-system-prompt', 'first line\nsecond line', '--name', 'after'], {}],
  ['a 12000-character prompt', ['--append-system-prompt', 'x'.repeat(12000), '--name', 'after'], {}],
  ['a native npm target', ['-e', 'require("fs").writeFileSync(process.env.SB_ARGV_OUT,JSON.stringify(process.argv.slice(1)))', '--', 'first line\nsecond line', 'after'], { native: true }],
];

test('the headless resolver selects the npm invocation after its bundled Node probe', { skip: !win && 'requires Windows' }, () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb npm plan ')));
  try {
    writeNpmClaude(root, { bundled: true });
    const argv = ['--append-system-prompt', 'first line\nsecond line'];
    const plan = profiles.headlessClaudeLaunch('powershell.exe', argv, { env: { PATH: root }, windows: true });
    assert.deepEqual(plan.args, [path.join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'), ...argv]);
    assert.equal(plan.program, path.join(root, 'node.exe'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const shell of shells) {
  const available = win && (shell === 'powershell.exe' || (process.env.PATH || process.env.Path || '').split(';').some(dir => fs.existsSync(path.join(dir, shell))));
  for (const [label, argv, layout] of cases) {
    test(`${shell} launches ${label} directly with exact argv`, { skip: !win ? 'requires Windows' : !available && `${shell} is not installed` }, t => {
      t.diagnostic('preparing npm fixture');
      const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb npm argv ')));
      try {
        writeNpmClaude(root, layout);
        t.diagnostic('npm fixture ready');
        const output = path.join(root, 'argv.json');
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^path$/i.test(key)));
        Object.assign(env, { PATH: `${root};${path.dirname(process.execPath)};${process.env.PATH || process.env.Path}`, SB_ARGV_OUT: output });
        const command = profiles.claudeCommand(shell, argv, { env, windows: true });
        const args = profiles.shellArgs(shell, command, [], { pty: true, windows: true });
        const { argsToCommandLine } = require('node-pty/lib/windowsPtyAgent');
        const line = argsToCommandLine(shell, args);
        const rest = line.slice(argsToCommandLine(shell, []).length + 1);
        const ran = spawnSync(shell, [rest], { env, windowsVerbatimArguments: true, encoding: 'utf8', timeout: 30000 });
        const observed = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : null;
        assert.deepEqual(observed, layout.native ? argv.slice(3) : argv, `exact argv; status=${ran.status}; stderr=${ran.stderr}`);
        assert.equal(ran.status, 0, ran.stderr);
        assert.equal(fs.existsSync(output + '.cmd'), false, 'npm batch shim must not run');
        assert.equal(fs.existsSync(output + '.ps1'), false, 'npm PowerShell shim must not run');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
