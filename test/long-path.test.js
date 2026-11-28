'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLongPathResolver, longPathForms, settleLongPathForms, longPathLookup } = require('../src/main/shared/long-path');

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

test('GIVEN Windows WHEN a short path is missing THEN its deepest existing ancestor carries the long form', () => {
  const calls = [];
  const resolve = createLongPathResolver({ platform: 'win32', realpath: value => {
    calls.push(value);
    if (value === 'C:/Users/JEAN-B~1/repo') return 'C:/Users/Jean-Baptiste/repo';
    throw Object.assign(new Error('gone'), { code: 'ENOENT' });
  } });
  assert.equal(resolve('C:/Users/JEAN-B~1/repo/.work-files/worktrees/topic').replaceAll('\\', '/'),
    'C:/Users/Jean-Baptiste/repo/.work-files/worktrees/topic');
  assert.deepEqual(calls, ['C:/Users/JEAN-B~1/repo/.work-files/worktrees/topic', 'C:/Users/JEAN-B~1/repo/.work-files/worktrees',
    'C:/Users/JEAN-B~1/repo/.work-files', 'C:/Users/JEAN-B~1/repo']);
});

test('GIVEN a non-Windows platform WHEN long forms are precomputed THEN there are none and realpath is never called', async () => {
  let calls = 0;
  assert.equal(await longPathForms(['/home/u/JEAN-B~1'], { platform: 'linux', realpath: async () => { calls++; return '/x'; } }), null);
  assert.equal(calls, 0);
});

test('GIVEN Windows WHEN long forms are precomputed THEN each normalized spelling resolves once and failures are left out', async () => {
  const calls = [];
  const forms = await longPathForms(['C:/Users/JEAN-B~1/a', 'c:\\users\\jean-b~1\\a\\', 'C:/plain', 'C:/gone/RUNNER~1', null], { platform: 'win32',
    realpath: async value => { calls.push(value); if (value.includes('gone')) throw new Error('gone'); return 'C:\\Users\\Jean-Baptiste\\a'; } });
  assert.deepEqual(forms, { 'c:/users/jean-b~1/a': 'C:\\Users\\Jean-Baptiste\\a' });
  assert.deepEqual(calls, ['C:/Users/JEAN-B~1/a', 'C:/gone/RUNNER~1']);
});

test('GIVEN precomputed forms WHEN a lookup is asked THEN it answers from them and never calls the filesystem itself', () => {
  const forms = { 'c:/users/jean-b~1/a': 'C:\\Users\\Jean-Baptiste\\a' };
  assert.equal(longPathLookup(null, null), null);
  const lookup = longPathLookup(forms);
  assert.equal(lookup('C:\\Users\\JEAN-B~1\\a'), 'C:\\Users\\Jean-Baptiste\\a');
  assert.equal(lookup('C:/Users/JEAN-B~1/b'), 'C:/Users/JEAN-B~1/b', 'a miss without fallback must return its input');
  const asked = [];
  const withFallback = longPathLookup(forms, value => { asked.push(value); return 'fallback'; });
  assert.equal(withFallback('C:/Users/JEAN-B~1/a'), 'C:\\Users\\Jean-Baptiste\\a');
  assert.equal(withFallback('C:/Users/JEAN-B~1/b'), 'fallback');
  assert.equal(withFallback('C:/plain'), 'C:/plain');
  assert.deepEqual(asked, ['C:/Users/JEAN-B~1/b']);
});

test('GIVEN Windows WHEN forms are settled THEN values appearing during a round are resolved and a miss is retried once', async () => {
  const values = ['C:/A~1'];
  const calls = [];
  const forms = await settleLongPathForms(() => values, { platform: 'win32', realpath: async value => {
    calls.push(value);
    if (value === 'C:/A~1') { values.push('C:/B~1'); return 'C:/Along'; }
    throw new Error('missing');
  } });
  assert.deepEqual(forms, { 'c:/a~1': 'C:\\Along' });
  assert.deepEqual(calls, ['C:/A~1', 'C:/B~1', 'C:/B~1'], 'a value added mid-round is resolved and its miss retried exactly once');
});

test('GIVEN a non-Windows platform WHEN forms are settled THEN nothing is read or resolved', async () => {
  let reads = 0;
  assert.equal(await settleLongPathForms(() => { reads++; return ['/x~1']; }, { platform: 'linux', realpath: async () => '/y' }), null);
  assert.equal(reads, 0);
});

test('GIVEN each resolution makes a new short path appear WHEN forms are settled THEN rounds and retained forms stay bounded', async () => {
  let n = 0;
  const calls = [];
  const forms = await settleLongPathForms(() => [`C:/P${n}~1`], { platform: 'win32', realpath: async value => {
    calls.push(value);
    if (n < 256) n++;
    return value.replace('~1', 'long');
  } });
  assert.ok(calls.length <= 3, `no pass bound: ${calls.length} resolutions`);
  assert.ok(Object.keys(forms).length <= 1, `retained ${Object.keys(forms).length} forms for a single-element snapshot`);
  assert.ok(Object.keys(forms).every(key => key === `c:/p${n}~1`), 'only paths of the last read may be retained');
});

test('GIVEN many short paths WHEN forms are settled THEN realpath concurrency is capped', async () => {
  const values = Array.from({ length: 20 }, (_, i) => `C:/Q${i}~1`);
  let inFlight = 0, peak = 0;
  const forms = await settleLongPathForms(() => values, { platform: 'win32', realpath: async value => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise(resolve => setImmediate(resolve));
    inFlight--;
    return value.replace('~1', 'long');
  } });
  assert.equal(Object.keys(forms).length, 20);
  assert.ok(peak <= 4, `peak realpath concurrency ${peak}`);
});

test('GIVEN a path that left the candidates during settling WHEN settling stops early THEN its form is not retained', async () => {
  let values = ['C:/Gone~1'];
  const forms = await settleLongPathForms(() => values, { platform: 'win32', realpath: async value => {
    values = ['C:/Plain'];
    return value.replace('~1', 'long');
  } });
  assert.deepEqual(forms, {}, 'a vanished path must not keep its form');
});
