'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const filename = path.resolve(__dirname, '../src/main/shared/atomic-write.js');

function load(platform) {
  assert.ok(fs.existsSync(filename), 'atomic-write.js must exist');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: createRequire(filename), module, exports: module.exports,
    process: { platform }, SharedArrayBuffer, Atomics,
  }, { filename });
  return module.exports.renameWithRetry;
}

test('EPERM twice then success returns after exactly three renames', () => {
  const renameWithRetry = load('win32');
  let calls = 0;
  const sleeps = [];
  const result = renameWithRetry('src', 'dest', {
    sleep: ms => sleeps.push(ms),
    rename: (src, dest) => {
      assert.equal(src, 'src');
      assert.equal(dest, 'dest');
      if (++calls < 3) throw Object.assign(new Error('locked'), { code: 'EPERM' });
      return 'done';
    },
  });
  assert.equal(result, 'done');
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [10, 30]);
});

test('ENOENT throws the original error after one call without sleeping', () => {
  const renameWithRetry = load('win32');
  const err = Object.assign(new Error('missing'), { code: 'ENOENT' });
  let calls = 0;
  assert.throws(() => renameWithRetry('src', 'dest', {
    rename: () => { calls++; throw err; },
    sleep: () => assert.fail('must not sleep'),
  }), error => error === err);
  assert.equal(calls, 1);
});

test('persistent EPERM throws the last error after five bounded attempts', () => {
  const renameWithRetry = load('win32');
  const errors = Array.from({ length: 5 }, (_, i) => Object.assign(new Error(`locked ${i}`), { code: 'EPERM' }));
  let calls = 0;
  const sleeps = [];
  assert.throws(() => renameWithRetry('src', 'dest', {
    rename: () => { throw errors[calls++]; }, sleep: ms => sleeps.push(ms),
  }), error => error === errors[4]);
  assert.equal(calls, 5);
  assert.deepEqual(sleeps, [10, 30, 100, 300]);
  assert.ok(sleeps.reduce((a, b) => a + b, 0) < 500);
});

for (const code of ['EACCES', 'EBUSY']) {
  test(`${code} retries with the supplied attempts and delays`, () => {
    const renameWithRetry = load('win32');
    let calls = 0;
    const sleeps = [];
    renameWithRetry('src', 'dest', {
      attempts: 3, delays: [2, 4], sleep: ms => sleeps.push(ms),
      rename: () => { if (++calls < 3) throw Object.assign(new Error(code), { code }); },
    });
    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [2, 4]);
  });
}

for (const platform of ['linux', 'darwin']) {
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    test(`${platform} rethrows ${code} immediately`, () => {
      const renameWithRetry = load(platform);
      const err = Object.assign(new Error(code), { code });
      let calls = 0;
      assert.throws(() => renameWithRetry('src', 'dest', {
        rename: () => { calls++; throw err; }, sleep: () => assert.fail('must not sleep'),
      }), error => error === err);
      assert.equal(calls, 1);
    });
  }
}

test('one requested attempt never sleeps', () => {
  const renameWithRetry = load('win32');
  const err = Object.assign(new Error('locked'), { code: 'EPERM' });
  let calls = 0;
  assert.throws(() => renameWithRetry('src', 'dest', {
    attempts: 1, delays: [], rename: () => { calls++; throw err; },
    sleep: () => assert.fail('must not sleep'),
  }), error => error === err);
  assert.equal(calls, 1);
});
