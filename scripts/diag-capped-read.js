'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { readChangesFile } = require('../git-changes-file');

function git(cwd, args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' });
}

function gitProcesses() {
  if (process.platform !== 'win32') return '';
  return execFileSync('powershell', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='git.exe'\" | ForEach-Object { \"$($_.ProcessId) parent=$($_.ParentProcessId) $($_.ExecutablePath) :: $($_.CommandLine)\" }"],
  { encoding: 'utf8' });
}

async function once(i, blobSize) {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'diag-cap-')));
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'a@b.c']);
  git(repo, ['config', 'user.name', 'a']);
  fs.writeFileSync(path.join(repo, 'shrunk.txt'), 'x'.repeat(blobSize));
  git(repo, ['add', 'shrunk.txt']);
  fs.writeFileSync(path.join(repo, 'shrunk.txt'), 'tiny\n');

  const result = await readChangesFile({ cwd: repo, relPath: 'shrunk.txt', staged: false, maxBytes: 1024 });
  let rm = 'ok';
  try { fs.rmdirSync(repo); } catch (err) { rm = err.code; }
  const procs = rm === 'EBUSY' ? gitProcesses() : '';
  let later = '';
  if (rm === 'EBUSY') {
    const t0 = Date.now();
    for (;;) {
      try { fs.rmSync(repo, { recursive: true, force: true }); later = `released after ${Date.now() - t0}ms`; break; } catch (err) {
        if (Date.now() - t0 > 10000) { later = `still ${err.code} after 10s`; break; }
      }
    }
  }
  console.log(`#${i} blob=${blobSize} reason=${result.reason} first-rmdir=${rm} ${later}`);
  if (procs) console.log(procs.trim());
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  return rm;
}

(async () => {
  console.log('git on PATH:', process.platform === 'win32' ? execFileSync('where', ['git'], { encoding: 'utf8' }).trim() : '');
  const counts = {};
  const n = Number(process.argv[2] || 50);
  const blobSize = Number(process.argv[3] || 4096);
  for (let i = 1; i <= n; i++) {
    const rm = await once(i, blobSize);
    counts[rm] = (counts[rm] || 0) + 1;
  }
  console.log('DIAG-RESULT', JSON.stringify(counts));
})();
