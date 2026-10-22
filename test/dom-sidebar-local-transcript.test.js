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

for (const state of ['descriptor', 'busy', 'waiting']) {
  for (const disappearance of ['status', 'session']) {
    test(`a ${state} row stops being alive or waiting after its ${disappearance} disappears and the sidebar re-renders`, { timeout: 10000 }, () => {
      const ctx = setupSidebarDom();
      try {
        const session = { ...LOCAL_SESSION };
        const projects = [makeSampleProject({ sessions: [session] })];
        register(ctx, [session]);
        ctx.sidebar.renderProjects(projects, true);
        ctx.window.applyHeadTurnSnapshot({ sessionId: session.sessionId, state: state === 'busy' ? 'open' : 'closed', revision: 1 });
        if (state !== 'descriptor') {
          ctx.emitSessionTranscriptActivity({ sessionId: session.sessionId, at: Date.now() });
          if (state === 'waiting') {
            ctx.window.clearLocalTranscriptTimer(session.sessionId);
            ctx.window.decayLocalTranscriptBusy(session.sessionId);
          }
        }
        const before = ctx.document.getElementById('si-local-1');
        assert.ok(before.classList.contains('is-alive'));
        if (state === 'waiting') assert.equal(before.querySelector('.session-icon').title, 'Waiting for input · Running elsewhere\nCLI status: busy');
        if (disappearance === 'status') session.status = undefined;
        else {
          ctx.window.sessionMap.delete(session.sessionId);
          projects[0].sessions = [{ ...session, status: undefined }];
        }
        ctx.sidebar.renderProjects(projects, true);
        const item = ctx.document.getElementById('si-local-1');
        assert.equal(item.classList.contains('is-alive'), false, 'the ended process is not alive');
        assert.equal(item.classList.contains('cli-busy'), false, 'the ended process is not busy');
        assert.equal(item.querySelector('.session-icon').title, 'Idle · Liveness unknown', 'the ended process is not waiting');
        const local = ctx.read('localPtyStates.get("local-1").snapshot()');
        assert.notEqual(local.liveness, 'alive');
        assert.equal(local.busy, false);
        assert.equal(local.waitingForInput, false);
        assert.equal(ctx.read('localTranscriptStates.has("local-1")'), false);
        assert.equal(ctx.read('localTranscriptDecayTimers.has("local-1")'), false);
        ctx.window.decayLocalTranscriptBusy(session.sessionId);
        assert.equal(item.querySelector('.session-icon').title, 'Idle · Liveness unknown', 'late decay cannot restore waiting');
      } finally { ctx.destroy(); }
    });
  }
}

for (const withDescriptor of [false, true]) {
  for (const state of ['busy', 'waiting']) {
    test(`a transcript-driven ${state} row survives a full sidebar re-render ${withDescriptor ? 'with' : 'without'} a descriptor`, { timeout: 10000 }, () => {
      const ctx = setupSidebarDom();
      try {
        const session = { ...LOCAL_SESSION };
        if (!withDescriptor) {
          delete session.status;
          delete session.statusUpdatedAt;
        }
        const projects = [makeSampleProject({ sessions: [session] })];
        register(ctx, [session]);
        ctx.sidebar.renderProjects(projects, true);
        ctx.emitSessionTranscriptActivity({ sessionId: session.sessionId, at: Date.now() });
        ctx.window.applyHeadTurnSnapshot({ sessionId: session.sessionId, state: state === 'busy' ? 'open' : 'closed', revision: 1 });
        if (state === 'waiting') {
          ctx.window.clearLocalTranscriptTimer(session.sessionId);
          ctx.window.decayLocalTranscriptBusy(session.sessionId);
        }
        const snapshot = ctx.read('localTranscriptStates.get("local-1").snapshot()');
        const decayTimer = ctx.read('localTranscriptDecayTimers.get("local-1")');
        const assertState = () => {
          const item = ctx.document.getElementById('si-local-1');
          const icon = item.querySelector('.session-icon');
          const visible = withDescriptor ? state : 'idle';
          assert.ok(icon.classList.contains(`session-icon--${visible}`), `the ${visible} icon survives the render`);
          assert.equal(icon.title, withDescriptor ? (state === 'busy' ? 'Working' : 'Waiting for input') + ' · Running elsewhere\nCLI status: busy' : 'Idle · Liveness unknown');
          assert.equal(item.classList.contains('cli-busy'), withDescriptor && state === 'busy');
          assert.equal(item.classList.contains('response-ready'), false);
          assert.equal(item.classList.contains('needs-attention'), false);
          assert.equal(item.classList.contains('is-alive'), withDescriptor);
          assert.deepEqual(ctx.read('localTranscriptStates.get("local-1").snapshot()'), snapshot);
          assert.equal(ctx.read('localTranscriptDecayTimers.get("local-1")'), decayTimer);
        };
        assertState();
        ctx.sidebar.renderProjects(projects, true);
        assertState();
        ctx.window.paintSessionIcon(ctx.document.querySelector('#si-local-1 .session-icon'), session.sessionId, session);
        assertState();
        ctx.document.getElementById('sidebar-content').replaceChildren();
        ctx.sidebar.renderProjects(projects, true);
        assertState();
      } finally { ctx.destroy(); }
    });
  }
}

test('a local row without a PTY needs head evidence to animate, independently of the age line', (t) => {
  const ctx = setupSidebarDom();
  try {
    t.mock.method(ctx.window.Date, 'now', () => LOCAL_SESSION.statusUpdatedAt + 5000);
    register(ctx, [LOCAL_SESSION]);
    ctx.sidebar.renderProjects([projectWithLocalSession()], true);

    const item = ctx.document.getElementById('si-local-1');
    assert.ok(item, 'the local session must be rendered');
    assert.equal(item.dataset.remoteAlias, undefined, 'this is a local row, not a remote one');
    assert.ok(!item.classList.contains('cli-busy'), 'precondition: no transcript-activity event has arrived yet');

    ctx.emitSessionTranscriptActivity({ sessionId: 'local-1', at: Date.now() });
    assert.equal(item.classList.contains('cli-busy'), false, 'a transcript write is a hint only');
    const icon = item.querySelector('.session-icon');
    assert.ok(icon.classList.contains('session-icon--waiting'), 'a live unknown head uses a static degraded glyph');

    // Drive the 20s decay by hand (real timers are not worth the wall-clock
    // cost here; the timer itself is proven in test/local-transcript-adapter.test.js).
    ctx.window.decayLocalTranscriptBusy('local-1');
    assert.ok(!item.classList.contains('cli-busy'), 'decay clears the busy indicator');
    assert.ok(!item.classList.contains('response-ready'), 'decay must never claim a finished turn — no PTY to confirm one');

    const statusEl = item.querySelector('.session-status');
    assert.ok(statusEl, 'the state+age line is rendered independently of the icon slot');
    assert.equal(statusEl.textContent, '5s ago', 'the age line survives the icon decay');
  } finally { ctx.destroy(); }
});

test('once the row gains a PTY, a later transcript-activity event no longer paints it', () => {
  const ctx = setupSidebarDom();
  try {
    register(ctx, [LOCAL_SESSION]);
    ctx.sidebar.renderProjects([projectWithLocalSession()], true);
    const item = ctx.document.getElementById('si-local-1');

    ctx.emitSessionTranscriptActivity({ sessionId: 'local-1', at: Date.now() });
    ctx.window.applyHeadTurnSnapshot({ sessionId: 'local-1', state: 'open', revision: 1 });
    assert.ok(item.classList.contains('cli-busy'), 'precondition: the adapter is painting this row');

    // Simulate app.js's updateRunningIndicators(): the row gains a PTY, and
    // the local-transcript adapter is handed off — see .ai/contexts/session-state.md.
    ctx.window.localTranscriptPtyTakeover('local-1');
    ctx.window.decayLocalTranscriptBusy('local-1'); // any timer that was still pending must be inert now
    ctx.window.activePtyIds.add('local-1');
    ctx.window.activeSessionId = 'local-1';
    ctx.window.applyHeadTurnSnapshot({ sessionId: 'local-1', state: 'closed', revision: 2 });
    ctx.setActivity('local-1', false, 'pty-idle', { armReady: false });

    ctx.emitSessionTranscriptActivity({ sessionId: 'local-1', at: Date.now() + 25000 });
    assert.ok(!item.classList.contains('cli-busy'),
      'once a PTY exists, the local-transcript adapter must stay silent — the OSC path owns the row now');
  } finally { ctx.destroy(); }
});
