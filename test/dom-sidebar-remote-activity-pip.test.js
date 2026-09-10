// Issue #242: a rebuilt sidebar (or a fresh launch) must paint the remote
// activity pip from session.remoteActiveAt without waiting for the next
// live remote-activity IPC message — see .ai/contexts/session-cache.md
// ("Remote hosts — activity pip"). The live-update path itself is covered
// by test/remote-activity-ui.test.js.

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

test('a session active within the decay window paints the pip lit on first render', () => {
  const ctx = setupSidebarDom();
  try {
    const session = {
      sessionId: 'remote-active', summary: 'live now', modified: '2026-09-06T10:00:00.000Z',
      starred: false, archived: 0, messageCount: 1,
      remoteAlias: 'planificator', remoteActiveAt: Date.now() - 5000,
    };
    ctx.sidebar.renderProjects([remoteProject(session)], true);

    const dot = ctx.document.querySelector('#si-remote-active .remote-activity-dot');
    assert.ok(dot, 'a remote session must carry the activity pip element');
    assert.ok(dot.classList.contains('active'), 'a sighting 5s ago is still inside the 20s decay window');
  } finally { ctx.destroy(); }
});

test('a session last active past the decay window renders the pip off', () => {
  const ctx = setupSidebarDom();
  try {
    const session = {
      sessionId: 'remote-stale', summary: 'quiet now', modified: '2026-09-06T10:00:00.000Z',
      starred: false, archived: 0, messageCount: 1,
      remoteAlias: 'planificator', remoteActiveAt: Date.now() - 60000,
    };
    ctx.sidebar.renderProjects([remoteProject(session)], true);

    const dot = ctx.document.querySelector('#si-remote-stale .remote-activity-dot');
    assert.ok(dot);
    assert.ok(!dot.classList.contains('active'), 'a sighting a minute ago is well past the 20s decay window');
  } finally { ctx.destroy(); }
});

test('a session with no remoteActiveAt at all renders the pip off, not crashing on undefined', () => {
  const ctx = setupSidebarDom();
  try {
    const session = {
      sessionId: 'remote-never', summary: 'never seen writing', modified: '2026-09-06T10:00:00.000Z',
      starred: false, archived: 0, messageCount: 1,
      remoteAlias: 'planificator',
    };
    ctx.sidebar.renderProjects([remoteProject(session)], true);

    const dot = ctx.document.querySelector('#si-remote-never .remote-activity-dot');
    assert.ok(dot);
    assert.ok(!dot.classList.contains('active'));
  } finally { ctx.destroy(); }
});

test('a local session carries no activity pip at all', () => {
  const ctx = setupSidebarDom();
  try {
    const project = makeSampleProject({
      sessions: [{
        sessionId: 'local-1', summary: 'local work', modified: '2026-09-06T10:00:00.000Z',
        starred: false, archived: 0, messageCount: 2,
      }],
    });
    ctx.sidebar.renderProjects([project], true);

    assert.equal(ctx.document.querySelector('#si-local-1 .remote-activity-dot'), null);
  } finally { ctx.destroy(); }
});
