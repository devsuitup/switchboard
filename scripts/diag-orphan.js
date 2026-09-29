'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

function gitProcesses() {
  return execFileSync('powershell', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='git.exe'\" | ForEach-Object { \"$($_.ProcessId) parent=$($_.ParentProcessId) $($_.ExecutablePath) :: $($_.CommandLine)\" }"],
  { encoding: 'utf8' }).trim();
}

const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'diag-orphan-')));
execFileSync('git', ['init', '-q'], { cwd: repo });

const child = execFile('git', ['cat-file', '--batch'], { cwd: repo, timeout: 1000, windowsHide: true }, (err) => {
  console.log(`callback: killed=${err && err.killed} signal=${err && err.signal} wrapper pid=${child.pid} exitCode=${child.exitCode} signalCode=${child.signalCode}`);
  console.log('git.exe processes after the callback:');
  console.log(gitProcesses() || '(none)');
  let rm = 'ok';
  try { fs.rmdirSync(repo); } catch (e) { rm = e.code; }
  console.log(`first rmdir of the repo: ${rm}`);
});
setTimeout(() => {
  console.log('git.exe processes while running:');
  console.log(gitProcesses() || '(none)');
}, 200);
