// see .ai/contexts/ipc-bridge.md
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { stageNodePty } = require('./pty-ops-conpty-stage');

const CHILD = `
const assert = require('node:assert/strict');
const pty = require(process.env.NODE_PTY_DIR);
const { guardPtyInputErrors, killPty } = require(process.env.PTY_OPS);
const term = pty.spawn(process.env.ComSpec || 'cmd.exe', [], { cols: 80, rows: 24, useConptyDll: true });
term.onData(() => {});
const session = { pty: term };
let uncaught = false;
process.once('uncaughtException', error => {
  uncaught = true;
  console.error(error);
  killPty(session, 's1');
  process.exit(1);
});
assert.ok(term._agent?.inSocket, 'real node-pty must expose its input socket immediately after spawn');
const input = term._agent.inSocket;
assert.equal(input.listenerCount('error'), 0);
assert.equal(guardPtyInputErrors(term), term);
assert.equal(input.listenerCount('error'), 1);
setTimeout(() => {
  input.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  setImmediate(() => {
    assert.equal(uncaught, false, 'EPIPE must not reach uncaughtException');
    assert.equal(killPty(session, 's1'), true);
    setTimeout(() => {
      assert.equal(uncaught, false);
      process.exit(0);
    }, 1500);
  });
}, 1000);
`;

function runChild() {
  const src = path.dirname(require.resolve('node-pty/package.json'));
  const staged = stageNodePty(os.tmpdir(), src);
  return spawnSync(process.execPath, ['-e', CHILD], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PTY_OPS: path.join(__dirname, '..', 'pty-ops.js'), NODE_PTY_DIR: staged.nodePty },
    timeout: 30000,
    encoding: 'utf8',
  });
}

test('the real ConPTY input socket receives the guard and absorbs EPIPE without an uncaught exception',
  { skip: process.platform !== 'win32' ? 'ConPTY input sockets exist only on Windows' : false },
  () => {
    const result = runChild();
    assert.ifError(result.error);
    assert.equal(result.status, 0, `child stderr: ${result.stderr}`);
  });
