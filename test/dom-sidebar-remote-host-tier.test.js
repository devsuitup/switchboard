// Issue #218 — the host's capability tier is shown on its project header
// and every affordance above the tier is disabled with the reason as title.

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupSidebarDom, makeSampleProject } = require('./dom-setup');
const { computeHostProfile } = require('../remote-host-profile');

const SESSION = {
  sessionId: 'remote-1',
  summary: 'ripcord protocol',
  modified: '2026-09-06T10:00:00.000Z',
  starred: false,
  archived: 0,
  messageCount: 4,
  projectPath: '/srv/supervision',
  remoteAlias: 'planificator',
  remoteDescriptorSeen: true,
};

function project(profile, session) {
  return makeSampleProject({
    projectPath: '/srv/supervision',
    folder: 'planificator::-srv-supervision',
    remoteAlias: 'planificator',
    remoteHostAt: Date.parse('2026-10-01T10:00:00Z'),
    remoteHostError: null,
    remoteHostProfile: profile,
    sessions: [session],
  });
}

function header(ctx) {
  return ctx.document.getElementById('ph-' + ctx.sidebar.folderId('/srv/supervision'));
}

test('the host dot title names the tier and the reason of every tier above it', () => {
  const ctx = setupSidebarDom();
  try {
    const profile = computeHostProfile({ at: Date.now(), error: null, descriptors: [{ pid: 5, sessionId: 'a' }] });
    ctx.sidebar.renderProjects([project(profile, SESSION)], true);
    const title = header(ctx).querySelector('.remote-host-dot').title;
    assert.match(title, /Capability: liveness/);
    assert.match(title, /inject unavailable: no live session reports a messagingSocketPath/);
    assert.match(title, /attach unavailable: no live session names a tmux pane/);
    assert.match(title, /launch unavailable/);
  } finally { ctx.destroy(); }
});

test('a host with no profile keeps the plain status title', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([project(undefined, SESSION)], true);
    assert.doesNotMatch(header(ctx).querySelector('.remote-host-dot').title, /Capability/);
  } finally { ctx.destroy(); }
});

test('a stop button blocked by the host tier is disabled and its title is the reason', () => {
  const ctx = setupSidebarDom();
  try {
    const blocked = { ...SESSION, remoteStopBlocked: 'last refresh of this host failed: connect timed out' };
    ctx.window.sessionMap.set(blocked.sessionId, blocked);
    ctx.sidebar.renderProjects([project(undefined, blocked)], true);
    const stopBtn = ctx.document.getElementById('si-remote-1').querySelector('.session-stop-btn');
    assert.equal(stopBtn.disabled, true);
    assert.match(stopBtn.title, /connect timed out/);
  } finally { ctx.destroy(); }
});

test('a stop button with no block stays enabled', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.window.sessionMap.set(SESSION.sessionId, SESSION);
    ctx.sidebar.renderProjects([project(undefined, SESSION)], true);
    const stopBtn = ctx.document.getElementById('si-remote-1').querySelector('.session-stop-btn');
    assert.equal(stopBtn.disabled, false);
    assert.equal(stopBtn.title, 'Stop session');
  } finally { ctx.destroy(); }
});

test('a row whose attach is blocked says why in its title and badge, and opens the transcript', () => {
  const ctx = setupSidebarDom();
  try {
    const blocked = { ...SESSION, remoteAttachable: false, remoteAttachBlocked: 'last refresh of this host failed: connect timed out' };
    ctx.window.sessionMap.set(blocked.sessionId, blocked);
    ctx.sidebar.renderProjects([project(undefined, blocked)], true);
    const viewed = [];
    const opened = [];
    ctx.window.showJsonlViewer = (s) => viewed.push(s.sessionId);
    ctx.window.openSession = (s) => opened.push(s.sessionId);
    const item = ctx.document.getElementById('si-remote-1');
    assert.match(item.title, /connect timed out/);
    assert.match(item.querySelector('.remote-badge').title, /connect timed out/);
    item.onclick();
    assert.deepEqual(viewed, ['remote-1']);
    assert.deepEqual(opened, []);
  } finally { ctx.destroy(); }
});
