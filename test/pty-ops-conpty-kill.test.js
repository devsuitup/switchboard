// see .ai/contexts/ipc-bridge.md
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { stageNodePty } = require('./pty-ops-conpty-stage');

const HEAP_CORRUPTION = 3221226356; // 0xc0000374

const CHILD = `
const pty = require(process.env.NODE_PTY_DIR);
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
  const src = path.dirname(require.resolve('node-pty/package.json'));
  const staged = stageNodePty(os.tmpdir(), src);
  return spawnSync(process.execPath, ['-e', CHILD], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PTY_OPS: path.join(__dirname, '..', 'pty-ops.js'), NODE_PTY_DIR: staged.nodePty, ...extraEnv },
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
