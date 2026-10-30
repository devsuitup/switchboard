'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');

const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
  windowsHide: true,
  detached: false,
  stdio: 'ignore',
});
child.once('error', () => process.exit(1));
child.once('spawn', () => {
  try {
    fs.writeFileSync(`${process.argv[2]}.tmp`, JSON.stringify({ rootPid: process.pid, grandchildPid: child.pid }));
    fs.renameSync(`${process.argv[2]}.tmp`, process.argv[2]);
  } catch (error) {
    child.kill();
    throw error;
  }
});
setTimeout(() => { child.kill(); process.exit(0); }, 30000);
