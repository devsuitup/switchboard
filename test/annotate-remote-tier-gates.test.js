'use strict';

// Issue #218: annotateRemoteAttachable (main.js) turns the host profile into
// per-session gates: attach withheld while tmux is known missing, send withheld
// while the inject tier is unavailable. The real function body is extracted
// from main.js, as in annotate-remote-attachable-local-status.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { computeHostProfile, attachBlockReason, sendBlockReason } = require('../remote-host-profile');

function extractSource() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = src.indexOf('function annotateRemoteAttachable(projects)');
  assert.ok(start !== -1, 'main.js must define annotateRemoteAttachable');
  const bodyOpen = src.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = bodyOpen; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  return src.slice(start, end + 1);
}

const AT = 111;
const TMUX_DESCRIPTOR = { sessionId: 'remote-1', pid: 4, tmux: 'main:@0.%0' };
const SOCKET_DESCRIPTOR = { sessionId: 'remote-1', pid: 4, messagingSocketPath: '/run/user/1000/c.sock' };

function annotateFor({ descriptors, tools, error = null, failures = 0, supports = true }) {
  const factory = new Function(
    'remoteIndexer', 'remoteAttachAdapter', 'remoteActivityTracker', 'cliSessionState',
    'attachBlockReason', 'sendBlockReason',
    extractSource() + '\nreturn annotateRemoteAttachable;'
  );
  return factory(
    {
      getRemoteSessions: () => ({ sessions: descriptors, at: AT, error }),
      getRemoteHostState: () => ({ consecutiveFailures: failures, lastError: error, nextAttemptAt: 0 }),
      getRemoteHostProfile: () => computeHostProfile({ at: AT, error, descriptors, tools }),
    },
    { supports: () => supports },
    { activeAt: () => null },
    { getStatus: () => undefined },
    attachBlockReason,
    sendBlockReason
  );
}

function projects() {
  return [{ projectPath: '/srv/p', remoteAlias: 'box', sessions: [{ sessionId: 'remote-1', remoteAlias: 'box' }] }];
}

test('a session whose descriptor names a tmux pane is not attachable on a host without tmux, and says so', () => {
  const list = projects();
  annotateFor({ descriptors: [TMUX_DESCRIPTOR], tools: { tmux: false, inotifywait: true } })(list);
  const session = list[0].sessions[0];
  assert.equal(session.remoteAttachable, false);
  assert.match(session.remoteAttachBlocked, /tmux is not installed/);
});

test('the same session stays attachable when the probe found tmux or has not answered', () => {
  for (const tools of [{ tmux: true, inotifywait: true }, null]) {
    const list = projects();
    annotateFor({ descriptors: [TMUX_DESCRIPTOR], tools })(list);
    assert.equal(list[0].sessions[0].remoteAttachable, true, JSON.stringify(tools));
    assert.equal(list[0].sessions[0].remoteAttachBlocked, null);
  }
});

test('a session that cannot attach anyway carries no attach reason, whatever the probe says', () => {
  const list = projects();
  annotateFor({ descriptors: [TMUX_DESCRIPTOR], tools: { tmux: false, inotifywait: false }, supports: false })(list);
  assert.equal(list[0].sessions[0].remoteAttachable, false);
  assert.equal(list[0].sessions[0].remoteAttachBlocked, null);
});

test('send is withheld with the inject reason on a synced host that reports no messaging socket', () => {
  const list = projects();
  annotateFor({ descriptors: [TMUX_DESCRIPTOR], tools: null })(list);
  assert.match(list[0].sessions[0].remoteSendBlocked, /messagingSocketPath/);
});

test('send carries no reason when the host reports a messaging socket', () => {
  const list = projects();
  annotateFor({ descriptors: [SOCKET_DESCRIPTOR], tools: null })(list);
  assert.equal(list[0].sessions[0].remoteSendBlocked, null);
});

test('send is not withheld by a host that failed its refresh: it runs its own ssh', () => {
  const list = projects();
  annotateFor({ descriptors: [TMUX_DESCRIPTOR], tools: null, error: 'connect timed out', failures: 5 })(list);
  assert.equal(list[0].sessions[0].remoteSendBlocked, null);
});

test('stop is never blocked, whatever the gates say', () => {
  const list = projects();
  annotateFor({ descriptors: [TMUX_DESCRIPTOR], tools: { tmux: false, inotifywait: false }, failures: 5, error: 'down' })(list);
  assert.equal(list[0].sessions[0].remoteStopBlocked, undefined);
});
