'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { guardPtyInputErrors, killPty, trackWindowsPty } = require('../../pty-ops');
const { windowsJobHelper } = require('../../src/main/terminals/windows-job-helper');
const nodePty = require(process.env.NODE_PTY_DIR);
const keepAlive = setInterval(() => {}, 1000);

function observer(pid) {
  let dead = false;
  return () => {
    if (dead) return false;
    try { process.kill(pid, 0); return true; }
    catch (error) {
      if (error.code === 'ESRCH') { dead = true; return false; }
      if (error.code === 'EPERM') return null;
      throw error;
    }
  };
}

async function until(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(50);
  }
  return predicate();
}

async function measure() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-897b-'));
  const pidFile = path.join(dir, 'pids.json');
  let session, grandchildAlive, killCalled = false, output = '';
  try {
    assert.equal(await windowsJobHelper(message => console.error(message)).start(), true, 'resident helper must start');
    const term = guardPtyInputErrors(nodePty.spawn(path.join(process.env.SystemRoot,
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, 'pty-hidden-root.ps1'),
    ], { cols: 80, rows: 24, useConptyDll: true, env: { ...process.env,
      FIXTURE_NODE: process.execPath, FIXTURE_CHILD: path.join(__dirname, 'pty-hidden-grandchild.cjs'),
      FIXTURE_PIDS: pidFile } }));
    session = { pty: term, exited: false, kind: 'local-pty' };
    term.onData(data => { output = (output + data).slice(-4000); });
    term.onExit(() => { session.exited = true; });
    assert.equal(await trackWindowsPty(term), true, 'local root must join its job');
    assert.equal(await until(() => fs.existsSync(pidFile), 10000), true, output);
    const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    assert.equal(pids.rootPid, term.pid, 'non-libuv root must own the hidden child');
    assert.ok(Number.isSafeInteger(pids.grandchildPid) && pids.grandchildPid > 0);
    grandchildAlive = observer(pids.grandchildPid);
    assert.equal(observer(term.pid)(), true);
    assert.equal(grandchildAlive(), true);
    const started = Date.now();
    killCalled = true;
    assert.equal(killPty(session, 'fixture-897b'), true);
    const returnedMs = Date.now() - started;
    const died = await until(() => grandchildAlive() === false, 5000);
    console.log(JSON.stringify({ tmp: os.tmpdir(), ...pids, grandchildDied: died,
      returnedMs, elapsedMs: Date.now() - started, rootExited: session.exited }));
    assert.equal(died, true, `hidden grandchild ${pids.grandchildPid} survived killPty for five seconds`);
  } finally {
    if (session && !killCalled && !session.exited) {
      try { session.pty.kill(); } catch {}
    }
    if (grandchildAlive) await until(() => grandchildAlive() === false, 25000);
    if (session) await until(() => session.exited, 28000);
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

measure().then(() => { clearInterval(keepAlive); process.exit(0); }, error => { console.error(error); process.exit(1); });
