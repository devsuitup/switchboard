'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');

const { stageOneConcurrency, DEFAULT_CONCURRENCY } = require('../scripts/run-tests.js');

function withEnv(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'SWITCHBOARD_TEST_CONCURRENCY');
  const previous = process.env.SWITCHBOARD_TEST_CONCURRENCY;
  if (value === undefined) delete process.env.SWITCHBOARD_TEST_CONCURRENCY;
  else process.env.SWITCHBOARD_TEST_CONCURRENCY = value;
  try {
    return fn();
  } finally {
    if (had) process.env.SWITCHBOARD_TEST_CONCURRENCY = previous;
    else delete process.env.SWITCHBOARD_TEST_CONCURRENCY;
  }
}

function available() {
  return typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
}

test('unset: caps at DEFAULT_CONCURRENCY rather than taking every core (mutation target: dropping the cap)', () => {
  const got = withEnv(undefined, stageOneConcurrency);
  assert.equal(got, Math.min(DEFAULT_CONCURRENCY, available()));
  assert.ok(got <= DEFAULT_CONCURRENCY, `expected at most ${DEFAULT_CONCURRENCY}, got ${got}`);
});

test('unset: never exceeds what the machine has, on a machine smaller than the cap', () => {
  assert.ok(withEnv(undefined, stageOneConcurrency) <= available());
});

test('a positive integer in the environment wins over the cap, in both directions', () => {
  assert.equal(withEnv('1', stageOneConcurrency), 1);
  assert.equal(withEnv('64', stageOneConcurrency), 64);
});

test('an unusable value falls back to the cap instead of failing the run', () => {
  for (const bad of ['0', '-3', '2.5', 'banana', ' ']) {
    assert.equal(withEnv(bad, stageOneConcurrency), Math.min(DEFAULT_CONCURRENCY, available()), `for ${JSON.stringify(bad)}`);
  }
});

test('an empty value is treated as unset, not as an error', () => {
  assert.equal(withEnv('', stageOneConcurrency), Math.min(DEFAULT_CONCURRENCY, available()));
});

test('requiring the module does not run the suite', () => {
  assert.equal(typeof stageOneConcurrency, 'function');
  assert.equal(typeof DEFAULT_CONCURRENCY, 'number');
});
