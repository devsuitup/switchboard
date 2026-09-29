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
      const answer = typeof state.server === 'function' ? state.server(url, opts) : state.server;
      if (answer === 'down') throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      if (typeof answer === 'number') return { ok: answer >= 200 && answer < 300, status: answer };
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
  assert.equal(await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60), true);

  assert.deepEqual(h.paths(), [
    '/api/0/buckets/b',
    '/api/0/buckets/b/heartbeat?pulsetime=0',
    '/api/0/buckets/b/heartbeat?pulsetime=60',
    '/api/0/buckets/b/heartbeat?pulsetime=60',
  ], 'the bucket is created once and reused');
});

test('the heartbeat carries an ISO timestamp, a zero duration and the data as given', async () => {
  const h = harness({ server: (url) => (/\/api\/0\/buckets\/[^/]+$/.test(url) ? 304 : 200) });
  await h.client.heartbeat('b', BUCKET, { project: 'switchboard', session: 's1' }, 60);
  const beat = h.calls[1].body;
  assert.match(h.calls[1].url, /\/heartbeat\?pulsetime=60$/);
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

test('a 5xx is a server that cannot take the write, so it backs off like an absent one', async () => {
  const h = harness({ server: 503 });
  assert.equal(await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60), false);
  assert.equal(h.client.sleeping, true);
  const sent = h.calls.length;
  await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60);
  assert.equal(h.calls.length, sent, 'nothing is sent during the cooldown');
});

// aw-server answers 304 when the bucket is already there. fetch reports ok
// only for 2xx, so a client that reads `ok` alone re-creates the bucket before
// every single beat.
test('a bucket that already exists is not re-created before every beat', async () => {
  const h = harness({ server: (url) => (/\/api\/0\/buckets\/[^/]+$/.test(url) ? 304 : 200) });
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

// --- upsertSpan: find by start time and match value, update or insert ---

// A fetch that answers GETs from `stored` and records POSTs.
function spanHarness({ stored = [], getStatus = 200 } = {}) {
  const posts = [];
  const gets = [];
  const client = createActivityWatchClient({
    hostname: 'h',
    fetchFn: async (url, opts) => {
      if (!opts || !opts.method) {
        gets.push(url);
        return { ok: getStatus === 200, status: getStatus, json: async () => stored };
      }
      posts.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, status: 200 };
    },
  });
  return { client, posts, gets, eventPosts: () => posts.filter(p => p.url.endsWith('/events')) };
}

const START = Date.UTC(2026, 0, 1, 6, 0, 0, 123);

test('a span not yet on the server is inserted without an id', async () => {
  const h = spanHarness({ stored: [] });
  assert.equal(await h.client.upsertSpan('r', BUCKET, { session: 'A' }, START, 60, { key: 'session', values: ['A'] }), true);
  const [post] = h.eventPosts();
  assert.equal('id' in post.body[0], false);
  assert.equal(post.body[0].duration, 60);
});

test('a span already on the server is updated under its own id', async () => {
  const h = spanHarness({ stored: [{ id: 8, timestamp: '2026-01-01T06:00:00.123000+00:00', data: { session: 'A' } }] });
  await h.client.upsertSpan('r', BUCKET, { session: 'A' }, START, 120, { key: 'session', values: ['A'] });
  assert.equal(h.eventPosts()[0].body[0].id, 8);
  assert.equal(h.eventPosts()[0].body[0].duration, 120);
});

// aw-server's range query does not return a zero-duration event whose
// timestamp equals `start`, and the write at a session's start is exactly
// that. A window opening at the span start found nothing, so every
// checkpoint inserted a duplicate.
test('the lookup window opens before the span start, so a zero-duration event is found', async () => {
  const h = spanHarness();
  await h.client.upsertSpan('r', BUCKET, { session: 'A' }, START, 1, { key: 'session', values: ['A'] });
  const url = new URL(h.gets[0]);
  assert.equal(url.searchParams.get('start'), '2026-01-01T06:00:00.122Z');
  assert.equal(url.searchParams.get('end'), '2026-01-01T06:00:00.124Z');
});

// Two concurrent creates of one bucket can get a 500 from aw-server for the
// second, which dropped that write. One create is ever in flight per bucket.
test('writes racing on a fresh bucket share one create request', async () => {
  const h = spanHarness();
  await Promise.all([
    h.client.upsertSpan('r', BUCKET, { session: 'A' }, START, 0, { key: 'session', values: ['A'] }),
    h.client.upsertSpan('r', BUCKET, { session: 'B' }, START, 0, { key: 'session', values: ['B'] }),
    h.client.heartbeat('r', BUCKET, { project: 'x' }, 60),
  ]);
  assert.equal(h.posts.filter(p => p.url.endsWith('/api/0/buckets/r')).length, 1);
  assert.equal(h.eventPosts().length, 2, 'both span writes went out');
  assert.equal(h.posts.filter(p => p.url.includes('/heartbeat')).length, 1, 'and so did the beat');
});

test('another session starting in the same millisecond is not mistaken for this one', async () => {
  const h = spanHarness({ stored: [{ id: 9, data: { session: 'B' } }] });
  await h.client.upsertSpan('r', BUCKET, { session: 'A' }, START, 60, { key: 'session', values: ['A'] });
  assert.equal('id' in h.eventPosts()[0].body[0], false, 'B was not overwritten with A');
});

test('the match value, not the new data, finds the event — so a renamed span keeps its event', async () => {
  const h = spanHarness({ stored: [{ id: 8, data: { session: 'tmp' } }] });
  await h.client.upsertSpan('r', BUCKET, { session: 'real' }, START, 60, { key: 'session', values: ['tmp'] });
  const body = h.eventPosts()[0].body[0];
  assert.equal(body.id, 8);
  assert.equal(body.data.session, 'real', 'the update rewrites the id the event carries');
});

// aw-server answers 200 to an update whose id does not exist and stores
// nothing, so an id is never cached: every write looks the event up.
test('a bucket deleted under the client is re-created on the next write', async () => {
  const h = spanHarness({ getStatus: 404 });
  assert.equal(await h.client.upsertSpan('r', BUCKET, { session: 'A' }, START, 60, { key: 'session', values: ['A'] }), false);
  await h.client.upsertSpan('r', BUCKET, { session: 'A' }, START, 60, { key: 'session', values: ['A'] });
  const creates = h.posts.filter(p => p.url.endsWith('/api/0/buckets/r'));
  assert.equal(creates.length, 2, 'the bucket is asserted again after the 404');
});

// --- Findings from review, each a defect that shipped green ---

test('a lookup that fails with a server error writes nothing, rather than a duplicate', async () => {
  const h = spanHarness({ stored: [{ id: 8, data: { session: 'A' } }], getStatus: 500 });
  assert.equal(await h.client.upsertSpan('r', BUCKET, { session: 'A' }, START, 60, { key: 'session', values: ['A'] }), false);
  assert.equal(h.eventPosts().length, 0, 'a 500 is not "not found"');
});

test('a heartbeat to a bucket deleted under the client re-creates it on the next beat', async () => {
  let deleted = false;
  const h = harness({ server: (url) => (deleted && url.includes('/heartbeat') ? 404 : 200) });
  await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60);
  deleted = true;
  assert.equal(await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60), false);
  deleted = false;
  await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60);
  assert.equal(h.paths().filter(p => p === '/api/0/buckets/b').length, 2, 'the 404 forgot the bucket');
});

test('a bucket known before the server went away is created again when it returns', async () => {
  const h = harness();
  await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60);   // bucket now known
  h.set('down');
  await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60);
  h.advance(MAX_COOLDOWN_MS);
  h.set('up');
  await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60);
  assert.equal(h.paths().filter(p => p === '/api/0/buckets/b').length, 2);
});

test('a span write makes no call while the client is backed off', async () => {
  const h = harness({ server: 'down' });
  await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60);
  const before = h.calls.length;
  assert.equal(await h.client.upsertSpan('b', BUCKET, { session: 'A' }, START, 1, { key: 'session', values: ['A'] }), false);
  assert.equal(h.calls.length, before);
});

test('the cooldown starts over after a success, instead of resuming where it was', async () => {
  const h = harness({ server: 'down' });
  const attemptAt = [];
  const beatAndRecord = async () => {
    const before = h.calls.length;
    await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60);
    if (h.calls.length > before) attemptAt.push(h.at());
  };
  for (let i = 0; i < 200; i++) { await beatAndRecord(); h.advance(1000); }   // cooldown grows to its cap
  h.set('up');
  h.advance(MAX_COOLDOWN_MS);
  await beatAndRecord();                                                       // recovers
  h.set('down');
  await beatAndRecord();                                                       // fails once more
  const failedAt = h.at();
  for (let i = 0; i < 20; i++) { h.advance(1000); await beatAndRecord(); }
  const nextTry = attemptAt.find(t => t > failedAt);
  assert.ok(nextTry - failedAt <= 6000, `retried after ${nextTry - failedAt} ms, not the capped cooldown`);
});

test('two failures in a row are logged once', async () => {
  const h = harness({ server: 'down' });
  await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60);
  h.advance(MAX_COOLDOWN_MS);
  await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60);
  assert.equal(h.calls.length, 2, 'both attempts reached the socket');
  assert.equal(h.logged.length, 1);
});

test('every request carries a timeout, so a hung server cannot hold a write forever', async () => {
  const signals = [];
  const client = createActivityWatchClient({
    hostname: 'h',
    fetchFn: async (url, opts) => { signals.push(opts && opts.signal); return { ok: true, status: 200, json: async () => [] }; },
  });
  await client.heartbeat('b', BUCKET, { project: 'x' }, 60);
  await client.upsertSpan('b', BUCKET, { session: 'A' }, START, 1, { key: 'session', values: ['A'] });
  await client.probe();
  assert.ok(signals.length >= 5);
  assert.ok(signals.every(s => s instanceof AbortSignal), 'no request goes out without a signal');
});

test('a negative span is floored at zero', async () => {
  const h = spanHarness();
  await h.client.upsertSpan('r', BUCKET, { session: 'A' }, START, -3, { key: 'session', values: ['A'] });
  assert.equal(h.eventPosts()[0].body[0].duration, 0);
});

test('a span is found under any of the ids it may carry', async () => {
  const h = spanHarness({ stored: [{ id: 8, data: { session: 'real' } }] });
  await h.client.upsertSpan('r', BUCKET, { session: 'real' }, START, 60, { key: 'session', values: ['tmp', 'real'] });
  assert.equal(h.eventPosts()[0].body[0].id, 8, 'the write that renamed it may have been stored unacknowledged');
});

// --- Convergence review ---

// aw-server keeps, per bucket id, the last event a heartbeat can merge into,
// and does not clear it when the bucket is deleted. A heartbeat to the
// re-created bucket then merges into that ghost: it fails with 500, or — after
// a POST /events — rewrites the new event with the deleted span's start. A
// zero pulsetime cannot reach a ghost in the past.
test('the first beat to a bucket this client created has no merge window', async () => {
  const h = harness();
  await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60);
  await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60);
  assert.deepEqual(h.paths(), [
    '/api/0/buckets/b',
    '/api/0/buckets/b/heartbeat?pulsetime=0',
    '/api/0/buckets/b/heartbeat?pulsetime=60',
  ]);
  assert.equal(h.paths().filter(p => p.endsWith('/events')).length, 0,
    'POST /events leaves the ghost in place, so it is never the reset');
});

test('a bucket that already existed is beaten straight away', async () => {
  const h = harness({ server: (url) => (/\/api\/0\/buckets\/[^/]+$/.test(url) ? 304 : 200) });
  await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60);
  assert.deepEqual(h.paths(), ['/api/0/buckets/b', '/api/0/buckets/b/heartbeat?pulsetime=60']);
});

test('a bucket re-created after a 404 gets its first beat with no merge window again', async () => {
  let deleted = false;
  const h = harness({ server: (url) => (deleted && url.includes('/heartbeat') ? 404 : 200) });
  await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60);
  await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60);
  deleted = true;
  await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60);
  deleted = false;
  await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60);
  assert.deepEqual(h.paths().slice(-2), ['/api/0/buckets/b', '/api/0/buckets/b/heartbeat?pulsetime=0']);
});

test('a first beat that fails leaves the bucket marked, so the retry has no merge window either', async () => {
  let failBeats = true;
  const h = harness({ server: (url) => {
    if (/\/api\/0\/buckets\/[^/]+$/.test(url)) return failBeats ? 200 : 304;   // created, then already there
    return failBeats ? 400 : 200;
  } });
  assert.equal(await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60), false);
  failBeats = false;
  await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60);
  const beats = h.paths().filter(p => p.includes('/heartbeat'));
  assert.deepEqual(beats, ['/api/0/buckets/b/heartbeat?pulsetime=0', '/api/0/buckets/b/heartbeat?pulsetime=0']);
});

test('a first beat that never arrives leaves the bucket marked too', async () => {
  let down = true;
  // The re-create after the outage answers 304, as a server that kept the
  // bucket does — a 200 would re-mark it and hide a lost mark.
  const h = harness({ server: (url) => {
    if (/\/api\/0\/buckets\/[^/]+$/.test(url)) return down ? 200 : 304;
    return down ? 'down' : 200;
  } });
  await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60);
  h.advance(MAX_COOLDOWN_MS);
  down = false;
  await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60);
  assert.equal(h.paths().filter(p => p.endsWith('pulsetime=0')).length, 2);
});

test('a span still under its old id is found when the old id comes first', async () => {
  const h = spanHarness({ stored: [{ id: 8, data: { session: 'tmp' } }] });
  await h.client.upsertSpan('r', BUCKET, { session: 'real' }, START, 60, { key: 'session', values: ['tmp', 'real'] });
  assert.equal(h.eventPosts()[0].body[0].id, 8);
});

test('a span write the server refuses reports failure', async () => {
  const posts = [];
  const client = createActivityWatchClient({
    hostname: 'h',
    fetchFn: async (url, opts) => {
      if (!opts || !opts.method) return { ok: true, status: 200, json: async () => [] };
      posts.push(url);
      return url.endsWith('/events') ? { ok: false, status: 500 } : { ok: true, status: 200 };
    },
  });
  assert.equal(await client.upsertSpan('r', BUCKET, { session: 'A' }, START, 60, { key: 'session', values: ['A'] }), false);
});

test('a 500 on the bucket create is a server that cannot take writes, and backs off', async () => {
  const h = harness({ server: 500 });
  await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60);
  assert.equal(h.client.sleeping, true);
});

// A beat can meet a 500 while aw-server's cached last event is out of step
// with a re-created bucket; the other bucket must keep being written.
test('a 500 on one bucket\'s beat does not stop writes to the other', async () => {
  const h = harness({ server: (url) => (url.includes('/buckets/a/heartbeat') ? 500 : /\/api\/0\/buckets\/[^/]+$/.test(url) ? 304 : 200) });
  assert.equal(await h.client.heartbeat('a', BUCKET, { project: 'x' }, 60), false);
  assert.equal(h.client.sleeping, false);
  assert.equal(await h.client.heartbeat('b', BUCKET, { project: 'x' }, 60), true);
});

test('once made inactive, a write already past its lookup sends nothing more', async () => {
  let release;
  const held = new Promise(r => { release = r; });
  const sent = [];
  const client = createActivityWatchClient({
    hostname: 'h', now: () => 0,
    fetchFn: async (url, opts) => {
      sent.push(`${(opts && opts.method) || 'GET'} ${url}`);
      if (/\/api\/0\/buckets\/[^/]+$/.test(url)) return { status: 304 };
      if (!opts.method) { await held; return { status: 200, json: async () => [] }; }
      return { status: 200 };
    },
  });
  const write = client.upsertSpan('b', BUCKET, { session: 's' }, 1000, 5, { key: 'session', values: ['s'] });
  await new Promise(r => setImmediate(r));
  client.setActive(false);
  release();
  assert.equal(await write, false);
  assert.equal(sent.filter(l => l.startsWith('POST') && l.endsWith('/events')).length, 0);
  assert.equal(await client.probe(), true, 'a probe still answers, for the Settings panel');
});
