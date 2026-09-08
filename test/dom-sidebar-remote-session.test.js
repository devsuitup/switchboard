// Issue #201: a session mirrored from an SSH host defaults to observation
// only. Its row says so via a badge naming the host. Issue #221: when the
// main process reports the session as attachable, the click opens a terminal
// instead; otherwise it still falls back to the read-only transcript rather
// than trying to `claude --resume` in a cwd this machine does not have.

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

const REMOTE_SESSION = {
  sessionId: 'remote-1',
  summary: 'ripcord protocol',
  modified: '2026-09-06T10:00:00.000Z',
  starred: false,
  archived: 0,
  messageCount: 4,
  projectPath: '/srv/supervision',
  remoteAlias: 'planificator',
};

function projectWithRemoteSession() {
  return makeSampleProject({
    projectPath: '/srv/supervision',
    folder: 'planificator::-srv-supervision',
    remoteAlias: 'planificator',
    sessions: [REMOTE_SESSION],
  });
}

// rebindSidebarEvents only wires an item it can resolve via sessionMap, which
// app.js normally fills — same setup as test/dom-delete-session-dialog.test.js.
function register(ctx, sessions) {
  for (const s of sessions) ctx.window.sessionMap.set(s.sessionId, s);
}

test('a remote session row carries a badge naming its host', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithRemoteSession()], true);
    const item = ctx.document.getElementById('si-remote-1');
    assert.ok(item, 'the remote session must be rendered');
    const badge = item.querySelector('.remote-badge');
    assert.ok(badge, 'a remote row must be visibly distinguishable from a local one');
    assert.equal(badge.textContent, 'planificator');
  } finally { ctx.destroy(); }
});

test('a remote session with no live attachable descriptor opens the transcript, never a resume', () => {
  const ctx = setupSidebarDom();
  try {
    register(ctx, [REMOTE_SESSION]);
    ctx.sidebar.renderProjects([projectWithRemoteSession()], true);

    const opened = [];
    const viewed = [];
    ctx.window.openSession = (s) => opened.push(s.sessionId);
    ctx.window.showJsonlViewer = (s) => viewed.push(s.sessionId);

    const item = ctx.document.getElementById('si-remote-1');
    item.onclick();

    assert.deepEqual(viewed, ['remote-1']);
    assert.deepEqual(opened, [], 'openSession would spawn a PTY in a cwd that is not on this machine');
    assert.match(item.title, /not currently attachable/i, 'the row must say why it fell back to the transcript');
    assert.doesNotMatch(item.title, /tmux/i, 'the renderer must never name a multiplexer');
  } finally { ctx.destroy(); }
});

test('a remote session with a live attachable descriptor opens a terminal, not the transcript', () => {
  const ctx = setupSidebarDom();
  try {
    const attachable = { ...REMOTE_SESSION, sessionId: 'remote-2', remoteAttachable: true };
    register(ctx, [attachable]);
    ctx.sidebar.renderProjects([makeSampleProject({
      projectPath: '/srv/supervision',
      folder: 'planificator::-srv-supervision',
      remoteAlias: 'planificator',
      sessions: [attachable],
    })], true);

    const opened = [];
    const viewed = [];
    ctx.window.openSession = (s) => opened.push(s.sessionId);
    ctx.window.showJsonlViewer = (s) => viewed.push(s.sessionId);

    const item = ctx.document.getElementById('si-remote-2');
    item.onclick();

    assert.deepEqual(opened, ['remote-2']);
    assert.deepEqual(viewed, [], 'an attachable remote session must open a terminal, not the read-only transcript');
    assert.ok(!item.title, 'an attachable session carries no fallback-reason title');
  } finally { ctx.destroy(); }
});

test('a local session is unaffected: no badge, and the click still opens it', () => {
  const ctx = setupSidebarDom();
  try {
    const project = makeSampleProject({
      sessions: [{
        sessionId: 'local-1', summary: 'local work', modified: '2026-09-06T10:00:00.000Z',
        starred: false, archived: 0, messageCount: 2,
      }],
    });
    register(ctx, project.sessions);
    ctx.sidebar.renderProjects([project], true);

    const item = ctx.document.getElementById('si-local-1');
    assert.equal(item.querySelector('.remote-badge'), null);

    const opened = [];
    const viewed = [];
    ctx.window.openSession = (s) => opened.push(s.sessionId);
    ctx.window.showJsonlViewer = (s) => viewed.push(s.sessionId);
    item.onclick();

    assert.deepEqual(opened, ['local-1']);
    assert.deepEqual(viewed, []);
  } finally { ctx.destroy(); }
});
