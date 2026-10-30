'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

test('Windows rename replaces a destination after its child-held non-sharing handle is released', {
  skip: process.platform !== 'win32' && 'requires Windows FileShare.None', timeout: 20000,
}, async t => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-atomic-lock-')));
  const src = path.join(dir, 'source.tmp');
  const dest = path.join(dir, 'destination.txt');
  fs.writeFileSync(src, 'replacement');
  fs.writeFileSync(dest, 'original');
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$handle = [System.IO.File]::Open($env:SB_LOCK_DEST, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)',
    'try {',
    '  [Console]::WriteLine("READY")',
    '  if ([Console]::ReadLine() -ne "release") { throw "missing release command" }',
    '  [System.Threading.Thread]::Sleep(5)',
    '} finally { $handle.Dispose() }',
  ].join('\n');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    env: { ...process.env, SB_LOCK_DEST: dest }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end('release\n');
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      const timer = setTimeout(() => child.kill(), 2000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('lock child readiness timeout: ' + stderr)), 10000);
    let output = '';
    child.stdout.on('data', data => {
      output += data;
      if (output.includes('READY')) { clearTimeout(timer); resolve(); }
    });
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`lock child exited ${code}: ${stderr}`)); });
  });
  const { renameWithRetry } = require('../src/main/shared/atomic-write');
  let calls = 0;
  const codes = [];
  assert.doesNotThrow(() => renameWithRetry(src, dest, {
    rename: (from, to) => {
      calls++;
      try { return fs.renameSync(from, to); }
      catch (err) {
        codes.push(err.code);
        if (calls === 1) child.stdin.end('release\n');
        throw err;
      }
    },
  }));
  assert.ok(calls > 1, 'the held handle must cause at least one real rename failure');
  assert.ok(codes.every(code => ['EPERM', 'EACCES', 'EBUSY'].includes(code)));
  assert.equal(fs.readFileSync(dest, 'utf8'), 'replacement');
  assert.equal(fs.existsSync(src), false);
  t.diagnostic(`rename calls=${calls}; sharing errors=${codes.join(',')}`);
  const [code] = await exited;
  assert.equal(code, 0, stderr);
});
