// Issue #246 step 4: a local session launched outside Switchboard (no PTY in
// this app) gets liveness/activity from the local-transcript adapter instead
// of showing nothing. See .ai/contexts/session-state.md.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

const LOCAL_SESSION = {
  sessionId: 'local-1',
  summary: 'a session running outside switchboard',
  modified: '2026-09-06T10:00:00.000Z',
  starred: false,
  archived: 0,
  messageCount: 4,
  status: 'busy',
  statusUpdatedAt: Date.parse('2026-09-06T10:00:00.000Z'),
};

function projectWithLocalSession() {
  return makeSampleProject({
    projectPath: '/home/dev/local-only',
    sessions: [LOCAL_SESSION],
  });
}

// rebindSidebarEvents/the adapter's descriptor seeding read sessionMap — app.js
// normally fills it; same pattern as test/dom-sidebar-remote-session.test.js.
function register(ctx, sessions) {
  for (const s of sessions) ctx.window.sessionMap.set(s.sessionId, s);
}

test('a local row without a PTY shows the busy slot after a transcript-activity event, and the age with no response-ready after decay', () => {
  const ctx = setupSidebarDom();
  try {
    register(ctx, [LOCAL_SESSION]);
    ctx.sidebar.renderProjects([projectWithLocalSession()], true);

    const item = ctx.document.getElementById('si-local-1');
    assert.ok(item, 'the local session must be rendered');
    assert.equal(item.dataset.remoteAlias, undefined, 'this is a local row, not a remote one');
    assert.ok(!item.classList.contains('cli-busy'), 'precondition: no transcript-activity event has arrived yet');

    ctx.emitSessionTranscriptActivity({ sessionId: 'local-1', at: Date.now() });
    assert.ok(item.classList.contains('cli-busy'), 'a transcript-activity event must light the busy indicator for a PTY-less row');
    const icon = item.querySelector('.session-icon');
    assert.ok(icon.classList.contains('session-icon--busy'), 'the icon slot must reflect the busy rung');

    // Drive the 20s decay by hand (real timers are not worth the wall-clock
    // cost here; the timer itself is proven in test/local-transcript-adapter.test.js).
    ctx.window.decayLocalTranscriptBusy('local-1');
    assert.ok(!item.classList.contains('cli-busy'), 'decay clears the busy indicator');
    assert.ok(!item.classList.contains('response-ready'), 'decay must never claim a finished turn — no PTY to confirm one');

    const statusEl = item.querySelector('.session-status');
    assert.ok(statusEl, 'the state+age line is rendered independently of the icon slot');
    assert.match(statusEl.textContent, /^busy/, 'the age line survives the icon decay unaffected — it reads session.status directly');
  } finally { ctx.destroy(); }
});

test('once the row gains a PTY, a later transcript-activity event no longer paints it', () => {
  const ctx = setupSidebarDom();
  try {
    register(ctx, [LOCAL_SESSION]);
    ctx.sidebar.renderProjects([projectWithLocalSession()], true);
    const item = ctx.document.getElementById('si-local-1');

    ctx.emitSessionTranscriptActivity({ sessionId: 'local-1', at: Date.now() });
    assert.ok(item.classList.contains('cli-busy'), 'precondition: the adapter is painting this row');

    // Simulate app.js's updateRunningIndicators(): the row gains a PTY, and
    // the local-transcript adapter is handed off — see .ai/contexts/session-state.md.
    ctx.window.localTranscriptPtyTakeover('local-1');
    ctx.window.decayLocalTranscriptBusy('local-1'); // any timer that was still pending must be inert now
    ctx.window.activePtyIds.add('local-1');

    ctx.emitSessionTranscriptActivity({ sessionId: 'local-1', at: Date.now() + 25000 });
    assert.ok(!item.classList.contains('cli-busy'),
      'once a PTY exists, the local-transcript adapter must stay silent — the OSC path owns the row now');
  } finally { ctx.destroy(); }
});
