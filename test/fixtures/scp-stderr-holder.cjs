'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');

if (process.argv[2] === '--holder') {
  setTimeout(() => {}, 15000);
} else {
  const [pidFile, ...args] = process.argv.slice(2);
  fs.writeFileSync(args.at(-1), args.includes('-O') ? 'complete' : 'partial');
  if (!args.includes('-O')) {
    const holder = spawn(process.execPath, [__filename, '--holder'], {
      windowsHide: true, detached: process.platform === 'win32', stdio: ['ignore', 'ignore', 'inherit'],
    });
    fs.writeFileSync(pidFile, JSON.stringify([process.pid, holder.pid]));
    holder.on('exit', () => process.exit(0));
  }
}
