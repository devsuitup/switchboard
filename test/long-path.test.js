'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLongPathResolver } = require('../src/main/shared/long-path');

test('GIVEN a non-Windows platform WHEN a resolver is requested THEN there is none and realpath is never called', () => {
  for (const platform of ['linux', 'darwin']) {
    let calls = 0;
    assert.equal(createLongPathResolver({ platform, realpath: () => { calls++; return '/x'; } }), null);
    assert.equal(calls, 0);
  }
});

test('GIVEN Windows WHEN a path has a short segment THEN it resolves once per normalized spelling', () => {
  const calls = [];
  const resolve = createLongPathResolver({ platform: 'win32', realpath: value => { calls.push(value); return 'C:\\Users\\Jean-Baptiste\\proj'; } });
  assert.equal(resolve('C:/Users/JEAN-B~1/proj'), 'C:\\Users\\Jean-Baptiste\\proj');
  assert.equal(resolve('c:\\users\\jean-b~1\\proj\\'), 'C:\\Users\\Jean-Baptiste\\proj', 'the cache must be keyed by the normalized spelling');
  assert.deepEqual(calls, ['C:/Users/JEAN-B~1/proj']);
});

test('GIVEN Windows WHEN a path has no short segment THEN realpath is not called', () => {
  let calls = 0;
  const resolve = createLongPathResolver({ platform: 'win32', realpath: () => { calls++; return 'other'; } });
  assert.equal(resolve('C:/Users/Jean-Baptiste/proj'), 'C:/Users/Jean-Baptiste/proj');
  assert.equal(calls, 0);
});

test('GIVEN Windows WHEN the path does not exist THEN the input comes back, cached, without throwing', () => {
  let calls = 0;
  const resolve = createLongPathResolver({ platform: 'win32', realpath: () => { calls++; throw Object.assign(new Error('gone'), { code: 'ENOENT' }); } });
  assert.equal(resolve('C:/gone/RUNNER~1'), 'C:/gone/RUNNER~1');
  assert.equal(resolve('C:\\gone\\RUNNER~1'), 'C:\\gone\\RUNNER~1', 'a cached miss must return its own input');
  assert.equal(calls, 1);
});

test('GIVEN Windows WHEN the value is not a string THEN it comes back unchanged', () => {
  const resolve = createLongPathResolver({ platform: 'win32', realpath: () => { throw new Error('unreachable'); } });
  assert.equal(resolve(null), null);
});
