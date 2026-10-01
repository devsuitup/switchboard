// test/pty-ops-conpty-kill.test.js — the real node-pty + bundled conpty.dll, in a child process.
// A second ClosePseudoConsole on the same handle corrupts the heap (0xc0000374) and takes the
// process down; the child is the only place that can be observed. see .ai/contexts/ipc-bridge.md
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HEAP_CORRUPTION = 3221226356; // 0xc0000374

const CHILD = `
const pty = require('node-pty');
const { killPty } = require(process.env.PTY_OPS);
const term = pty.spawn(process.env.ComSpec || 'cmd.exe', [], { cols: 80, rows: 24, useConptyDll: true });
term.onData(() => {});
setTimeout(() => {
  const session = { pty: term };
  killPty(session, 's1');
  killPty(session, 's1');
  setTimeout(() => process.exit(0), 1500);
}, 1000);
`;

function runChild(extraEnv) {
  return spawnSync(process.execPath, ['-e', CHILD], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PTY_OPS: path.join(__dirname, '..', 'pty-ops.js'), ...extraEnv },
    timeout: 30000,
    encoding: 'utf8',
  });
}

test('killing a conpty-dll pty twice back to back does not corrupt the heap',
  { skip: process.platform !== 'win32' ? 'ConptyClosePseudoConsole exists only on Windows' : false },
  () => {
    const r = runChild({});
    assert.notEqual(r.status, HEAP_CORRUPTION, 'child died of STATUS_HEAP_CORRUPTION');
    assert.equal(r.status, 0, `child stderr: ${r.stderr}`);
  });
