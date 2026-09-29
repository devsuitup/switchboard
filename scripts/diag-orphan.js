'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { runToExit } = require('../run-to-exit');

function realGitChildOf(pid) {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { "$($_.ProcessId) $($_.ExecutablePath)" }`],
  { encoding: 'utf8' }).trim();
  const line = out.split('\n').find((l) => /git\.exe/i.test(l));
  return line ? Number(line.split(' ')[0]) : null;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function waitGone(pid) {
  const t0 = process.hrtime.bigint();
  while (alive(pid)) { /* spin */ }
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'diag-orphan-')));
execFileSync('git', ['init', '-q'], { cwd: repo });
execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: repo });
fs.writeFileSync(path.join(repo, 'big.txt'), 'x'.repeat(64 * 1024 * 1024));
execFileSync('git', ['add', 'big.txt'], { cwd: repo });

function execFileCase(label, args, opts) {
  return new Promise((resolve) => {
    let real = null;
    const child = execFile('git', args, { cwd: repo, windowsHide: true, ...opts }, (err) => {
      const at = alive(real);
      const ms = at ? waitGone(real).toFixed(1) : '0';
      let rm = 'ok';
      try { fs.rmdirSync(repo); } catch (e) { rm = e.code; }
      console.log(`${label}: err=${err && (err.code || err.signal)} launcher=${child.pid} real=${real} real-alive-at-callback=${at} real-gone-after=${ms}ms rmdir-at-callback=${rm}`);
      resolve();
    });
    setTimeout(() => { real = realGitChildOf(child.pid); }, 50);
  });
}

(async () => {
  for (let i = 0; i < 5; i++) await execFileCase(`execFile timeout #${i}`, ['cat-file', '--batch'], { timeout: 2000 });
  for (let i = 0; i < 5; i++) await execFileCase(`execFile maxBuffer #${i}`, ['cat-file', 'blob', ':big.txt'], { maxBuffer: 1024, encoding: 'buffer' });
  for (let i = 0; i < 5; i++) {
    const r = await runToExit('git', ['cat-file', 'blob', ':big.txt'], { cwd: repo, env: process.env, timeoutMs: 10000, maxBuffer: 1024 });
    let rm = 'ok';
    try { fs.rmdirSync(repo); } catch (e) { rm = e.code; }
    console.log(`runToExit maxBuffer #${i}: overflow=${r.overflow} rmdir-at-settle=${rm}`);
  }
})();
