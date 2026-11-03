'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { createWindowsJobHelper } = require('../../src/main/terminals/windows-job-helper');
const gate = process.env.FIXTURE_GATE;
const file = process.env.FIXTURE_PIDS;
async function run() {
  if (process.argv[2] === 'root') {
    const deadline = Date.now() + 60000;
    while (!fs.existsSync(gate) && Date.now() < deadline) await delay(25);
    if (!fs.existsSync(gate)) throw new Error('root gate expired');
    const child = spawn(process.execPath, [path.join(__dirname, 'pty-detached-parent.cjs'), file],
      { stdio: 'ignore', windowsHide: true });
    child.unref();
    while (!fs.existsSync(process.env.FIXTURE_EXPIRY_GATE) && Date.now() < deadline) await delay(25);
    await delay(1000);
    return;
  }
  const keepAlive = setInterval(() => {}, 1000);
  const helper = createWindowsJobHelper({ warn: console.error });
  if (!await helper.start()) throw new Error('parent helper startup failed');
  const spawnTime = Date.now();
  const root = spawn(process.execPath, [__filename, 'root'], { detached: true, stdio: 'ignore', windowsHide: true });
  root.unref();
  if (!await helper.assign('parent-exit', root.pid, spawnTime)) throw new Error('parent root assignment failed');
  fs.writeFileSync(gate, 'go');
  const deadline = Date.now() + 30000;
  while (!fs.existsSync(file) && Date.now() < deadline) await delay(25);
  if (!fs.existsSync(file)) throw new Error('parent root did not publish PIDs');
  fs.writeFileSync(`${file}.parent`, JSON.stringify({ rootPid: root.pid }));
  clearInterval(keepAlive);
  process.exit(0);
}
run().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
