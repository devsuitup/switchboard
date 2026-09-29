// Two buckets that must stay separable: the focused session is the user's
// attention, and every running session is work that happened whether or not
// anyone was looking. The tests hold the separation, the exact span of each
// event, and that nothing at all is sent while the feature is off.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createActivityWatchReporter, KEEPALIVE_MS, PULSETIME_SECONDS } = require('../activitywatch-reporter');

function harness() {
  const beats = [];
  const events = [];
  const timers = [];
  let clock = Date.UTC(2026, 0, 1, 6, 0, 0);

  const client = {
    heartbeat: async (id, bucket, data, pulsetime) => { beats.push({ id, bucket, data, pulsetime, at: clock }); return true; },
    insertEvent: async (id, bucket, data, startedAt, duration) => { events.push({ id, bucket, data, startedAt, duration }); return true; },
  };
  const reporter = createActivityWatchReporter({
    client,
    hostname: 'host',
    now: () => clock,
    setIntervalFn: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearIntervalFn: (t) => { t.cleared = true; },
  });

  return {
    reporter, beats, events,
    advance: (ms) => { clock += ms; },
    at: () => clock,
    liveTimers: () => timers.filter(t => !t.cleared),
    tick: async () => { for (const t of timers.filter(x => !x.cleared)) await t.fn(); },
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
  assert.deepEqual(h.beats.map(b => b.data), [{ project: '/w/switchboard', file: 'dev-panel' }]);
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
  assert.equal(h.liveTimers().length, 1, 'one timer, however many switches');
  assert.equal(h.liveTimers()[0].ms, KEEPALIVE_MS);

  const before = h.beats.length;
  await h.tick();
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
  assert.equal(h.liveTimers().length, 0);
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

  assert.equal(h.events.length, 1);
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
  assert.equal(h.events[0].data.name, 'dev-panel');
});

test('a session never focused is written without a name rather than a guessed one', async () => {
  const h = harness();
  h.reporter.setEnabled(true);
  h.reporter.sessionStarted(B);
  await h.reporter.sessionEnded(B.sessionId);
  assert.deepEqual(h.events[0].data, { session: 'sB', project: '/w/platform' });
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
  assert.equal(h.liveTimers().length, 0);

  const before = h.beats.length;
  h.reporter.setEnabled(true);
  assert.equal(h.beats.length, before + 1);
  assert.equal(h.liveTimers().length, 1);
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
  assert.deepEqual(h.events[0].data, { session: 'real', project: '/w/p', name: 'forked' });
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
