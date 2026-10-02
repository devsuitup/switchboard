'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { spawnSyncRetryingCrash, isNtStatusCrash } = require('./spawn-retry');

function scripted(results) {
  const calls = [];
  const spawn = (...args) => { calls.push(args); return results[Math.min(calls.length - 1, results.length - 1)]; };
  return { spawn, calls };
}

test('isNtStatusCrash: true only for an unsigned exit code at or above 0x80000000', () => {
  assert.equal(isNtStatusCrash(2147483652), true);
  assert.equal(isNtStatusCrash(3221225477), true);
  assert.equal(isNtStatusCrash(2147483648), true);
  assert.equal(isNtStatusCrash(-1073741819), true);
  assert.equal(isNtStatusCrash(2147483647), false);
  assert.equal(isNtStatusCrash(1), false);
  assert.equal(isNtStatusCrash(0), false);
  assert.equal(isNtStatusCrash(255), false);
  assert.equal(isNtStatusCrash(null), false);
  assert.equal(isNtStatusCrash(undefined), false);
});

test('spawnSyncRetryingCrash: an ordinary non-zero exit is returned at once, never retried', () => {
  const { spawn, calls } = scripted([{ status: 1, stderr: '' }]);
  const res = spawnSyncRetryingCrash('bash', ['-c', 'x'], {}, { spawn, log: () => {} });
  assert.equal(res.status, 1);
  assert.equal(calls.length, 1);
});

test('spawnSyncRetryingCrash: a crash status then success returns the success and logs the retried code', () => {
  const { spawn, calls } = scripted([{ status: 2147483652 }, { status: 0, stdout: 'ok' }]);
  const logged = [];
  const res = spawnSyncRetryingCrash('bash', ['-c', 'x'], { cwd: 'd' }, { spawn, log: (m) => logged.push(m) });
  assert.equal(res.status, 0);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], ['bash', ['-c', 'x'], { cwd: 'd' }]);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /2147483652/);
});

test('spawnSyncRetryingCrash: a persistent crash is retried at most twice, then returned as is', () => {
  const { spawn, calls } = scripted([{ status: 2147483652 }]);
  const res = spawnSyncRetryingCrash('bash', [], {}, { spawn, log: () => {} });
  assert.equal(res.status, 2147483652);
  assert.equal(calls.length, 3);
});

test('spawnSyncRetryingCrash: a crash followed by an ordinary failure returns the ordinary failure', () => {
  const { spawn, calls } = scripted([{ status: 3221225477 }, { status: 2 }]);
  const res = spawnSyncRetryingCrash('bash', [], {}, { spawn, log: () => {} });
  assert.equal(res.status, 2);
  assert.equal(calls.length, 2);
});
