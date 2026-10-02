// test/pty-ops-conpty-kill.test.js — the real node-pty + bundled conpty.dll, in a child process.
// A second ClosePseudoConsole on the same handle corrupts the heap (0xc0000374) and takes the
// process down; the child is the only place that can be observed. see .ai/contexts/ipc-bridge.md
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

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

// The packaged app finds conpty.dll beside the conpty.node it loads (scripts/after-pack.js
// copies prebuilds/win32-<arch>/conpty/ there). A source-built node_modules has no such
// folder in build/Release, so the child loads a temp copy that has only the prebuilds.
function stageNodePty() {
  const src = path.dirname(require.resolve('node-pty/package.json'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-nodepty-'));
  const dst = path.join(dir, 'node-pty');
  const prebuild = path.join('prebuilds', `${process.platform}-${process.arch}`);
  fs.cpSync(path.join(src, 'lib'), path.join(dst, 'lib'), { recursive: true });
  fs.cpSync(path.join(src, prebuild), path.join(dst, prebuild), { recursive: true });
  fs.copyFileSync(path.join(src, 'package.json'), path.join(dst, 'package.json'));
  return { dir, nodePty: dst };
}

function runChild(extraEnv) {
  const staged = stageNodePty();
  try {
    return spawnSync(process.execPath, ['-e', CHILD], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, PTY_OPS: path.join(__dirname, '..', 'pty-ops.js'), NODE_PTY_DIR: staged.nodePty, ...extraEnv },
      timeout: 30000,
      encoding: 'utf8',
    });
  } finally {
    // OpenConsole.exe may still hold the copy open for a moment; the temp dir is disposable.
    try { fs.rmSync(staged.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {}
  }
}

test('killing a conpty-dll pty twice back to back does not corrupt the heap',
  { skip: process.platform !== 'win32' ? 'ConptyClosePseudoConsole exists only on Windows' : false },
  () => {
    const r = runChild({});
    assert.notEqual(r.status, HEAP_CORRUPTION, 'child died of STATUS_HEAP_CORRUPTION');
    assert.equal(r.status, 0, `child stderr: ${r.stderr}`);
  });
