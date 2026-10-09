'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function fakeTouchedShell(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-touched-shell-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bash = process.platform === 'win32' ? path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe') : 'bash';
  const pwd = spawnSync(bash, ['-c', 'pwd -P'], { cwd: dir, encoding: 'utf8', timeout: 10000 });
  assertShell(pwd);
  const root = pwd.stdout.trim();
  fs.mkdirSync(path.join(dir, 'bin'));
  let functions = '';
  function tool(name, body) {
    fs.writeFileSync(path.join(dir, 'bin', name), '#!/bin/sh\n' + body + '\n', { mode: 0o755 });
  }
  async function run(_alias, command, options = {}) {
    const result = spawnSync(bash, ['-c', 'export PATH="$PWD/bin:$PATH"; ' + functions + command], {
      cwd: dir, input: options.input, encoding: options.rawStdout ? undefined : 'utf8', timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    return { code: result.status, stdout: result.stdout, stderr: String(result.stderr) };
  }
  return { dir, root, tool, run, setFunctions: body => { functions = body; } };
}

function assertShell(result) {
  if (result.error || result.status !== 0) throw result.error || new Error(String(result.stderr));
}

module.exports = { fakeTouchedShell };
