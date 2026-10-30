'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { stageNodePty } = require('./pty-ops-conpty-stage');

for (const mode of ['simultaneous', 'helper-death', 'pipe-eof', 'release', 'shutdown', 'pid-guard', 'detached',
  'daemon', 'worker', 'roster', 'daemon-eof', 'lookalike', 'latencies']) {
  test(`Windows jobs native: ${mode}`, { skip: process.platform !== 'win32' && 'Windows job APIs only' }, t => {
    const staged = stageNodePty(os.tmpdir(), path.dirname(require.resolve('node-pty/package.json')));
    const result = spawnSync(process.execPath, [path.join(__dirname, 'fixtures/pty-job-native.cjs'), mode],
      { timeout: mode === 'latencies' ? 45000 : 25000, encoding: 'utf8', env: { ...process.env, NODE_PTY_DIR: staged.nodePty } });
    t.diagnostic(result.stdout); t.diagnostic(result.stderr);
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`"mode":"${mode}"`), 'fixture must complete its native assertions');
    if (mode === 'latencies') assert.match(result.stdout, /"summary"/);
  });
}
