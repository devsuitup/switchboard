'use strict';

// remote-activity.js: the uncoalesced transcript-write signal that feeds the
// sidebar's activity pip. Properties proven here (issue #242, see
// .ai/contexts/session-cache.md, "Remote hosts — activity pip"):
//   1. A rel that doesn't decode to a plausible session id is dropped.
//   2. A first sighting of a session is always forwarded.
//   3. A second sighting inside the throttle window is swallowed, not forwarded.
//   4. Once the throttle window has passed, the next sighting is forwarded again.
//   5. activeAt reports null once a session has been silent past the decay window.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRemoteActivityTracker, sessionIdFromRel } = require('../remote-activity');
const { REMOTE_PROJECTS_REL } = require('../remote-transport');

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
