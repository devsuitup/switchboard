'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { runToExit } = require('../run-to-exit');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-rte-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function node(script, opts = {}) {
  let child = null;
  const spawnFn = (file, args, options) => {
    child = spawn(file, args, options);
    return child;
  };
  const promise = runToExit(process.execPath, ['-e', script], { cwd: opts.cwd || process.cwd(), env: process.env, timeoutMs: opts.timeoutMs || 10_000, maxBuffer: opts.maxBuffer || 1024 * 1024 }, spawnFn);
  return { promise, child: () => child };
}

test('runToExit: a child that overruns the stdout cap is left to finish, and the call settles only once it has exited', async () => {
  const tmp = mkTmp();
  try {
    const marker = path.join(tmp, 'finished');
    const script = `process.stdout.write('x'.repeat(8192), () => setTimeout(() => { require('fs').writeFileSync(${JSON.stringify(marker)}, 'done'); }, 300));`;
    const run = node(script, { maxBuffer: 1024 });
    const result = await run.promise;
    assert.equal(result.overflow, true);
    assert.equal(result.code, -1);
    assert.equal(result.message, 'stdout maxBuffer length exceeded');
    assert.equal(result.stdout.length, 1024, 'what fits under the cap is kept, the rest is drained and dropped');
    assert.ok(fs.existsSync(marker), 'the child ran to its own end instead of being killed by the cap');
    assert.notEqual(run.child().exitCode, null, 'the child has exited by the time the call settles');
  } finally { cleanup(tmp); }
});

test('runToExit: a timeout kills the child and settles only after it has exited', async () => {
  const run = node('setInterval(() => {}, 1000);', { timeoutMs: 200 });
  const result = await run.promise;
  assert.equal(result.timedOut, true);
  assert.equal(result.code, -1);
  const child = run.child();
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'the killed child has exited by the time the call settles');
});

test('runToExit: a spawn that never ran settles with code -1 and the spawn error', async () => {
  const result = await runToExit(process.execPath, ['-e', ''], { cwd: path.join(os.tmpdir(), 'switchboard-rte-missing-dir-does-not-exist'), env: process.env, timeoutMs: 10_000, maxBuffer: 1024 });
  assert.equal(result.code, -1);
  assert.match(result.message, /ENOENT/);
});

test('runToExit: a clean exit returns stdout and stderr with code 0', async () => {
  const result = await node("process.stdout.write('out'); process.stderr.write('warn');").promise;
  assert.equal(result.code, 0);
  assert.equal(result.stdout.toString('utf8'), 'out');
  assert.equal(result.stderr, 'warn');
  assert.equal(result.overflow, false);
  assert.equal(result.message, '');
});

test('runToExit: a non-zero exit keeps its code and stderr', async () => {
  const result = await node("process.stderr.write('fatal: nope'); process.exitCode = 3;").promise;
  assert.equal(result.code, 3);
  assert.equal(result.stderr, 'fatal: nope');
  assert.match(result.message, /^Command failed: /);
});
