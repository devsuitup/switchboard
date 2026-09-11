// test/main-local-transcript-wiring.test.js — reads main.js as TEXT and fails
// when the local-transcript wiring (issue #246 step 4) disappears from it.
//
// This proves NOTHING about runtime behaviour beyond the shape of the source:
// the tracker's own coalescing/hasPty properties are exercised in
// test/local-transcript-activity.test.js; this file only pins that main.js
// actually wires the real activeSessions-backed guard into it, on the
// out-of-band path (not the debounced flushChanges()/projects-changed one).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Normalised to LF: this file's own balanced-brace slicing assumes '\n',
// and main.js is checked out with CRLF line endings on Windows.
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');

test('main.js requires local-transcript-activity and wires the real activeSessions-backed PTY guard', () => {
  assert.match(mainSrc, /require\('\.\/local-transcript-activity'\)/,
    'main.js must require ./local-transcript-activity');
  assert.match(
    mainSrc,
    /createLocalTranscriptTracker\(\s*\{\s*hasPty:\s*sessionHasPty\s*\}\s*\)/,
    'the tracker must be constructed with the real sessionHasPty guard, not a stub',
  );
});

test('sessionHasPty checks activeSessions for a live, non-exited match on realSessionId or the map key', () => {
  const at = mainSrc.indexOf('function sessionHasPty(sessionId)');
  assert.notEqual(at, -1, 'sessionHasPty must be defined');
  const body = mainSrc.slice(at, mainSrc.indexOf('\n}\n', at) + 3);
  assert.match(body, /for \(const \[key, session\] of activeSessions\)/);
  assert.match(body, /session\.exited/, 'must skip an exited session — a dead PTY is not a live PTY');
  assert.match(body, /session\.realSessionId \|\| key/, 'must match a forked/resumed session by its real id, same as cli-session-state.js findSession()');
});

test('the fs.watch callback emits session-transcript-activity out-of-band, not through the debounced flush', () => {
  const watchAt = mainSrc.indexOf("fs.watch(PROJECTS_DIR, { recursive: true }");
  assert.notEqual(watchAt, -1, 'the projects watcher call site must still exist');
  const flushAt = mainSrc.indexOf('function flushChanges()');
  assert.notEqual(flushAt, -1);
  const flushBody = mainSrc.slice(flushAt, mainSrc.indexOf('\n  }\n', flushAt));
  assert.doesNotMatch(flushBody, /localTranscriptTracker/,
    'the heavy debounced flush must not carry the lightweight per-session signal');

  const callbackEnd = mainSrc.indexOf('projectsWatcher.on(\'error\'', watchAt);
  const callbackBody = mainSrc.slice(watchAt, callbackEnd);
  assert.match(callbackBody, /localTranscriptTracker\.record\(parts\)/,
    'the raw watcher callback must feed the tracker directly, before the 500ms debounce');
  assert.match(callbackBody, /mainWindow\.webContents\.send\('session-transcript-activity', activity\)/);
  assert.match(callbackBody, /mainWindow && !mainWindow\.isDestroyed\(\)/,
    'must guard the send exactly like the other IPC emitters in this file (e.g. onRemoteWatchActivity)');
});
