'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { stageNodePty } = require('./pty-ops-conpty-stage');
const { guardPtyInputErrors, killPty } = require('../pty-ops');

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function until(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (predicate()) return true;
    await delay(50);
  } while (Date.now() < deadline);
  return predicate();
}

test('closing a real ConPTY kills its hidden non-detached grandchild within five seconds',
  { skip: process.platform !== 'win32' && 'Windows ConPTY measurement only' }, async (t) => {
    const src = path.dirname(require.resolve('node-pty/package.json'));
    const staged = stageNodePty(os.tmpdir(), src);
    const nodePty = require(staged.nodePty);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-897-'));
    const pidFile = path.join(dir, 'pids.json');
    let session;
    let ptyKillCalled = false;
    let grandchildPid;
    let output = '';
    try {
      const term = guardPtyInputErrors(nodePty.spawn(process.execPath, [
        path.join(__dirname, 'fixtures', 'pty-hidden-grandchild.cjs'), pidFile,
      ], { cols: 80, rows: 24, cwd: __dirname, env: process.env, useConptyDll: true }));
      session = { pty: term, exited: false };
      const nativeKill = term.kill.bind(term);
      term.kill = () => {
        ptyKillCalled = true;
        return nativeKill();
      };
      term.onData(data => { output += data; });
      term.onExit(() => { session.exited = true; });
      assert.equal(await until(() => fs.existsSync(pidFile), 10000), true,
        `fixture did not publish its own PIDs: ${output}`);
      const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
      grandchildPid = pids.grandchildPid;
      assert.equal(pids.rootPid, term.pid);
      assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 0);
      assert.equal(alive(term.pid), true, 'PTY fixture root must be alive before close');
      assert.equal(alive(grandchildPid), true, 'hidden grandchild must be alive before close');
      const started = Date.now();
      assert.equal(killPty(session, 'fixture-897'), true);
      const died = await until(() => !alive(grandchildPid), 5000);
      t.diagnostic(JSON.stringify({ tmp: os.tmpdir(), rootPid: term.pid, grandchildPid,
        grandchildDied: died, elapsedMs: Date.now() - started, rootExited: session.exited }));
      assert.equal(died, true, `hidden grandchild ${grandchildPid} survived killPty for five seconds`);
    } finally {
      if (!grandchildPid && fs.existsSync(pidFile)) {
        grandchildPid = JSON.parse(fs.readFileSync(pidFile, 'utf8')).grandchildPid;
      }
      if (grandchildPid && alive(grandchildPid)) {
        try { process.kill(grandchildPid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      if (session && !ptyKillCalled) session.pty.kill();
      if (session && !session.exited && alive(session.pty.pid)) {
        try { process.kill(session.pty.pid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      if (grandchildPid) assert.equal(await until(() => !alive(grandchildPid), 5000), true,
        'fixture grandchild cleanup must complete');
      if (session) assert.equal(await until(() => !alive(session.pty.pid), 5000), true,
        'fixture root cleanup must complete');
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries:5, retryDelay:100 });
    }
  });
