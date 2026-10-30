'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { stageNodePty } = require('./pty-ops-conpty-stage');

test('closing a real ConPTY kills a non-libuv root\'s hidden grandchild within five seconds',
  { skip: process.platform !== 'win32' && 'Windows ConPTY measurement only' }, t => {
    const src = path.dirname(require.resolve('node-pty/package.json'));
    const staged = stageNodePty(os.tmpdir(), src);
    const result = spawnSync(process.execPath, [path.join(__dirname, 'fixtures', 'pty-hidden-measure.cjs')], {
      env: { ...process.env, NODE_PTY_DIR: staged.nodePty },
      timeout: 40000,
      encoding: 'utf8',
    });
    t.diagnostic(result.stdout);
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 0, result.stderr);
  });
