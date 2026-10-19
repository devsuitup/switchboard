'use strict';

// see .ai/contexts/updater-relaunch.md
async function acquireInstanceLock(app, {
  platform = process.platform, argv = process.argv, now = Date.now,
  delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const retry = platform === 'linux' && argv.includes('--switchboard-relaunch');
  const deadline = now() + 10000;
  do {
    if (app.requestSingleInstanceLock()) return true;
    if (!retry || now() >= deadline) return false;
    await delay(Math.min(200, Math.max(0, deadline - now())));
  } while (true);
}

function readNoNewPrivs({ platform = process.platform, readFileSync = require('node:fs').readFileSync, log = console } = {}) {
  if (platform !== 'linux') return null;
  let value = 'unknown';
  try { value = /^NoNewPrivs:\s*([01])\s*$/m.exec(readFileSync('/proc/self/status', 'utf8'))?.[1] || 'unknown'; } catch {}
  log.info(`[startup] NoNewPrivs=${value}`);
  return value === '1' ? {
    id: 'linux-no-new-privileges', kind: 'error',
    message: 'Links to snap applications and updates will not work until Switchboard is started again from the application menu.',
  } : null;
}

module.exports = { acquireInstanceLock, readNoNewPrivs };
