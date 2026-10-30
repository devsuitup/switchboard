'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

async function stopProcessTree(pid, { isCurrent = () => true,
  spawnChild = spawn, platform = process.platform, signalGroup = process.kill } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || !isCurrent()) return false;
  if (platform !== 'win32') {
    try { signalGroup(-pid, 'SIGKILL'); return true; } catch { return false; }
  }
  return new Promise(resolve => {
    try {
      const child = spawnChild(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true, timeout: 2000,
      });
      child.once('error', () => resolve(false));
      child.once('close', code => resolve(code === 0));
    } catch { resolve(false); }
  });
}

module.exports = { stopProcessTree };
