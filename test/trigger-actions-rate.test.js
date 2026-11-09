'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createNewSessionLimiter } = require('../src/main/triggers/trigger-actions');

test('three tokens burst, fractional refill and fixed 20 second boundary', () => {
  let now = 0;
  const bucket = createNewSessionLimiter({ now: () => now });
  for (let i = 0; i < 3; i++) assert.ok(bucket.reserve(), 'each of the first three launches reserves a token');
  assert.equal(bucket.reserve(), null);
  now = 19999;
  assert.equal(bucket.reserve(), null);
  now = 20000;
  assert.ok(bucket.reserve());
  assert.equal(bucket.reserve(), null);
  now = 40000;
  assert.ok(bucket.reserve());
  now = 200000;
  for (let i = 0; i < 3; i++) assert.ok(bucket.reserve());
  assert.equal(bucket.reserve(), null, 'refill never exceeds capacity');
});

test('definite pre-spawn refunds once; spawned or uncertain failures retain tokens', () => {
  const bucket = createNewSessionLimiter({ now: () => 0 });
  const first = bucket.reserve();
  assert.ok(first);
  first.refund();
  first.refund();
  const reservations = Array.from({ length: 3 }, () => bucket.reserve());
  assert.ok(reservations.every(Boolean));
  assert.equal(bucket.reserve(), null);
  reservations[0].retain();
  reservations[0].refund();
  assert.equal(bucket.reserve(), null, 'possible spawn cannot be refunded');
});

test('parallel reservations cannot overdraw; watcher instances have separate buckets', async () => {
  const bucket = createNewSessionLimiter({ now: () => 0 });
  const reservations = await Promise.all(Array.from({ length: 20 }, async () => bucket.reserve()));
  assert.equal(reservations.filter(Boolean).length, 3);
  assert.ok(createNewSessionLimiter({ now: () => 0 }).reserve());
});
