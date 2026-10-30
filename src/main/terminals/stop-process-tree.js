'use strict';

const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

async function stopProcessTree(pid, { graceMs = 0, isCurrent = () => true,
  spawnChild = spawn, platform = process.platform, signalGroup = process.kill } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || !isCurrent()) return false;
  if (graceMs > 0) await delay(Math.min(graceMs, 1000));
  if (!isCurrent()) return false;
  if (platform !== 'win32') {
    try { signalGroup(-pid, 'SIGKILL'); return true; } catch { return false; }
  }
  return new Promise(resolve => {
    try {
      const child = spawnChild('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true, timeout: 2000,
      });
      child.once('error', () => resolve(false));
      child.once('close', code => resolve(code === 0));
    } catch { resolve(false); }
  });
}

module.exports = { stopProcessTree };
