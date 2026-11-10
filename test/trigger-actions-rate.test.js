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

const { createTriggerActions } = require('../src/main/triggers/trigger-actions');
const { fixture, ID } = require('./fixtures/trigger-open.cjs');
const { fixture: stopFixture } = require('./fixtures/trigger-stop.cjs');

function rated(extra = {}) {
  let now = 0;
  const f = fixture({ now: () => now });
  let serial = 0;
  f.ctx.lifecycle.randomUUID = () => `3${String(++serial).padStart(7, '0')}-89ab-cdef-0123-456789abcdef`;
  Object.assign(f.ctx.lifecycle, extra);
  const dispatches = () => f.events.filter(event => event[0] === 'renderer').length;
  return { f, dispatches, advance: ms => { now = ms; } };
}
const counts = h => ({ dispatches: h.dispatches(), names: h.f.events.filter(event => event[0] === 'name').length,
  deliveries: h.f.events.filter(event => event[0] === 'deliver').length });

test('three real new actions dispatch and the fourth is refused before any effect', async () => {
  const h = rated();
  for (let i = 0; i < 3; i++) assert.equal((await h.f.new()).outcome, 'opened');
  const before = counts(h);
  assert.equal(before.dispatches, 3);
  const fourth = await h.f.new();
  assert.equal(fourth.reason, 'new session rate limit exceeded'); assert.equal(fourth.ok, false); assert.equal(fourth.outcome, 'refused');
  assert.deepEqual(counts(h), before, 'no renderer dispatch, placeholder, name save or delivery for the refused action');
});
test('the real admission refills one whole token exactly at 20 seconds', async () => {
  const h = rated();
  for (let i = 0; i < 3; i++) await h.f.new();
  h.advance(19999);
  assert.equal((await h.f.new()).reason, 'new session rate limit exceeded');
  h.advance(20000);
  assert.equal((await h.f.new()).outcome, 'opened');
  assert.equal((await h.f.new()).reason, 'new session rate limit exceeded');
  assert.equal(h.dispatches(), 4);
});
test('concurrent real new actions cannot overdraw the bucket', async () => {
  const h = rated();
  const results = await Promise.all(Array.from({ length: 8 }, () => h.f.new()));
  assert.equal(results.filter(r => r.outcome === 'opened').length, 3);
  assert.equal(results.filter(r => r.reason === 'new session rate limit exceeded').length, 5);
  assert.equal(h.dispatches(), 3);
});
test('a definite pre-spawn failure refunds its token once', async () => {
  const h = rated();
  const request = h.f.ctx.lifecycle.broker.request;
  h.f.ctx.lifecycle.broker.request = async () => ({ ok: false, reason: 'window not available' });
  for (let i = 0; i < 5; i++) assert.equal((await h.f.new()).reason, 'window not available');
  h.f.ctx.lifecycle.broker.request = request;
  for (let i = 0; i < 3; i++) assert.equal((await h.f.new()).outcome, 'opened');
  assert.equal((await h.f.new()).reason, 'new session rate limit exceeded');
});
test('a confirmed creation keeps its token although a later step fails', async () => {
  const h = rated();
  h.f.ctx.lifecycle.saveName = async () => { throw new Error('disk'); };
  for (let i = 0; i < 3; i++) {
    const r = await h.f.new();
    assert.equal(r.reason, 'session name could not be saved'); assert.equal(r.created, true);
  }
  assert.equal((await h.f.new()).reason, 'new session rate limit exceeded');
});
test('an uncertain possible creation keeps its token', async () => {
  const h = rated();
  h.f.ctx.lifecycle.broker.request = async () => ({ ok: false, reason: 'renderer action timed out', uncertain: true });
  for (let i = 0; i < 3; i++) assert.equal((await h.f.new()).uncertain, true);
  assert.equal((await h.f.new()).reason, 'new session rate limit exceeded');
});
test('resume and reattach stay exempt from the new-session bucket', async () => {
  const h = rated();
  for (let i = 0; i < 3; i++) await h.f.new();
  assert.equal((await h.f.new()).reason, 'new session rate limit exceeded');
  for (const key of [...h.f.map.keys()]) if (key !== ID) h.f.map.delete(key);
  assert.equal((await h.f.open()).outcome, 'opened');
  h.f.ctx.getPtyForSession = () => null;
  assert.equal((await h.f.open()).outcome, 'opened');
});
test('stop stays exempt from the new-session bucket', async t => {
  const f = stopFixture(t);
  const actions = createTriggerActions({ now: Date.now });
  for (let i = 0; i < 3; i++) assert.ok(actions.limiter.reserve());
  assert.equal(actions.limiter.reserve(), null);
  const done = actions.execute({ version: 1, action: 'stop', sessionId: '01234567-89ab-cdef-0123-456789abcdef' },
    '21234567-89ab-cdef-0123-456789abcdef', f.execution);
  await f.flush();
  assert.equal(f.kills(), 1);
  f.session.exited = true;
  await f.tick(30);
  assert.equal((await done).outcome, 'closed');
});
test('independent action owners keep independent buckets', async () => {
  const first = rated(); const second = rated();
  for (let i = 0; i < 3; i++) await first.f.new();
  assert.equal((await first.f.new()).reason, 'new session rate limit exceeded');
  assert.equal((await second.f.new()).outcome, 'opened');
});
