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

test('a long idle period refills to the capacity of three and no further', () => {
  let now = 0;
  const limiter = createNewSessionLimiter(() => now);
  for (let i = 0; i < 3; i++) assert.ok(limiter.reserve());
  now = 1_000_000;
  for (let i = 0; i < 3; i++) assert.ok(limiter.reserve());
  assert.equal(limiter.reserve(), null);
});

const { makeWorld, makeClock, makeEnv, makeActions, ID_A, ID_B } = require('./helpers/trigger-world');

function newRequest() { return { version: 1, action: 'open', new: { project: '/work/project', name: 'n' }, prompt: 'go' }; }

function rateSetup(overrides = {}) {
  const clock = makeClock();
  const world = makeWorld();
  const opens = [];
  const bridge = { waitReady: async () => ({ ok: true }), ensureOpen: async op => { opens.push(op.mode); return { ok: false, reason: 'session open failed', preSpawn: true, ...overrides.outcome }; } };
  const { actions } = makeActions(world, { now: clock.now, sleep: clock.sleep, bridge, resolveClosed: async id => ({ status: 'found', sessionId: id, cwd: '/work/project', projectPath: '/work/project' }) });
  return { clock, world, opens, actions, run: request => actions.run(request, makeEnv(clock.now() + 60000)) };
}

test('a fourth real new-session request is refused before any renderer placeholder', async () => {
  const r = rateSetup({ outcome: { preSpawn: false, spawned: true, reason: 'renderer action timed out', uncertain: true } });
  for (let i = 0; i < 3; i++) assert.equal((await r.run(newRequest())).reason, 'renderer action timed out');
  const fourth = await r.run(newRequest());
  assert.equal(fourth.reason, 'new session rate limit exceeded');
  assert.equal(r.opens.length, 3);
});

test('a definite pre-spawn failure refunds its token; resume and stop consume none', async () => {
  const r = rateSetup();
  for (let i = 0; i < 6; i++) assert.equal((await r.run(newRequest())).reason, 'session open failed');
  for (let i = 0; i < 6; i++) await r.run({ version: 1, action: 'open', sessionId: ID_A });
  for (let i = 0; i < 6; i++) await r.run({ version: 1, action: 'stop', sessionId: ID_B });
  assert.equal(r.opens.filter(mode => mode === 'new').length, 6);
});

test('parallel dispatch cannot overdraw the bucket', async () => {
  const r = rateSetup({ outcome: { preSpawn: false, spawned: true, reason: 'renderer action timed out' } });
  const results = await Promise.all(Array.from({ length: 6 }, () => r.run(newRequest())));
  assert.equal(results.filter(result => result.reason === 'new session rate limit exceeded').length, 3);
  assert.equal(r.opens.length, 3);
});

test('a token returns after twenty seconds through real requests', async () => {
  const r = rateSetup({ outcome: { preSpawn: false, spawned: true, reason: 'renderer action timed out' } });
  for (let i = 0; i < 3; i++) await r.run(newRequest());
  assert.equal((await r.run(newRequest())).reason, 'new session rate limit exceeded');
  r.clock.t += 19999;
  assert.equal((await r.run(newRequest())).reason, 'new session rate limit exceeded');
  r.clock.t += 1;
  assert.equal((await r.run(newRequest())).reason, 'renderer action timed out');
});
