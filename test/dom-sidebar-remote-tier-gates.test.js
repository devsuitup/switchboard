'use strict';

// Issue #218: affordances above a remote host's tier are disabled, and the
// title states why. Stop is not one of them.

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupSidebarDom, makeSampleProject } = require('./dom-setup');
const { computeHostProfile, TMUX_MISSING_REASON } = require('../remote-host-profile');

const AT = Date.parse('2026-10-01T10:00:00Z');

function session(extra = {}) {
  return {
    sessionId: 'remote-1',
    summary: 'ripcord protocol',
    modified: '2026-09-06T10:00:00.000Z',
    starred: false,
    archived: 0,
    messageCount: 4,
    projectPath: '/srv/supervision',
    remoteAlias: 'planificator',
    remoteDescriptorSeen: true,
    ...extra,
  };
}

function project(profile, s) {
  return makeSampleProject({
    projectPath: '/srv/supervision',
    folder: 'planificator::-srv-supervision',
    remoteAlias: 'planificator',
    remoteHostAt: AT,
    remoteHostError: null,
    remoteHostProfile: profile,
    sessions: [s],
  });
}

function render(ctx, profile, s) {
  ctx.window.sessionMap.set(s.sessionId, s);
  ctx.sidebar.renderProjects([project(profile, s)], true);
  const header = ctx.document.getElementById('ph-' + ctx.sidebar.folderId('/srv/supervision'));
  return { header, item: ctx.document.getElementById('si-remote-1') };
}

test('the new-session button is disabled and its title gives the launch tier reason', () => {
  const ctx = setupSidebarDom();
  try {
    const profile = computeHostProfile({ at: AT, error: null, descriptors: [] });
    const { header } = render(ctx, profile, session());
    const btn = header.querySelector('.project-new-btn');
    assert.equal(btn.disabled, true);
    assert.match(btn.title, /planificator/);
    assert.ok(btn.title.includes('new sessions cannot be started from here; they must be started on the host'), btn.title);
  } finally { ctx.destroy(); }
});

test('a host with no profile keeps the plain read-only title on the new-session button', () => {
  const ctx = setupSidebarDom();
  try {
    const { header } = render(ctx, undefined, session());
    const btn = header.querySelector('.project-new-btn');
    assert.equal(btn.disabled, true);
    assert.match(btn.title, /Read-only mirror of planificator/);
  } finally { ctx.destroy(); }
});

test('the send button is disabled with the reason as title, and a click opens nothing', () => {
  const ctx = setupSidebarDom();
  try {
    const { item } = render(ctx, undefined, session({ remoteSendBlocked: 'no live session reports a messagingSocketPath on a POSIX path' }));
    const btn = item.querySelector('.session-send-btn');
    assert.equal(btn.disabled, true);
    assert.match(btn.title, /Send unavailable: no live session reports a messagingSocketPath/);
    const dialogs = [];
    ctx.window.showSendPromptDialog = (s) => dialogs.push(s.sessionId);
    btn.onclick({ stopPropagation() {} });
    assert.deepEqual(dialogs, [], 'a disabled button must not reach the dialog even if its handler is called');
  } finally { ctx.destroy(); }
});

test('the send button stays enabled and titled as before when nothing blocks it', () => {
  const ctx = setupSidebarDom();
  try {
    const { item } = render(ctx, undefined, session({ remoteSendBlocked: null }));
    const btn = item.querySelector('.session-send-btn');
    assert.equal(btn.disabled, false);
    assert.match(btn.title, /^Send a prompt/);
    const dialogs = [];
    ctx.window.showSendPromptDialog = (s) => dialogs.push(s.sessionId);
    btn.click();
    assert.deepEqual(dialogs, ['remote-1']);
  } finally { ctx.destroy(); }
});

test('the stop button is never disabled, even when attach and send are withheld', () => {
  const ctx = setupSidebarDom();
  try {
    const { item } = render(ctx, undefined, session({
      remoteAttachable: false, remoteAttachBlocked: TMUX_MISSING_REASON, remoteSendBlocked: 'no socket',
    }));
    const btn = item.querySelector('.session-stop-btn');
    assert.ok(btn);
    assert.equal(btn.disabled, false);
  } finally { ctx.destroy(); }
});

test('a row on a host without tmux opens its transcript and the title states the tmux reason', () => {
  const ctx = setupSidebarDom();
  try {
    const { item } = render(ctx, undefined, session({ remoteAttachable: false, remoteAttachBlocked: TMUX_MISSING_REASON }));
    assert.ok(item.title.includes('Attach unavailable: ' + TMUX_MISSING_REASON), item.title);
    assert.ok(item.querySelector('.remote-badge').title.includes(TMUX_MISSING_REASON));
    const viewed = [];
    const opened = [];
    ctx.window.showJsonlViewer = (s) => viewed.push(s.sessionId);
    ctx.window.openSession = (s) => opened.push(s.sessionId);
    item.onclick();
    assert.deepEqual(viewed, ['remote-1']);
    assert.deepEqual(opened, []);
  } finally { ctx.destroy(); }
});

test('the host dot says live updates are off when inotifywait is known missing, and only then', () => {
  const ctx = setupSidebarDom();
  try {
    const missing = computeHostProfile({ at: AT, error: null, descriptors: [], tools: { tmux: true, inotifywait: false } });
    let { header } = render(ctx, missing, session());
    assert.match(header.querySelector('.remote-host-dot').title, /inotifywait is not installed: only the periodic pull runs/);
    for (const tools of [{ tmux: true, inotifywait: true }, null]) {
      const profile = computeHostProfile({ at: AT, error: null, descriptors: [], tools });
      ({ header } = render(ctx, profile, session()));
      assert.doesNotMatch(header.querySelector('.remote-host-dot').title, /inotifywait/, JSON.stringify(tools));
    }
  } finally { ctx.destroy(); }
});
