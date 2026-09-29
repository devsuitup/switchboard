// The client talks to a server that is usually not running. What matters is
// that its absence costs nothing and is never reported as an app error: no
// throw, no per-beat log, and no network call at all while backed off.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createActivityWatchClient, MAX_COOLDOWN_MS } = require('../activitywatch-client');

const BUCKET = { client: 'aw-watcher-switchboard', type: 'app.editor.activity' };

// `server` decides every response: 'up', 'down' (the socket refuses), or a
// status code to answer with. Flipping it mid-test is how a server that goes
// away and comes back is staged.
function harness({ server = 'up', startAt = 1_000_000 } = {}) {
  const calls = [];
  const logged = [];
  let clock = startAt;
  const state = { server };

  const client = createActivityWatchClient({
    hostname: 'testhost',
    now: () => clock,
    log: { info: (m) => logged.push(m), warn: (m) => logged.push(m) },
    fetchFn: async (url, opts) => {
      calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
      if (state.server === 'down') throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      if (typeof state.server === 'number') return { ok: false, status: state.server };
      return { ok: true, status: 200 };
    },
  });

  return {
    client, calls, logged,
    set: (s) => { state.server = s; },
    advance: (ms) => { clock += ms; },
    at: () => clock,
    paths: () => calls.map(c => c.url.replace('http://localhost:5600', '')),
  };
}

test('a heartbeat creates the bucket once, then only beats', async () => {
  const h = harness();
  assert.equal(await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60), true);
  assert.equal(await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60), true);

  assert.deepEqual(h.paths(), [
    '/api/0/buckets/b',
    '/api/0/buckets/b/heartbeat?pulsetime=60',
    '/api/0/buckets/b/heartbeat?pulsetime=60',
  ], 'the bucket is created once and reused');
});

test('the heartbeat carries an ISO timestamp, a zero duration and the data as given', async () => {
  const h = harness();
  await h.client.heartbeat('b', BUCKET, { project: 'switchboard', session: 's1' }, 60);
  const beat = h.calls[1].body;
  assert.equal(beat.duration, 0);
  assert.deepEqual(beat.data, { project: 'switchboard', session: 's1' });
  assert.equal(new Date(beat.timestamp).toISOString(), beat.timestamp, 'ISO 8601, round-trips');
});

test('a refused connection resolves false instead of throwing', async () => {
  const h = harness({ server: 'down' });
  assert.equal(await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60), false);
  assert.equal(h.client.reachable, false);
});

test('while backed off no network call is made at all', async () => {
  const h = harness({ server: 'down' });
  await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60);
  const afterFirst = h.calls.length;

  for (let i = 0; i < 20; i++) {
    assert.equal(await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60), false);
    h.advance(100);
  }
  assert.equal(h.calls.length, afterFirst, 'a sleeping client never touches the socket');
});

test('the cooldown grows while the server stays down, and is capped', async () => {
  const h = harness({ server: 'down' });
  const attemptsAt = [];

  for (let i = 0; i < 4000; i++) {
    const before = h.calls.length;
    await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60);
    if (h.calls.length > before) attemptsAt.push(h.at());
    h.advance(1000);
  }

  const gaps = attemptsAt.slice(1).map((t, i) => t - attemptsAt[i]);
  assert.ok(gaps.length > 4, `expected several retries, got ${gaps.length}`);
  assert.ok(gaps[0] < gaps[gaps.length - 1], 'the gap widens rather than hammering');
  assert.ok(Math.max(...gaps) <= MAX_COOLDOWN_MS + 1000, 'and stops widening at the cap');
});

test('the server coming back is noticed, and the bucket is re-created', async () => {
  const h = harness({ server: 'down' });
  await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60);
  h.advance(MAX_COOLDOWN_MS);
  h.set('up');

  assert.equal(await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60), true);
  assert.equal(h.client.reachable, true);
  assert.equal(h.paths().filter(p => p === '/api/0/buckets/b').length, 2,
    'a server that went away may come back empty, so the bucket is asserted again');
});

test('the transitions are logged once each, not once per beat', async () => {
  const h = harness({ server: 'down' });
  await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60);
  for (let i = 0; i < 50; i++) { await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60); h.advance(10); }
  h.advance(MAX_COOLDOWN_MS);
  h.set('up');
  await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60);

  assert.equal(h.logged.length, 2, `one down, one up — got ${JSON.stringify(h.logged)}`);
  assert.match(h.logged[0], /unreachable/);
  assert.match(h.logged[1], /reachable again/);
});

test('a 4xx is the server answering, so it does not trigger a backoff', async () => {
  const h = harness({ server: 400 });
  assert.equal(await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60), false,
    'the call reports failure');
  assert.equal(h.client.sleeping, false, 'but a bad payload is our bug, not an absent server');
  assert.equal(h.logged.length, 0, 'and nothing is logged about an unreachable server');
});

// aw-server answers 304 when the bucket is already there. fetch reports ok
// only for 2xx, so a client that reads `ok` alone re-creates the bucket before
// every single beat.
test('a bucket that already exists is not re-created before every beat', async () => {
  const h = harness({ server: 304 });
  assert.equal(await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60), true,
    '304 on create is success, and the beat that follows is taken');
  await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60);
  assert.equal(h.paths().filter(p => p === '/api/0/buckets/b').length, 1);
});

test('a bucket id with a slash cannot escape its own endpoint', async () => {
  const h = harness();
  await h.client.heartbeat('a/../../etc', BUCKET, { project: 'x' }, 60);
  assert.ok(h.calls.every(c => !c.url.includes('/../')), h.calls.map(c => c.url).join('\n'));
});

// --- Explicit events, for the concurrent bucket ---

test('an event carries the span the caller measured, as a one-element array', async () => {
  const h = harness();
  const started = Date.UTC(2026, 0, 1, 6, 0, 0);
  assert.equal(await h.client.insertEvent('run', BUCKET, { session: 's1' }, started, 90), true);

  const [, post] = h.calls;
  assert.match(post.url, /\/api\/0\/buckets\/run\/events$/);
  assert.ok(Array.isArray(post.body), 'the events endpoint takes a list');
  assert.equal(post.body.length, 1);
  assert.equal(post.body[0].timestamp, '2026-01-01T06:00:00.000Z');
  assert.equal(post.body[0].duration, 90);
  assert.deepEqual(post.body[0].data, { session: 's1' });
});

test('a negative duration is floored rather than sent', async () => {
  const h = harness();
  await h.client.insertEvent('run', BUCKET, { session: 's1' }, Date.now(), -5);
  assert.equal(h.calls[1].body[0].duration, 0);
});

test('an event is not attempted while the client is backed off', async () => {
  const h = harness({ server: 'down' });
  await h.client.insertEvent('run', BUCKET, { session: 's1' }, Date.now(), 10);
  const after = h.calls.length;
  await h.client.insertEvent('run', BUCKET, { session: 's2' }, Date.now(), 10);
  assert.equal(h.calls.length, after, 'the second event costs no socket');
});

// --- Probe ---

test('a probe answers now even while backed off, and a success ends the backoff', async () => {
  const h = harness({ server: 'down' });
  await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60);
  assert.equal(h.client.sleeping, true);

  h.set('up');
  assert.equal(await h.client.probe(), true, 'a person looking at the settings is not made to wait out a cooldown');
  assert.equal(h.client.reachable, true);
  assert.equal(h.client.sleeping, false);
  assert.match(h.calls.at(-1).url, /\/api\/0\/info$/);
});

test('a failed probe reports false and does not throw', async () => {
  const h = harness({ server: 'down' });
  assert.equal(await h.client.probe(), false);
  assert.equal(h.client.reachable, false);
});
