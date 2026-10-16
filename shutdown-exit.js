'use strict';

const { spawn } = require('node:child_process');

// see .ai/contexts/session-index-writer.md
function exitWithWatchdog(app, log) {
  const source = `
    const parent = Number(process.argv[1]);
    process.on('disconnect', () => process.exit(0));
    setTimeout(() => {
      if (process.connected) {
        try { process.kill(parent, 'SIGKILL'); } catch {}
      }
      process.exit(0);
    }, 1000);
    process.send('armed');
  `;
  let timer, completed = false;
  const fail = error => {
    if (completed) return;
    completed = true;
    clearTimeout(timer);
    log.error('[shutdown] exit watchdog failed:', error);
    process.kill(process.pid, 'SIGKILL');
  };
  let guard;
  try {
    guard = spawn(process.execPath, ['-e', source, String(process.pid)], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], detached: true, windowsHide: true,
    });
  } catch (error) { fail(error); return; }
  timer = setTimeout(() => fail(new Error('exit watchdog startup timed out')), 1000);
  guard.unref();
  guard.channel?.unref();
  guard.once('error', fail);
  guard.once('exit', () => fail(new Error('exit watchdog stopped before arming')));
  guard.once('message', message => {
    if (completed || message !== 'armed') return;
    completed = true;
    clearTimeout(timer);
    app.exit();
  });
}

module.exports = { exitWithWatchdog };
