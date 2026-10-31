'use strict';

// remote-activity.js: the uncoalesced transcript-write signal that feeds the
// sidebar's busy spinner. Properties proven here (issue #242, see
// .ai/contexts/session-cache.md, "Remote hosts — busy spinner (issue #242)"):
//   1. A rel that doesn't decode to a plausible session id is dropped.
//   2. A first sighting of a session is always forwarded.
//   3. A second sighting inside the throttle window is swallowed, not forwarded.
//   4. Once the throttle window has passed, the next sighting is forwarded again.
//   5. activeAt reports null once a session has been silent past the decay window.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRemoteActivityTracker, sessionIdFromRel } = require('../remote-activity');
const { REMOTE_PROJECTS_REL } = require('../src/main/remote/remote-transport');

const UUID = '11111111-1111-4111-8111-111111111111';

function clock(startAt = 1000) {
  let t = startAt;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('sessionIdFromRel accepts a bare session transcript, rejects a subagent leg', () => {
  assert.equal(sessionIdFromRel(`-srv-a/${UUID}.jsonl`), UUID);
  assert.equal(sessionIdFromRel(`-srv-a/${UUID}/subagents/agent-7.jsonl`), null,
    'the basename here is "agent-7", not a session id — must not be guessed at');
  assert.equal(sessionIdFromRel('-srv-a/not-a-uuid.jsonl'), null);
  assert.equal(sessionIdFromRel(''), null);
  assert.equal(sessionIdFromRel(undefined), null);
});

test('record() drops a malformed rel instead of forwarding a guess', () => {
  const tracker = createRemoteActivityTracker({ now: clock().now });
  assert.equal(tracker.record('vps', `${REMOTE_PROJECTS_REL}/-srv-a/agent-7.jsonl`), null);
  assert.equal(tracker.activeAt('vps', 'agent-7'), null, 'nothing must have been recorded for the rejected id');
});

test('record() forwards the first sighting of a session', () => {
  const c = clock(5000);
  const tracker = createRemoteActivityTracker({ now: c.now });
  const result = tracker.record('vps', `-srv-a/${UUID}.jsonl`);
  assert.deepEqual(result, { alias: 'vps', sessionId: UUID, at: 5000 });
});

test('record() throttles a second sighting inside the 1s window, but keeps activeAt fresh', () => {
  const c = clock(0);
  const tracker = createRemoteActivityTracker({ now: c.now, ipcMinMs: 1000 });
  const rel = `-srv-a/${UUID}.jsonl`;

  assert.ok(tracker.record('vps', rel), 'first sighting always forwards');
  c.advance(400);
  assert.equal(tracker.record('vps', rel), null, 'a sighting inside the throttle window must not forward again');
  // The suppressed sighting still counts as activity for the decay clock.
  assert.equal(tracker.activeAt('vps', UUID), 400);

  c.advance(700); // total 1100ms since the first forward
  const third = tracker.record('vps', rel);
  assert.ok(third, 'once ipcMinMs has elapsed since the last forward, the next sighting forwards again');
  assert.equal(third.at, 1100);
});

test('activeAt reports null once a session has gone silent past the decay window', () => {
  const c = clock(0);
  const tracker = createRemoteActivityTracker({ now: c.now, decayMs: 20000 });
  tracker.record('vps', `-srv-a/${UUID}.jsonl`);

  c.advance(19999);
  assert.equal(tracker.activeAt('vps', UUID), 0, 'still inside the decay window');

  c.advance(2); // 20001ms since the sighting
  assert.equal(tracker.activeAt('vps', UUID), null, 'past the decay window, the pip must clear');
});

test('two hosts never share activity state for the same session id', () => {
  const tracker = createRemoteActivityTracker({ now: clock(0).now });
  tracker.record('vps-a', `-srv-a/${UUID}.jsonl`);
  assert.equal(tracker.activeAt('vps-b', UUID), null, 'alias must be part of the key, not just the session id');
});

// Subagent attribution (issue #247) — see .ai/contexts/subagent-observability.md.
// Previously sessionIdFromRel simply dropped a subagent leg (basename
// "agent-N", not a UUID); record() now attributes it to its parent instead.

test('record() attributes a subagent leg to its parent instead of dropping it', () => {
  const c = clock(5000);
  const tracker = createRemoteActivityTracker({ now: c.now });
  const result = tracker.record('vps', `-srv-a/${UUID}/subagents/agent-7.jsonl`);
  assert.deepEqual(result, { alias: 'vps', parentSessionId: UUID, agentId: '7', at: 5000, kind: 'subagent' });
});

test('record() attributes the legacy subagent layout too', () => {
  const c = clock(5000);
  const tracker = createRemoteActivityTracker({ now: c.now });
  const result = tracker.record('vps', `-srv-a/${UUID}/agent-7.jsonl`);
  assert.deepEqual(result, { alias: 'vps', parentSessionId: UUID, agentId: '7', at: 5000, kind: 'subagent' });
});

test('record() throttles repeated subagent attribution for the same parent, independently per alias', () => {
  const c = clock(0);
  const tracker = createRemoteActivityTracker({ now: c.now, ipcMinMs: 1000 });
  const rel = `-srv-a/${UUID}/subagents/agent-1.jsonl`;

  assert.ok(tracker.record('vps', rel), 'first sighting always forwards');
  c.advance(400);
  assert.equal(tracker.record('vps', rel), null, 'a sighting inside the throttle window must not forward again');
  assert.ok(tracker.record('vps-b', rel), 'a different alias is not throttled by vps\'s window');

  c.advance(700); // total 1100ms since the first forward
  const third = tracker.record('vps', rel);
  assert.ok(third, 'once ipcMinMs has elapsed, the next sighting forwards again');
  assert.equal(third.at, 1100);
});

test('neither map grows without bound: both are pruned past the decay window', () => {
  let t = 1000;
  const tracker = createRemoteActivityTracker({ now: () => t, decayMs: 20000, ipcMinMs: 1000 });
  for (let i = 0; i < 50; i++) {
    tracker.record('vps', `-srv-a/${String(i).padStart(8, '0')}-1111-2222-3333-444444444444.jsonl`);
    t += 10;
  }
  const filled = tracker.stats();
  assert.equal(filled.seen, 50);
  assert.equal(filled.ipc, 50, 'every distinct session took an IPC slot');

  t += 30000;
  tracker.record('vps', '-srv-a/99999999-1111-2222-3333-444444444444.jsonl');
  const pruned = tracker.stats();
  assert.equal(pruned.seen, 1, 'stale sightings must be dropped');
  assert.equal(pruned.ipc, 1, 'stale throttle entries must be dropped too, or the map leaks one entry per session seen');
});

function timedTracker(t, opts = {}) {
  const c = clock(0);
  const timers = new Set();
  const events = [];
  const tracker = createRemoteActivityTracker({ ...opts, now: c.now, ipcMinMs: 50,
    onActivity: event => events.push(event),
    setTimeout: (fn, ms) => { const timer = { fn, at: c.now() + ms }; timers.add(timer); return timer; },
    clearTimeout: timer => timers.delete(timer),
  });
  t.after(() => tracker.dispose?.());
  return { tracker, events, timers, advance: ms => {
    c.advance(ms);
    for (const timer of [...timers]) {
      if (timer.at > c.now()) continue;
      timers.delete(timer);
      timer.fn();
    }
  } };
}

test('three remote children retain independent leading and final updates per parent and host', t => {
  const f = timedTracker(t);
  const rels = ['A', 'B', 'C'].map(id => `folder/${UUID}/subagents/agent-${id}.jsonl`);
  for (const rel of rels) assert.ok(f.tracker.record('vps', rel));
  f.advance(10);
  for (const rel of rels) assert.equal(f.tracker.record('vps', rel), null);
  assert.ok(f.tracker.record('other-host', rels[0]));
  assert.ok(f.tracker.record('vps', 'folder/other-parent/subagents/agent-A.jsonl'));
  assert.ok(f.tracker.record('vps', `folder/${UUID}.jsonl`));
  assert.equal(f.events.length, 6);
  f.advance(40);
  assert.deepEqual(f.events.slice(6).map(e => [e.agentId, e.at]), [['A', 10], ['B', 10], ['C', 10]]);
  f.advance(50);
  assert.equal(f.events.length, 9, 'one trailing event per identity');
});

test('remote parent final activity is delivered and dispose cancels queued work', t => {
  const f = timedTracker(t);
  const rel = `folder/${UUID}.jsonl`;
  f.tracker.record('vps', rel);
  f.advance(10);
  f.tracker.record('vps', rel);
  f.advance(40);
  assert.deepEqual(f.events.map(e => e.at), [0, 10]);
  f.tracker.record('vps', rel);
  f.tracker.dispose();
  assert.equal(f.timers.size, 0);
  f.advance(50);
  assert.equal(f.tracker.record('vps', rel), null);
  assert.equal(f.events.length, 2);
});

test('remote capacity and idle expiry release per-agent throttle and pending timers', t => {
  const f = timedTracker(t, { maxEntries: 2, decayMs: 100 });
  const a = `folder/${UUID}/agent-A.jsonl`;
  const b = `folder/${UUID}/agent-B.jsonl`;
  const c = `folder/${UUID}/agent-C.jsonl`;
  f.tracker.record('vps', a);
  f.tracker.record('vps', b);
  f.tracker.record('vps', a);
  assert.equal(f.timers.size, 1);
  f.tracker.record('vps', c);
  assert.equal(f.tracker.stats().ipc, 2);
  assert.equal(f.timers.size, 1, 'recent A survives eviction of idle B');
  f.advance(50);
  assert.equal(f.events.length, 4);
  f.advance(101);
  assert.deepEqual(f.tracker.stats(), { seen: 0, ipc: 0 });
  assert.equal(f.timers.size, 0);
  assert.ok(f.tracker.record('vps', a), 'expired identities regain a leading event');
});

test('queued remote delivery does not extend the top-level liveness decay window', t => {
  const f = timedTracker(t, { decayMs: 10 });
  const rel = `folder/${UUID}.jsonl`;
  f.tracker.record('vps', rel);
  f.advance(5);
  f.tracker.record('vps', rel);
  f.advance(11);
  assert.equal(f.tracker.activeAt('vps', UUID), null, 'pending delivery is not new filesystem activity');
  f.advance(34);
  assert.equal(f.events.length, 2, 'the final observed update still arrives');
});
