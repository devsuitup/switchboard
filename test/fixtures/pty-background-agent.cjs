'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const file = process.env.FIXTURE_PIDS;
const child = spawn(process.execPath, [path.join(__dirname, 'pty-hidden-grandchild.cjs'), `${file}.agent-child`],
  { stdio: 'ignore', windowsHide: true });
const timer = setInterval(() => {
  if (!fs.existsSync(`${file}.agent-child`)) return;
  clearInterval(timer);
  fs.writeFileSync(`${file}.agent.tmp`, JSON.stringify({ daemonPid: process.pid, daemonChildPid: child.pid }));
  fs.renameSync(`${file}.agent.tmp`, `${file}.agent`);
}, 20);
setTimeout(() => process.exit(0), Number(process.env.FIXTURE_LIFETIME) || 8000);
