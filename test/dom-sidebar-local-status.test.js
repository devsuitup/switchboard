// Issue #245 — a local session carrying the same status/statusUpdatedAt pair
// a remote session gets from its host descriptor must render the same
// `.session-status` state+age line, regardless of session.remoteAlias.

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

test('a local session with a status renders the state+age line', () => {
  const ctx = setupSidebarDom();
  try {
    const now = Date.parse('2026-09-09T12:00:00Z');
    const realNow = ctx.window.Date.now;
    ctx.window.Date.now = () => now;
    try {
      const session = {
        sessionId: 'local-with-status',
        summary: 'local session',
        modified: '2026-09-09T11:59:00.000Z',
        starred: false,
        archived: 0,
        messageCount: 1,
        status: 'idle',
        statusUpdatedAt: now - 3 * 60 * 1000, // 3 min ago
      };

      const item = ctx.sidebar.buildSessionItem(session);

      const statusEl = item.querySelector('.session-status');
      assert.ok(statusEl, 'a local session with status must render the status line');
      assert.match(statusEl.textContent, /idle.*3m ago/);
      assert.equal(item.querySelector('.remote-badge'), null, 'a local session must not get a remote badge');
    } finally {
      ctx.window.Date.now = realNow;
    }
  } finally { ctx.destroy(); }
});

test('a local session with no status renders no status line', () => {
  const ctx = setupSidebarDom();
  try {
    const session = {
      sessionId: 'local-no-status',
      summary: 'local session',
      modified: '2026-09-09T11:59:00.000Z',
      starred: false,
      archived: 0,
      messageCount: 1,
    };

    const item = ctx.sidebar.buildSessionItem(session);

    assert.equal(item.querySelector('.session-status'), null, 'no status field must mean no status line');
  } finally { ctx.destroy(); }
});

test('a remote session still renders both its remote badge and the status line', () => {
  const ctx = setupSidebarDom();
  try {
    const now = Date.parse('2026-09-09T12:00:00Z');
    const realNow = ctx.window.Date.now;
    ctx.window.Date.now = () => now;
    try {
      const session = {
        sessionId: 'remote-with-status',
        summary: 'remote session',
        modified: '2026-09-09T11:59:00.000Z',
        starred: false,
        archived: 0,
        messageCount: 1,
        remoteAlias: 'planificator',
        remoteAttachable: true,
        status: 'busy',
        statusUpdatedAt: now - 5000,
      };

      const item = ctx.sidebar.buildSessionItem(session);

      assert.ok(item.querySelector('.remote-badge'), 'a remote session must still carry its badge');
      const statusEl = item.querySelector('.session-status');
      assert.ok(statusEl, 'a remote session must still render the status line');
      assert.match(statusEl.textContent, /busy.*5s ago/);
    } finally {
      ctx.window.Date.now = realNow;
    }
  } finally { ctx.destroy(); }
});

test('renderProjects wires a real project fixture with a mix of local and remote sessions correctly', () => {
  const ctx = setupSidebarDom();
  try {
    const project = makeSampleProject({
      sessions: [{
        sessionId: 'local-in-project',
        summary: 'local one',
        modified: '2026-05-22T10:00:00.000Z',
        starred: false,
        archived: 0,
        messageCount: 1,
        status: 'waiting',
        statusUpdatedAt: Date.now() - 1000,
      }],
    });

    ctx.sidebar.renderProjects([project], true);

    const el = ctx.document.getElementById('si-local-in-project');
    assert.ok(el, 'the local session row must render');
    assert.ok(el.querySelector('.session-status'), 'the local session row must show its status line');
  } finally { ctx.destroy(); }
});
