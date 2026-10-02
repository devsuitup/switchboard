'use strict';

// Issue #219: a remote row offers "Send a prompt…" next to Stop. The button is
// shown by CSS only while the process is alive and no terminal is attached,
// exactly like Stop (.is-alive / .has-running-pty) — see .ai/contexts/session-state.md.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

const REMOTE = {
  sessionId: 'remote-9', summary: 'remote work', modified: '2026-09-06T10:00:00.000Z',
  starred: false, archived: 0, messageCount: 4, projectPath: '/srv/x', remoteAlias: 'planificator',
};
const LOCAL = { sessionId: 'local-9', summary: 'local work', modified: '2026-09-06T10:00:00.000Z', starred: false, archived: 0, messageCount: 2 };

function render(ctx, sessions) {
  for (const s of sessions) ctx.window.sessionMap.set(s.sessionId, s);
  const remote = sessions.filter((s) => s.remoteAlias);
  const local = sessions.filter((s) => !s.remoteAlias);
  const projects = [];
  if (remote.length) {
    projects.push(makeSampleProject({
      projectPath: '/srv/x', folder: 'planificator::-srv-x', remoteAlias: 'planificator', sessions: remote,
    }));
  }
  if (local.length) projects.push(makeSampleProject({ sessions: local }));
  ctx.sidebar.renderProjects(projects, true);
}

test('a remote row carries a Send a prompt button; a local row does not', () => {
  const ctx = setupSidebarDom();
  try {
    render(ctx, [REMOTE, LOCAL]);
    const remoteBtn = ctx.document.getElementById('si-remote-9').querySelector('.session-send-btn');
    assert.ok(remoteBtn, 'remote row offers the action');
    assert.match(remoteBtn.title, /Send a prompt/);
    assert.equal(ctx.document.getElementById('si-local-9').querySelector('.session-send-btn'), null);
  } finally { ctx.destroy(); }
});

test('clicking the button opens the dialog for that session and does not open the row', () => {
  const ctx = setupSidebarDom();
  try {
    render(ctx, [REMOTE]);
    const dialogs = [];
    const opened = [];
    ctx.window.showSendPromptDialog = (s) => dialogs.push(s.sessionId);
    ctx.window.openSession = (s) => opened.push(s.sessionId);
    ctx.window.showJsonlViewer = (s) => opened.push(s.sessionId);
    ctx.document.getElementById('si-remote-9').querySelector('.session-send-btn').click();
    assert.deepEqual(dialogs, ['remote-9']);
    assert.deepEqual(opened, [], 'the click must not bubble to the row');
  } finally { ctx.destroy(); }
});

test('the stylesheet shows the button only for a live, unattached row, like Stop', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  assert.match(css, /\.session-send-btn\s*\{\s*display:\s*none;?\s*\}/);
  assert.match(css, /\.session-item\.is-alive:not\(\.has-running-pty\)\s+\.session-send-btn\s*\{\s*display:\s*flex;?\s*\}/);
});
