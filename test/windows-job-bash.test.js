'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createWindowsJobHelper } = require('../src/main/terminals/windows-job-helper');

const bash = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git/bin/bash.exe');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate, ms) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await delay(25);
  }
  return true;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

test('closing a Git bash job ends its detached Node child without preventing its launch', {
  skip: process.platform !== 'win32' ? 'Windows job APIs only' : !fs.existsSync(bash) && 'Git for Windows is required',
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-job-bash-'));
  const record = path.join(dir, 'pids.json');
  const launcher = path.join(dir, 'launcher.cjs');
  fs.writeFileSync(launcher, `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 45000)'], { detached: true, windowsHide: true, stdio: 'ignore' });
child.once('error', error => fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ parent: process.pid, error: error.message })));
child.once('spawn', () => fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ parent: process.pid, child: child.pid })));
setTimeout(() => {}, 45000);
`);
  let helperProcess, root, owned;
  const keepAlive = setInterval(() => {}, 1000);
  const helper = createWindowsJobHelper({ spawn(program, args, options) {
    helperProcess = spawn(program, args, options);
    return helperProcess;
  } });
  try {
    assert.equal(await helper.start(), true, 'native helper must start');
    const quote = value => "'" + value.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'";
    root = spawn(bash, ['--noprofile', '--norc', '-c',
      `read -r gate; ${quote(process.execPath)} ${quote(launcher)}; read -r end`],
    { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    root.stderr.on('data', data => { stderr += data; });
    assert.equal(await helper.assign('bash', root.pid, Date.now()), true, 'bash must join before launching children');
    root.stdin.write('go\n');
    assert.equal(await waitFor(() => fs.existsSync(record) || root.exitCode !== null, 10000), true, 'bash must complete the spawn');
    assert.equal(fs.existsSync(record), true, stderr);
    owned = JSON.parse(fs.readFileSync(record, 'utf8'));
    assert.equal(owned.error, undefined, 'denying breakaway must not prevent Git bash from launching Node');
    assert.equal(alive(owned.child), true, 'the detached child must really be running before close');
    assert.equal(await helper.terminate('bash'), true, 'protected-aware termination must succeed');
    assert.equal(await waitFor(() => !alive(owned.child), 3000), true,
      'Git bash detached child must exit when its tab job is terminated (#1015)');
    assert.equal(alive(owned.parent), false, 'the launcher must remain in the tab job too');
  } finally {
    await helper.release('bash');
    if (!owned && fs.existsSync(record)) owned = JSON.parse(fs.readFileSync(record, 'utf8'));
    for (const pid of [owned?.child, owned?.parent]) {
      if (Number.isInteger(pid) && alive(pid)) process.kill(pid);
    }
    if (root && root.exitCode === null) root.kill();
    helperProcess?.stdin.end();
    if (helperProcess) await waitFor(() => helperProcess.exitCode !== null, 5000).then(ended => { if (!ended) helperProcess.kill(); });
    clearInterval(keepAlive);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
