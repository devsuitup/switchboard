'use strict';

// local-transcript-activity.js: the pure factory behind the local-transcript
// adapter's main-process signal — see .ai/contexts/session-state.md
// (migration step 4). Properties proven here:
//   1. A watch `filename` split that isn't exactly `<folder>/<sessionId>.jsonl`
//      (a subagent leg, a non-.jsonl file, a non-UUID name) never resolves to a
//      session id.
//   2. A session id resolved from the watch event, but reported by hasPty() as
//      already carrying a PTY in this app, is skipped — the OSC path owns it.
//   3. A first sighting of an eligible session is always forwarded.
//   4. A second sighting inside the 1s coalescing window is swallowed.
//   5. Once the window has passed, the next sighting is forwarded again.
//   6. Two distinct sessions never share coalescing state.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createLocalTranscriptTracker, sessionIdFromWatchParts } = require('../local-transcript-activity');

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

function clock(startAt = 1000) {
  let t = startAt;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('sessionIdFromWatchParts accepts a bare top-level transcript, rejects a subagent leg and non-transcripts', () => {
  assert.equal(sessionIdFromWatchParts(['folder-name', `${UUID_A}.jsonl`]), UUID_A);
  assert.equal(sessionIdFromWatchParts(['folder-name', UUID_A, 'subagents', 'agent-7.jsonl']), null,
    'a subagent leg has more than two segments — out of scope for step 4');
  assert.equal(sessionIdFromWatchParts(['folder-name', UUID_A, 'agent-7.jsonl']), null,
    'the legacy nested subagent layout also has more than two segments');
  assert.equal(sessionIdFromWatchParts(['folder-name', 'sessions-index.json']), null, 'not a .jsonl file');
  assert.equal(sessionIdFromWatchParts(['folder-name', 'not-a-uuid.jsonl']), null, 'basename is not a session id');
  assert.equal(sessionIdFromWatchParts(['folder-name']), null, 'a bare top-level folder event, not a file');
  assert.equal(sessionIdFromWatchParts(null), null);
});

test('record() forwards the first sighting of an eligible session', () => {
  const c = clock(5000);
  const tracker = createLocalTranscriptTracker({ now: c.now });
  const result = tracker.record(['folder-name', `${UUID_A}.jsonl`]);
  assert.deepEqual(result, { sessionId: UUID_A, at: 5000 });
});

test('record() never forwards for a session that already has a PTY in this app', () => {
  const c = clock(0);
  const tracker = createLocalTranscriptTracker({ now: c.now, hasPty: (id) => id === UUID_A });
  assert.equal(tracker.record(['folder-name', `${UUID_A}.jsonl`]), null,
    'the OSC path already owns a row with a live PTY');
  assert.ok(tracker.record(['folder-name', `${UUID_B}.jsonl`]),
    'a different session with no PTY is unaffected');
});

test('record() coalesces a second sighting inside the 1s window, then forwards again once it has elapsed', () => {
  const c = clock(0);
  const tracker = createLocalTranscriptTracker({ now: c.now, ipcMinMs: 1000 });
  const parts = ['folder-name', `${UUID_A}.jsonl`];

  assert.ok(tracker.record(parts), 'first sighting always forwards');
  c.advance(400);
  assert.equal(tracker.record(parts), null, 'a sighting inside the coalescing window must not forward again');

  c.advance(700); // total 1100ms since the first forward
  const third = tracker.record(parts);
  assert.ok(third, 'once ipcMinMs has elapsed since the last forward, the next sighting forwards again');
  assert.equal(third.at, 1100);
});

test('two sessions never share coalescing state', () => {
  const c = clock(0);
  const tracker = createLocalTranscriptTracker({ now: c.now, ipcMinMs: 1000 });
  assert.ok(tracker.record(['folder-name', `${UUID_A}.jsonl`]));
  assert.ok(tracker.record(['folder-name', `${UUID_B}.jsonl`]),
    'session B has never been seen — its own throttle window must be independent of A');
});
