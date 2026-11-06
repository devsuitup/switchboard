'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createNewSessionLimiter } = require('../src/main/triggers/trigger-actions');

test('new-session bucket reserves atomically, refills at 20 seconds and refunds once', () => {
  let now = 0;
  const limiter = createNewSessionLimiter(() => now);
  const first = limiter.reserve();
  assert.ok(first);
  assert.ok(limiter.reserve());
  assert.ok(limiter.reserve());
  assert.equal(limiter.reserve(), null);
  now = 19999;
  assert.equal(limiter.reserve(), null);
  now = 20000;
  assert.ok(limiter.reserve());
  assert.equal(limiter.reserve(), null);
  first.refund();
  first.refund();
  assert.ok(limiter.reserve());
  assert.equal(limiter.reserve(), null);
});
