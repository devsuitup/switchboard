// Issue #278: a live remote descriptor with no transcript yet gets a
// synthesized placeholder row (main.js's mergePlaceholderSessions, see
// test/merge-placeholder-sessions.test.js and
// .ai/contexts/session-cache.md, "Remote hosts — descriptor-only sessions").
// This covers the DOM side: the row renders as alive and stoppable, shows
// its status/age, has no transcript affordance, and clicking it attaches.

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

// Shape mirrors what main.js's toSidebarPlaceholderSession() +
// annotateRemoteAttachable() together produce for a descriptor-only session.
const PLACEHOLDER_SESSION = {
  sessionId: 'placeholder-1',
  summary: 'switchboard-test',
  modified: 1787527436145,
  starred: false,
  archived: 0,
  messageCount: 0,
  projectPath: '/srv/echanges/switchboard-test',
  remoteAlias: 'planificator',
  remoteDescriptorSeen: true,
  remoteAttachable: true,
  status: 'busy',
  statusUpdatedAt: Date.now() - 5000,
  placeholder: true,
};

function projectWithPlaceholder() {
  return makeSampleProject({
    projectPath: '/srv/echanges/switchboard-test',
    folder: 'planificator::-srv-echanges-switchboard-test',
    remoteAlias: 'planificator',
    sessions: [PLACEHOLDER_SESSION],
  });
}

function register(ctx, sessions) {
  for (const s of sessions) ctx.window.sessionMap.set(s.sessionId, s);
}

test('a placeholder row renders alive, with a stop control, status text, and no transcript affordance', () => {
  const ctx = setupSidebarDom();
  try {
    register(ctx, [PLACEHOLDER_SESSION]);
    ctx.sidebar.renderProjects([projectWithPlaceholder()], true);

    const item = ctx.document.getElementById('si-placeholder-1');
    assert.ok(item, 'the placeholder session must be rendered as a row');

    assert.ok(item.classList.contains('is-alive'), 'a live descriptor renders the row as alive');

    assert.ok(item.querySelector('.session-stop-btn'), 'the row is stoppable, same control as any other session');

    const statusEl = item.querySelector('.session-status');
    assert.ok(statusEl, 'status + age must be shown');
    assert.match(statusEl.textContent, /busy/);
    assert.match(statusEl.textContent, /ago/);

    assert.equal(item.querySelector('.session-jsonl-btn'), null,
      'no transcript affordance — there is nothing to view yet');

    const badge = item.querySelector('.remote-badge');
    assert.ok(badge);
    assert.equal(badge.textContent, 'planificator');
  } finally { ctx.destroy(); }
});

test('clicking a placeholder row attaches, it never opens the transcript viewer', () => {
  const ctx = setupSidebarDom();
  try {
    register(ctx, [PLACEHOLDER_SESSION]);
    ctx.sidebar.renderProjects([projectWithPlaceholder()], true);

    const opened = [];
    const viewed = [];
    ctx.window.openSession = (s) => opened.push(s.sessionId);
    ctx.window.showJsonlViewer = (s) => viewed.push(s.sessionId);

    const item = ctx.document.getElementById('si-placeholder-1');
    item.onclick();

    assert.deepEqual(opened, ['placeholder-1'], 'an attachable placeholder opens a terminal, like any other attachable remote row');
    assert.deepEqual(viewed, [], 'the transcript viewer is never reached — there is no transcript');
  } finally { ctx.destroy(); }
});
