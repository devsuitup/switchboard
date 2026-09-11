// Issue #246, step 3b — one icon slot per sidebar row, driven by
// renderSessionIcon(snapshot) (public/session-state.js) and painted only by
// public/session-activity-dom.js. See .ai/contexts/session-state.md.
//
// The pinned tests in dom-sidebar-local-status.test.js,
// dom-sidebar-remote-session.test.js, dom-sidebar-remote-freshness.test.js,
// sidebar-busy-agents-tint.test.js and dom-sidebar-remote-activity-pip.test.js
// cover the row-level classes and the .session-status age line, unchanged by
// this migration. This file pins the new .session-icon slot markup itself.

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

function remoteProject(session) {
  return makeSampleProject({
    projectPath: '/srv/supervision',
    folder: 'planificator::-srv-supervision',
    remoteAlias: 'planificator',
    sessions: [session],
  });
}

function slotClassesOf(el) {
  return [...el.classList].filter((c) => c.indexOf('session-icon--') === 0);
}

// Mutation-provable: renderSessionIcon's ICON_BY_RUNG table maps 'busy' to
// { slotClasses: ['session-icon--busy'], glyph: '⠋', title: 'Working' }.
// Swapping the busy/agentsBusy (or any two) entries in that table changes
// what a busy row's slot actually renders — this test goes red on that swap,
// not just the pure-unit test in test/session-state.test.js.
test('a busy local row carries the busy icon-slot markup (mutation-provable against renderSessionIcon\'s table)', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sessionBusyState.set('local-busy', true);
    ctx.sidebar.renderProjects([makeSampleProject({
      sessions: [{
        sessionId: 'local-busy', summary: 'busy local', modified: '2026-09-06T10:00:00.000Z',
        starred: false, archived: 0, messageCount: 1,
      }],
    })], true);

    const slot = ctx.document.querySelector('#si-local-busy .session-icon');
    assert.ok(slot, 'the row must carry a .session-icon slot');
    assert.deepEqual(slotClassesOf(slot), ['session-icon--busy']);
    assert.equal(slot.title, 'Working');
    assert.equal(slot.dataset.glyph, '⠋');
  } finally { ctx.destroy(); }
});

test('a local busy row and a remote busy row produce the same icon-slot markup', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sessionBusyState.set('local-busy-2', true);
    const localProj = makeSampleProject({
      sessions: [{
        sessionId: 'local-busy-2', summary: 'busy local', modified: '2026-09-06T10:00:00.000Z',
        starred: false, archived: 0, messageCount: 1,
      }],
    });
    const remoteProj = remoteProject({
      sessionId: 'remote-busy-2', summary: 'busy remote', modified: '2026-09-06T10:00:00.000Z',
      starred: false, archived: 0, messageCount: 1,
    });

    ctx.sidebar.renderProjects([localProj, remoteProj], true);
    // Real watch-channel dispatcher (remote-activity-ui.js) — same path
    // main.js's 'remote-activity' IPC drives in production.
    ctx.window.onRemoteActivityEvent({ sessionId: 'remote-busy-2' });

    const localSlot = ctx.document.querySelector('#si-local-busy-2 .session-icon');
    const remoteSlot = ctx.document.querySelector('#si-remote-busy-2 .session-icon');
    assert.ok(localSlot && remoteSlot, 'both rows must carry an icon slot');
    assert.deepEqual(slotClassesOf(localSlot), slotClassesOf(remoteSlot));
    assert.equal(localSlot.title, remoteSlot.title);
    assert.equal(localSlot.dataset.glyph, remoteSlot.dataset.glyph);
    assert.deepEqual(slotClassesOf(remoteSlot), ['session-icon--busy'], 'precondition: the remote row is actually busy');
  } finally { ctx.destroy(); }
});

test('a remote row past the decay window shows the age with no response-ready glyph', () => {
  const ctx = setupSidebarDom();
  try {
    const now = Date.parse('2026-09-09T12:00:00Z');
    const realNow = ctx.window.Date.now;
    ctx.window.Date.now = () => now;
    try {
      const session = {
        sessionId: 'remote-decayed', summary: 'quiet now', modified: '2026-09-08T10:00:00.000Z',
        starred: false, archived: 0, messageCount: 1,
        remoteAlias: 'planificator', status: 'idle', statusUpdatedAt: now - 5000,
      };
      ctx.sidebar.renderProjects([remoteProject(session)], true);

      // Drive the adapter's own busy -> silence-decay transition directly
      // (same effect as its 20s timer, without arming a real one) — see
      // .ai/contexts/session-state.md ("a remote row must never reach
      // .response-ready, it has no PTY to confirm a turn actually ended").
      ctx.window.markRemoteBusy('remote-decayed', 'remote-watch', now - 25000);
      ctx.window.decayRemoteBusy('remote-decayed');

      const slot = ctx.document.querySelector('#si-remote-decayed .session-icon');
      assert.ok(slot);
      assert.ok(!slot.classList.contains('session-icon--response-ready'),
        'a silence-based decay must never claim response-ready');
      assert.equal(slot.title, 'Waiting for input');

      const statusEl = ctx.document.querySelector('#si-remote-decayed .session-status');
      assert.ok(statusEl, 'the age must still show via .session-status');
      assert.match(statusEl.textContent, /idle.*5s ago/);
    } finally {
      ctx.window.Date.now = realNow;
    }
  } finally { ctx.destroy(); }
});

test('a subagent row also gets an icon slot, painted the same way as a session row', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sessionBusyState.set('sub:s-top-1:agent-1', true);
    ctx.sidebar.renderProjects([makeSampleProject({
      sessions: [
        {
          sessionId: 's-top-1', name: 'main session', summary: 'top level 1',
          modified: '2026-05-22T10:00:00.000Z', starred: false, archived: 0, messageCount: 1,
        },
        {
          sessionId: 'sub:s-top-1:agent-1', parentSessionId: 's-top-1', agentId: 'agent-1',
          subagentType: 'explore', description: 'explore subagent',
          modified: '2026-05-22T09:59:00.000Z', messageCount: 1,
        },
      ],
    })], true);

    const slot = ctx.document.querySelector('#si-sub\\:s-top-1\\:agent-1 .session-icon');
    assert.ok(slot, 'the subagent row must carry a .session-icon slot');
    assert.deepEqual(slotClassesOf(slot), ['session-icon--busy']);
  } finally { ctx.destroy(); }
});
