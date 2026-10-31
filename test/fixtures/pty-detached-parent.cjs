'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const mode = process.env.FIXTURE_MODE;
if (['daemon', 'worker', 'roster', 'stale-roster', 'daemon-eof', 'helper-death', 'helper-timeout', 'pipe-eof', 'lookalike'].includes(mode)) {
  const marker = mode === 'worker' ? ['--bg-pty-host'] : ['roster', 'stale-roster', 'lookalike'].includes(mode) ? ['daemon', 'runner'] : ['daemon', 'run'];
  const daemon = spawn(process.execPath, [process.env.FIXTURE_CLI_ENTRY, ...marker, '--fixture'],
    { detached: true, stdio: 'ignore', windowsHide: true });
  const hidden = spawn(process.execPath, [path.join(__dirname, 'pty-hidden-grandchild.cjs'), `${process.argv[2]}.hidden`],
    { detached: true, stdio: 'ignore', windowsHide: true });
  daemon.unref(); hidden.unref();
  const timer = setInterval(() => {
    const file = process.argv[2];
    if (!fs.existsSync(`${file}.agent`) || !fs.existsSync(`${file}.hidden`)) return;
    clearInterval(timer);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...JSON.parse(fs.readFileSync(`${file}.agent`, 'utf8')),
      intermediatePid: process.pid, grandchildPid: hidden.pid }));
    fs.renameSync(`${file}.tmp`, file);
    process.exit(0);
  }, 20);
  setTimeout(() => process.exit(2), 30000);
} else {
  const child = spawn(process.execPath, [path.join(__dirname, 'pty-hidden-grandchild.cjs'), process.argv[2]],
    { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
  child.unref();
}
