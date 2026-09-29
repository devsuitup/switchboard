// Two buckets that must stay separable: the focused session is the user's
// attention, and every running session is work that happened whether or not
// anyone was looking. The tests hold the separation, the exact span of each
// event, and that nothing at all is sent while the feature is off.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createActivityWatchReporter, KEEPALIVE_MS, PULSETIME_SECONDS, CHECKPOINT_MS } = require('../activitywatch-reporter');

// `events` is what the server holds, not what was sent: upsertSpan is modelled
// the way aw-server behaves — an event found by start time and match value is
// replaced, otherwise one is added.
function harness() {
  const beats = [];
  const events = [];
  const writes = [];
  const timers = [];
  let clock = Date.UTC(2026, 0, 1, 6, 0, 0);

  const client = {
    heartbeat: async (id, bucket, data, pulsetime) => { beats.push({ id, bucket, data, pulsetime, at: clock }); return true; },
    upsertSpan: async (id, bucket, data, startedAt, duration, match) => {
      writes.push({ id, data, startedAt, duration, match });
      const existing = events.find(e => e.id === id && e.startedAt === startedAt && match.values.includes(e.data[match.key]));
      if (existing) { existing.data = data; existing.duration = duration; existing.bucket = bucket; }
      else events.push({ id, bucket, data, startedAt, duration });
      return true;
    },
  };
  const reporter = createActivityWatchReporter({
    client,
    hostname: 'host',
    now: () => clock,
    setIntervalFn: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearIntervalFn: (t) => { t.cleared = true; },
  });

  return {
    reporter, beats, events, writes,
    advance: (ms) => { clock += ms; },
    at: () => clock,
    liveTimers: (ms) => timers.filter(t => !t.cleared && (ms === undefined || t.ms === ms)),
    tick: async (ms) => { for (const t of timers.filter(x => !x.cleared && (ms === undefined || x.ms === ms))) await t.fn(); },
    settle: () => new Promise(r => setImmediate(r)),
  };
}

const A = { sessionId: 'sA', name: 'dev-panel', project: '/w/switchboard' };
const B = { sessionId: 'sB', name: 'builder', project: '/w/platform' };

// --- Off means off ---

test('while disabled, nothing is sent from any entry point', async () => {
  const h = harness();
  await h.reporter.focus(A);
  h.reporter.sessionStarted(A);
  h.advance(60000);
  await h.reporter.sessionEnded(A.sessionId);
  await h.reporter.flush();
  assert.equal(h.beats.length + h.events.length, 0);
  assert.equal(h.liveTimers().length, 0, 'and no timer is left running');
});

// --- The two buckets ---

test('the two buckets have distinct ids and distinct types', async () => {
  const h = harness();
  h.reporter.setEnabled(true);
  await h.reporter.focus(A);
  h.reporter.sessionStarted(A);
  await h.reporter.sessionEnded(A.sessionId);

  assert.equal(h.beats[0].id, 'aw-watcher-switchboard_host');
  assert.equal(h.events[0].id, 'aw-watcher-switchboard-running_host');
  // The ActivityWatch UI picks editor buckets by type, so a running bucket of
  // the same type would be summed into the attention view.
  assert.equal(h.beats[0].bucket.type, 'app.editor.activity');
  assert.equal(h.events[0].bucket.type, 'app.session.running');
});

// --- Attention ---

test('focusing a session beats it with project and name, at a pulsetime above the keepalive', async () => {
  const h = harness();
  h.reporter.setEnabled(true);
  await h.reporter.focus(A);
  assert.deepEqual(h.beats.map(b => b.data), [{ project: 'switchboard', path: '/w/switchboard', session: 'sA', title: 'dev-panel', file: 'dev-panel' }]);
  assert.ok(PULSETIME_SECONDS * 1000 > KEEPALIVE_MS, 'a pulsetime under the keepalive would fragment every event');
});

test('re-reporting the same focus sends nothing', async () => {
  const h = harness();
  h.reporter.setEnabled(true);
  await h.reporter.focus(A);
  await h.reporter.focus({ ...A });
  assert.equal(h.beats.length, 1);
});

test('switching focus closes the outgoing session at the switch, then opens the next', async () => {
  const h = harness();
  h.reporter.setEnabled(true);
  await h.reporter.focus(A);
  h.advance(20000);
  await h.reporter.focus(B);

  assert.deepEqual(h.beats.map(b => [b.data.file, b.at - h.beats[0].at]), [
    ['dev-panel', 0],
    ['dev-panel', 20000],   // the close — without it A's span ends at its last keepalive
    ['builder', 20000],
  ]);
});

test('the keepalive re-beats the focused session, and only that one', async () => {
  const h = harness();
  h.reporter.setEnabled(true);
  await h.reporter.focus(A);
  await h.reporter.focus(B);
  assert.equal(h.liveTimers(KEEPALIVE_MS).length, 1, 'one keepalive, however many switches');

  const before = h.beats.length;
  await h.tick(KEEPALIVE_MS);
  assert.equal(h.beats.length, before + 1);
  assert.equal(h.beats.at(-1).data.file, 'builder');
});

test('losing focus closes the session and stops the keepalive', async () => {
  const h = harness();
  h.reporter.setEnabled(true);
  await h.reporter.focus(A);
  h.advance(5000);
  await h.reporter.focus(null);

  assert.equal(h.beats.length, 2, 'the open and the close');
  assert.equal(h.beats[1].at - h.beats[0].at, 5000);
  assert.equal(h.liveTimers(KEEPALIVE_MS).length, 0);
});

test('a session with no name is still reported, under its id', async () => {
  const h = harness();
  h.reporter.setEnabled(true);
  await h.reporter.focus({ sessionId: 'sX', project: '/w/p' });
  assert.equal(h.beats[0].data.file, 'sX');
});

// --- Running ---

test('a session that ran is written once, as its whole span', async () => {
  const h = harness();
  h.reporter.setEnabled(true);
  const started = h.at();
  h.reporter.sessionStarted(A);
  h.advance(90000);
  await h.reporter.sessionEnded(A.sessionId);

  assert.equal(h.events.length, 1, 'one event on the server, however many writes');
  assert.equal(h.events[0].startedAt, started);
  assert.equal(h.events[0].duration, 90);
  assert.equal(h.beats.length, 0, 'running sessions never go through the heartbeat path');
});

// The reason for events rather than heartbeats: the server merges a heartbeat
// only against the bucket's last event, so two sessions interleaved would each
// write a zero-duration event per beat.
test('two sessions running at once become two overlapping events with their own spans', async () => {
  const h = harness();
  h.reporter.setEnabled(true);
  const t0 = h.at();
  h.reporter.sessionStarted(A);
  h.advance(30000);
  h.reporter.sessionStarted(B);
  h.advance(30000);
  await h.reporter.sessionEnded(A.sessionId);
  h.advance(30000);
  await h.reporter.sessionEnded(B.sessionId);

  const byId = Object.fromEntries(h.events.map(e => [e.data.session, e]));
  assert.equal(byId.sA.startedAt, t0);
  assert.equal(byId.sA.duration, 60);
  assert.equal(byId.sB.startedAt, t0 + 30000);
  assert.equal(byId.sB.duration, 60);
  assert.ok(byId.sB.startedAt < byId.sA.startedAt + byId.sA.duration * 1000, 'they overlap');
});

test('a running session carries the name the user last saw for it', async () => {
  const h = harness();
  h.reporter.setEnabled(true);
  h.reporter.sessionStarted(A);
  await h.reporter.focus(A);
  await h.reporter.sessionEnded(A.sessionId);
  assert.equal(h.events[0].data.title, 'dev-panel');
});

test('a session never focused is written without a name rather than a guessed one', async () => {
  const h = harness();
  h.reporter.setEnabled(true);
  h.reporter.sessionStarted({ sessionId: B.sessionId, project: B.project });   // as main starts a PTY session
  await h.reporter.sessionEnded(B.sessionId);
  assert.deepEqual(h.events[0].data, { project: 'platform', path: '/w/platform', session: 'sB' });
});

test('a session started with a name carries it without ever being focused', async () => {
  const h = harness();
  h.reporter.setEnabled(true);
  h.reporter.sessionStarted({ sessionId: 'schedule:nightly', project: '/w/p', name: 'Scheduled: nightly' });
  await h.reporter.sessionEnded('schedule:nightly');
  assert.equal(h.events[0].data.title, 'Scheduled: nightly');
});

test('flush writes every live session as a span ending now', async () => {
  const h = harness();
  h.reporter.setEnabled(true);
  h.reporter.sessionStarted(A);
  h.advance(10000);
  h.reporter.sessionStarted(B);
  h.advance(10000);
  await h.reporter.flush();

  assert.deepEqual(h.events.map(e => [e.data.session, e.duration]).sort(), [['sA', 20], ['sB', 10]]);
});

test('ending a session twice, or one never started, writes nothing', async () => {
  const h = harness();
  h.reporter.setEnabled(true);
  h.reporter.sessionStarted(A);
  await h.reporter.sessionEnded(A.sessionId);
  await h.reporter.sessionEnded(A.sessionId);
  await h.reporter.sessionEnded('never');
  assert.equal(h.events.length, 1);
});

test('a session that started while the feature was off is still timed from its real start', async () => {
  const h = harness();
  const started = h.at();
  h.reporter.sessionStarted(A);
  h.advance(40000);
  h.reporter.setEnabled(true);
  h.advance(20000);
  await h.reporter.sessionEnded(A.sessionId);
  assert.equal(h.events[0].startedAt, started);
  assert.equal(h.events[0].duration, 60);
});

test('disabling stops the keepalive, and re-enabling resumes on the current focus', async () => {
  const h = harness();
  h.reporter.setEnabled(true);
  await h.reporter.focus(A);
  h.reporter.setEnabled(false);
  assert.equal(h.liveTimers().length, 0, 'off leaves no timer of any kind');

  const before = h.beats.length;
  h.reporter.setEnabled(true);
  assert.equal(h.beats.length, before + 1);
  assert.equal(h.liveTimers(KEEPALIVE_MS).length, 1);
});

// --- Re-keying ---

test('a re-keyed session is written under its new id, keeping its start and name', async () => {
  const h = harness();
  h.reporter.setEnabled(true);
  const started = h.at();
  h.reporter.sessionStarted({ sessionId: 'tmp', project: '/w/p' });
  await h.reporter.focus({ sessionId: 'tmp', name: 'forked', project: '/w/p' });
  h.reporter.rekey('tmp', 'real');
  h.advance(30000);
  await h.reporter.sessionEnded('real');

  assert.equal(h.events.length, 1);
  assert.deepEqual(h.events[0].data, { session: 'real', project: 'p', path: '/w/p', title: 'forked' });
  assert.equal(h.events[0].startedAt, started);
  assert.equal(await h.reporter.sessionEnded('tmp'), false, 'the old id is gone');
});

test('re-keying the focused session does not break the next switch', async () => {
  const h = harness();
  h.reporter.setEnabled(true);
  await h.reporter.focus({ sessionId: 'tmp', name: 'forked', project: '/w/p' });
  h.reporter.rekey('tmp', 'real');
  // The renderer now reports the session under its real id: same session, no switch.
  const before = h.beats.length;
  await h.reporter.focus({ sessionId: 'real', name: 'forked', project: '/w/p' });
  assert.equal(h.beats.length, before, 'no spurious close-and-reopen');
});

// --- Quitting: closing the window kills the PTYs before before-quit, and
// each exit reaches the reporter asynchronously ---

// A client whose writes stay pending until the gate opens, to stage the
// orderings. Once open, it stays open: a session's writes are chained, so the
// later ones are only issued after the earlier ones resolve.
function slowHarness() {
  const events = [];
  const pending = [];
  let open = false;
  let clock = Date.UTC(2026, 0, 1, 6, 0, 0);
  const client = {
    heartbeat: async () => true,
    upsertSpan: (id, bucket, data, startedAt, duration, match) => new Promise((resolve) => {
      const apply = () => {
        const existing = events.find(e => e.startedAt === startedAt && match.values.includes(e.data[match.key]));
        if (existing) { existing.data = data; existing.duration = duration; }
        else events.push({ data, startedAt, duration });
        resolve(true);
      };
      if (open) apply(); else pending.push(apply);
    }),
  };
  const reporter = createActivityWatchReporter({
    client, hostname: 'host', now: () => clock,
    setIntervalFn: () => ({}), clearIntervalFn: () => {},
  });
  return {
    reporter,
    events,
    // The first write is issued on a microtask, so the gate opens a turn later.
    releaseAll: async () => {
      await new Promise(r => setImmediate(r));
      open = true;
      while (pending.length) pending.shift()();
    },
    advance: (ms) => { clock += ms; },
  };
}

test('an exit that landed before the quit still holds it until its write is acknowledged', { timeout: 5000 }, async () => {
  const h = slowHarness();
  h.reporter.setEnabled(true);
  h.reporter.sessionStarted(A);
  h.advance(10000);
  h.reporter.sessionEnded(A.sessionId);   // not awaited, as the PTY exit handler does not

  assert.equal(h.reporter.hasPendingWork, true, 'but the quit must still wait for its write');

  const flushed = h.reporter.flush();
  await h.releaseAll();
  await flushed;
  assert.equal(h.events.length, 1);
  assert.equal(h.reporter.hasPendingWork, false);
});

test('an exit that lands during the flush does not write the session a second time', { timeout: 5000 }, async () => {
  const h = harness();
  h.reporter.setEnabled(true);
  h.reporter.sessionStarted(A);
  h.reporter.sessionStarted(B);
  h.advance(10000);

  const flushed = h.reporter.flush();
  await h.reporter.sessionEnded(A.sessionId);   // the late PTY exit
  await h.reporter.sessionEnded(B.sessionId);
  await flushed;

  assert.deepEqual(h.events.map(e => e.data.session).sort(), ['sA', 'sB'], 'each session once');
});

test('with reporting off there is never pending work, so the quit is never held', () => {
  const h = harness();
  h.reporter.sessionStarted(A);
  assert.equal(h.reporter.hasPendingWork, false);
});

test('a write that fails still settles, so it cannot hold the quit forever', { timeout: 5000 }, async () => {
  const reporter = createActivityWatchReporter({
    client: { heartbeat: async () => true, upsertSpan: async () => { throw new Error('boom'); } },
    hostname: 'host', setIntervalFn: () => ({}), clearIntervalFn: () => {},
  });
  reporter.setEnabled(true);
  reporter.sessionStarted(A);
  await reporter.sessionEnded(A.sessionId);
  await new Promise(r => setImmediate(r));
  assert.equal(reporter.hasPendingWork, false);
});

// --- Checkpoints: a running session is on the server while it runs, so a
// crash loses at most the last minute rather than the whole session ---

test('a session is on the server from the moment it starts', async () => {
  const h = harness();
  h.reporter.setEnabled(true);
  h.reporter.sessionStarted(A);
  await h.settle();
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].duration, 0);
});

test('each checkpoint extends the same event rather than adding one', async () => {
  const h = harness();
  h.reporter.setEnabled(true);
  h.reporter.sessionStarted(A);
  for (let i = 1; i <= 3; i++) {
    h.advance(CHECKPOINT_MS);
    await h.tick(CHECKPOINT_MS);
    await h.settle();
    assert.equal(h.events.length, 1, `still one event after ${i} checkpoint(s)`);
    assert.equal(h.events[0].duration, i * CHECKPOINT_MS / 1000);
  }
});

test('a crash leaves the span as of the last checkpoint', async () => {
  const h = harness();
  h.reporter.setEnabled(true);
  h.reporter.sessionStarted(A);
  h.advance(5 * CHECKPOINT_MS);
  await h.tick(CHECKPOINT_MS);
  await h.settle();
  h.advance(40000);
  // The process dies here: no sessionEnded, no flush.
  assert.equal(h.events[0].duration, 300, 'five minutes are on the server; only the last 40 s are lost');
});

test('concurrent sessions each grow their own event', async () => {
  const h = harness();
  h.reporter.setEnabled(true);
  h.reporter.sessionStarted(A);
  h.advance(30000);
  h.reporter.sessionStarted(B);
  h.advance(30000);
  await h.tick(CHECKPOINT_MS);
  await h.settle();
  const byId = Object.fromEntries(h.events.map(e => [e.data.session, e.duration]));
  assert.deepEqual(byId, { sA: 60, sB: 30 });
});

test('the checkpoint timer exists only while reporting is on', () => {
  const h = harness();
  h.reporter.sessionStarted(A);
  assert.equal(h.liveTimers(CHECKPOINT_MS).length, 0);
  h.reporter.setEnabled(true);
  assert.equal(h.liveTimers(CHECKPOINT_MS).length, 1);
  h.reporter.setEnabled(false);
  assert.equal(h.liveTimers(CHECKPOINT_MS).length, 0);
});

test('turning reporting on writes the sessions already running at once', async () => {
  const h = harness();
  h.reporter.sessionStarted(A);
  h.advance(45000);
  h.reporter.setEnabled(true);
  await h.settle();
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].duration, 45, 'not a minute later, and timed from its real start');
});

// Written under its temporary id, then re-keyed: the next write must find the
// event by the id it carries on the server, or it inserts a second one.
test('a re-key after a checkpoint updates the same event, which then carries the real id', async () => {
  const h = harness();
  h.reporter.setEnabled(true);
  h.reporter.sessionStarted({ sessionId: 'tmp', project: '/w/p' });
  h.advance(CHECKPOINT_MS);
  await h.tick(CHECKPOINT_MS);
  await h.settle();
  h.reporter.rekey('tmp', 'real');
  h.advance(CHECKPOINT_MS);
  await h.tick(CHECKPOINT_MS);
  await h.settle();

  assert.equal(h.events.length, 1, 'no second event for the same span');
  assert.equal(h.events[0].data.session, 'real');
  assert.equal(h.events[0].duration, 120);

  h.advance(CHECKPOINT_MS);
  await h.tick(CHECKPOINT_MS);
  await h.settle();
  assert.equal(h.events.length, 1, 'and later writes find it under the new id');
});

test('ending a session writes its final span onto the same event', async () => {
  const h = harness();
  h.reporter.setEnabled(true);
  h.reporter.sessionStarted(A);
  h.advance(CHECKPOINT_MS);
  await h.tick(CHECKPOINT_MS);
  h.advance(25000);
  await h.reporter.sessionEnded(A.sessionId);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].duration, 85);
});

// On the wire an upsert is a lookup, then a write. Two upserts for the same
// session left to overlap would both see "not found" and both insert.
test('two writes for one session never overlap, so they cannot both insert', async () => {
  const events = [];
  const turn = () => new Promise(r => setImmediate(r));
  const reporter = createActivityWatchReporter({
    hostname: 'host',
    setIntervalFn: () => ({}), clearIntervalFn: () => {},
    client: {
      heartbeat: async () => true,
      upsertSpan: async (id, bucket, data, startedAt, duration, match) => {
        await turn();
        const existing = events.find(e => e.startedAt === startedAt && match.values.includes(e.data[match.key]));
        await turn();
        if (existing) { existing.data = data; existing.duration = duration; } else events.push({ data, startedAt, duration });
        return true;
      },
    },
  });
  reporter.setEnabled(true);
  reporter.sessionStarted(A);          // the write at start
  reporter.setEnabled(true);           // an immediate checkpoint, while that write is still out
  await reporter.sessionEnded(A.sessionId);
  await reporter.flush();
  assert.equal(events.length, 1, `one event for one session, got ${events.length}`);
});

// --- Findings from review ---

// On the wire an upsert is a lookup and then a write, with the network between.
function wireHarness({ loseAnswerOf } = {}) {
  const events = [];
  const turn = () => new Promise(r => setImmediate(r));
  let nextId = 1;
  let checkpoint = null;
  const reporter = createActivityWatchReporter({
    hostname: 'host',
    setIntervalFn: (fn, ms) => { if (ms === CHECKPOINT_MS) checkpoint = fn; return {}; },
    clearIntervalFn: () => {},
    client: {
      heartbeat: async () => true,
      upsertSpan: async (id, bucket, data, startedAt, duration, match) => {
        await turn();
        const existing = events.find(e => e.startedAt === startedAt && match.values.includes(e.data[match.key]));
        await turn();
        if (existing) { existing.data = data; existing.duration = duration; } else events.push({ id: nextId++, data, startedAt, duration });
        // The server stored it; the answer never arrived (the 2 s timeout).
        if (loseAnswerOf && loseAnswerOf(data)) { loseAnswerOf = null; return false; }
        return true;
      },
    },
  });
  return { reporter, events, checkpoint: () => checkpoint(), settle: async () => { for (let i = 0; i < 20; i++) await turn(); } };
}

test('a write queued behind the one that renames a span still finds it', async () => {
  const h = wireHarness();
  h.reporter.setEnabled(true);
  h.reporter.sessionStarted({ sessionId: 'A', project: '/p' });
  await h.settle();
  h.reporter.rekey('A', 'B');
  h.checkpoint();                         // renames the event to B — still in flight
  await h.reporter.sessionEnded('B');     // queued behind it
  await h.settle();
  assert.deepEqual(h.events.map(e => e.data.session), ['B'], JSON.stringify(h.events));
});

test('a rename stored but never acknowledged does not lead to a second event', async () => {
  const h = wireHarness({ loseAnswerOf: (data) => data.session === 'B' });
  h.reporter.setEnabled(true);
  h.reporter.sessionStarted({ sessionId: 'A', project: '/p' });
  await h.settle();
  h.reporter.rekey('A', 'B');
  h.checkpoint();                         // stored as B, reported failed
  await h.settle();
  h.checkpoint();                         // must find it under B
  await h.settle();
  assert.equal(h.events.length, 1, JSON.stringify(h.events));
});

test('a re-key while a write is in flight keeps the next write behind it', async () => {
  const h = wireHarness();
  h.reporter.setEnabled(true);
  h.reporter.sessionStarted({ sessionId: 'A', project: '/p' });   // start write in flight
  h.reporter.rekey('A', 'B');
  h.checkpoint();                                                  // must wait for it
  await h.settle();
  assert.equal(h.events.length, 1, JSON.stringify(h.events));
});

test('the keepalive stops crediting a session once nobody has touched the keyboard for 3 minutes', async () => {
  let idle = 0;
  const beats = [];
  let tick = null;
  const reporter = createActivityWatchReporter({
    hostname: 'host',
    idleSeconds: () => idle,
    setIntervalFn: (fn, ms) => { if (ms === KEEPALIVE_MS) tick = fn; return {}; },
    clearIntervalFn: () => {},
    client: { heartbeat: async (id, b, data) => { beats.push(data); return true; }, upsertSpan: async () => true },
  });
  reporter.setEnabled(true);
  await reporter.focus(A);
  const opened = beats.length;
  idle = 179; tick();
  assert.equal(beats.length, opened + 1, 'still at the keyboard');
  idle = 180; tick(); tick();
  assert.equal(beats.length, opened + 1, 'away: no beat, so the event ends at the last one');
  idle = 2; tick();
  assert.equal(beats.length, opened + 2, 'back: beating again');
});

test('the flush starts every span write without waiting for the attention beat', async () => {
  let releaseBeat;
  const upserts = [];
  const reporter = createActivityWatchReporter({
    hostname: 'host',
    setIntervalFn: () => ({}), clearIntervalFn: () => {},
    client: {
      heartbeat: () => new Promise((r) => { releaseBeat = () => r(true); }),
      upsertSpan: async (id, b, data) => { upserts.push(data.session); return true; },
    },
  });
  reporter.setEnabled(true);
  reporter.sessionStarted(B);
  await new Promise(r => setImmediate(r));
  const beforeFocus = upserts.length;
  reporter.focus(A);                  // its beat hangs
  await new Promise(r => setImmediate(r));
  releaseBeat();                      // let focus() settle
  await new Promise(r => setImmediate(r));
  const flushed = reporter.flush();   // the closing beat hangs too
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  assert.ok(upserts.length > beforeFocus, 'the span write went out while the beat was still pending');
  releaseBeat();
  await flushed;
});

test('the flush sends a closing beat for the session on screen', async () => {
  const h = harness();
  h.reporter.setEnabled(true);
  await h.reporter.focus(A);
  const before = h.beats.length;
  await h.reporter.flush();
  assert.equal(h.beats.length, before + 1);
});

test('a name kept for a session no longer on screen and never started is let go', async () => {
  const h = harness();
  h.reporter.setEnabled(true);
  await h.reporter.focus({ sessionId: 'X', name: 'looked at once', project: '/p' });
  await h.reporter.focus(null);
  await h.tick(CHECKPOINT_MS);
  h.reporter.sessionStarted({ sessionId: 'X', project: '/p' });
  await h.reporter.sessionEnded('X');
  assert.equal(h.events[0].data.title, undefined, 'the stale name did not survive the checkpoint');
});

test('starting a session that is already live keeps its original start', async () => {
  const h = harness();
  h.reporter.setEnabled(true);
  const t0 = h.at();
  h.reporter.sessionStarted(A);
  h.advance(30000);
  h.reporter.sessionStarted(A);
  h.advance(30000);
  await h.reporter.sessionEnded(A.sessionId);
  assert.equal(h.events[0].startedAt, t0);
  assert.equal(h.events[0].duration, 60);
});

test('a re-key onto an id already live leaves both spans where they were', async () => {
  const h = harness();
  h.reporter.setEnabled(true);
  const tA = h.at();
  h.reporter.sessionStarted({ sessionId: 'A', project: '/p' });
  h.advance(10000);
  const tB = h.at();
  h.reporter.sessionStarted({ sessionId: 'B', project: '/p' });
  h.reporter.rekey('A', 'B');
  h.advance(10000);
  await h.reporter.sessionEnded('B');
  await h.reporter.sessionEnded('A');
  const start = Object.fromEntries(h.events.map(e => [e.data.session, e.startedAt]));
  assert.deepEqual(start, { A: tA, B: tB });
});

test('a re-key to the same id changes nothing', async () => {
  const h = harness();
  h.reporter.setEnabled(true);
  h.reporter.sessionStarted({ sessionId: 'A', project: '/p' });
  await h.reporter.focus({ sessionId: 'A', name: 'kept', project: '/p' });
  h.reporter.rekey('A', 'A');
  await h.reporter.sessionEnded('A');
  assert.equal(h.events[0].data.title, 'kept');
});

test('stop leaves no timer running', async () => {
  const h = harness();
  h.reporter.setEnabled(true);
  await h.reporter.focus(A);
  assert.ok(h.liveTimers().length > 0);
  h.reporter.stop();
  assert.equal(h.liveTimers().length, 0);
});

// --- Convergence review ---

// writtenAs names the id the event carries on the server. A write that stored
// nothing must not advance it, or the next lookup searches under an id the
// server has never seen and inserts a second event.
test('a write that stored nothing after a re-key leaves the event findable under its old id', async () => {
  const events = [];
  let refuse = false;
  let checkpoint = null;
  const reporter = createActivityWatchReporter({
    hostname: 'host',
    setIntervalFn: (fn, ms) => { if (ms === CHECKPOINT_MS) checkpoint = fn; return {}; },
    clearIntervalFn: () => {},
    client: {
      heartbeat: async () => true,
      upsertSpan: async (id, bucket, data, startedAt, duration, match) => {
        if (refuse) return false;                 // the server was gone: nothing stored
        const existing = events.find(e => e.startedAt === startedAt && match.values.includes(e.data[match.key]));
        if (existing) { existing.data = data; existing.duration = duration; } else events.push({ data, startedAt, duration });
        return true;
      },
    },
  });
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };
  reporter.setEnabled(true);
  reporter.sessionStarted({ sessionId: 'A', project: '/p' });
  await settle();
  reporter.rekey('A', 'B');
  refuse = true;  checkpoint(); await settle();
  refuse = false; checkpoint(); await settle();
  assert.deepEqual(events.map(e => e.data.session), ['B'], JSON.stringify(events));
});

test('the flush does not settle before the closing beat has been answered', async () => {
  let releaseBeat = null;
  const reporter = createActivityWatchReporter({
    hostname: 'host',
    setIntervalFn: () => ({}), clearIntervalFn: () => {},
    client: {
      heartbeat: () => new Promise((r) => { releaseBeat = () => r(true); }),
      upsertSpan: async () => true,
    },
  });
  reporter.setEnabled(true);
  const focused = reporter.focus(A);
  releaseBeat(); await focused;

  let settled = false;
  const flushed = reporter.flush().then(() => { settled = true; });
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  assert.equal(settled, false, 'still waiting on the closing beat');
  releaseBeat();
  await flushed;
  assert.equal(settled, true);
});

test('a write still queued when reporting is turned off is never sent', async () => {
  const sent = [];
  let release;
  const gate = new Promise(r => { release = r; });
  const reporter = createActivityWatchReporter({
    hostname: 'host',
    client: {
      heartbeat: async () => true,
      upsertSpan: async (id, bucket, data, startedAt, duration) => { sent.push(duration); await gate; return true; },
    },
    now: () => 0,
    setIntervalFn: () => ({}),
    clearIntervalFn: () => {},
  });
  reporter.setEnabled(true);
  reporter.sessionStarted(A);
  const ended = reporter.sessionEnded(A.sessionId);   // queued behind the start write
  await new Promise(r => setImmediate(r));            // the start write is on the wire
  reporter.setEnabled(false);
  release();
  assert.equal(await ended, false);
  assert.equal(sent.length, 1, 'only the write already on the wire went out');
});

test('the project is sent by its directory name, and a title on one line, in both buckets', async () => {
  const h = harness();
  h.reporter.setEnabled(true);
  await h.reporter.focus({ sessionId: 'sW', name: 'fix\n  the\tbuild', project: 'C:\\Serveur\\switchboard\\' });
  h.reporter.sessionStarted({ sessionId: 'sW', project: 'C:\\Serveur\\switchboard\\' });
  await h.settle();
  assert.equal(h.beats[0].data.project, 'switchboard');
  assert.equal(h.beats[0].data.title, 'fix the build');
  assert.equal(h.beats[0].data.file, 'fix the build');
  assert.equal(h.events[0].data.project, 'switchboard');
  assert.equal(h.events[0].data.title, 'fix the build');
});

test('a running session never shown gets the title the sidebar gives it, and a session not running gets none', async () => {
  const h = harness();
  h.reporter.setEnabled(true);
  h.reporter.sessionStarted({ sessionId: 'bg', project: '/w/p' });
  h.reporter.titles([{ sessionId: 'bg', name: 'nightly refactor' }, { sessionId: 'gone', name: 'x' }]);
  await h.reporter.sessionEnded('bg');
  assert.equal(h.events.at(-1).data.title, 'nightly refactor');
  h.reporter.sessionStarted({ sessionId: 'gone', project: '/w/p' });
  await h.reporter.sessionEnded('gone');
  assert.equal(h.events.at(-1).data.title, undefined, 'a title sent before the session ran was not kept');
});

test('a title cleared in the sidebar is cleared from the next write', async () => {
  const h = harness();
  h.reporter.setEnabled(true);
  h.reporter.sessionStarted({ sessionId: 'bg', project: '/w/p' });
  h.reporter.titles([{ sessionId: 'bg', name: 'old title' }]);
  h.reporter.titles([{ sessionId: 'bg', name: '' }]);
  await h.reporter.sessionEnded('bg');
  assert.equal(h.events.at(-1).data.title, undefined);
});

test('turning reporting on and off switches the client with it', () => {
  const states = [];
  const reporter = createActivityWatchReporter({
    hostname: 'host',
    client: { heartbeat: async () => true, upsertSpan: async () => true, setActive: (on) => states.push(on) },
    setIntervalFn: () => ({}), clearIntervalFn: () => {},
  });
  reporter.setEnabled(true);
  reporter.setEnabled(false);
  assert.deepEqual(states, [true, false]);
});
