const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');
const fs = require('node:fs');
const path = require('node:path');
const { extractFunction } = require('./app-source');
const { computeHostProfile, attachBlockReason, sendBlockReason } = require('../src/main/remote/remote-host-profile');

const now = Date.parse('2026-10-20T12:00:00Z');
const cases = [
  { status: 'busy', text: '1m ago' },
  { status: 'idle', text: '1m ago' },
  { status: 'shell', text: '1m ago' },
  { status: 'waiting', waitingFor: 'permission prompt', text: 'permission prompt · 1m ago' },
];

function sessionFor(entry) {
  return { sessionId: 'status-563', summary: 'Foreground session', modified: new Date(now).toISOString(),
    statusUpdatedAt: now - 60000, ...entry };
}

test('a merged row uses the head descriptor for its first, live and refreshed status', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.window.Date.now = () => now;
    ctx.evalPublic('agents-view.js');
    const session = sessionFor({ status: 'busy', statusUpdatedAt: now - 120000,
      headSessionId: 'head-563', mergedMemberIds: ['head-563'],
      mergedMemberStatuses: { 'head-563': { status: 'idle', statusUpdatedAt: now - 60000, waitingFor: null } } });
    ctx.window.activePtyIds.add(session.headSessionId);
    ctx.window.sessionMap.set(session.sessionId, session);
    const check = row => {
      assert.equal(row.querySelector('.session-status').textContent, '1m ago');
      const slot = row.querySelector('.session-icon');
      assert.match(slot.title, /\nCLI status: idle$/);
      assert.match(slot.getAttribute('aria-label'), / · CLI status: idle$/);
      return { line: row.querySelector('.session-status').textContent,
        title: slot.title, name: slot.getAttribute('aria-label') };
    };
    const first = check(ctx.sidebar.buildSessionItem(session));
    ctx.sidebar.renderProjects([makeSampleProject({ sessions: [session] })], true);
    const item = ctx.document.getElementById('si-' + session.sessionId);
    assert.deepEqual(check(item), first);
    ctx.window.applyStateClasses(session.headSessionId,
      ctx.window.snapshotForLocal(session.headSessionId, session));
    assert.deepEqual(check(item), first);
    ctx.window.paintSessionIcon(item.querySelector('.session-icon'), session.sessionId, session);
    assert.deepEqual(check(item), first);
  } finally { ctx.destroy(); }
});

test('a merged waiting head exposes its own reason instead of the root reason', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.window.Date.now = () => now;
    ctx.evalPublic('agents-view.js');
    const session = sessionFor({ status: 'waiting', waitingFor: 'root reason',
      headSessionId: 'head-563', mergedMemberIds: ['head-563'],
      mergedMemberStatuses: { 'head-563': { status: 'waiting', statusUpdatedAt: now - 60000, waitingFor: 'question' } } });
    const item = ctx.sidebar.buildSessionItem(session);
    assert.equal(item.querySelector('.session-status').textContent, 'question · 1m ago');
    assert.match(item.querySelector('.session-icon').title, /CLI status: waiting · question$/);
    ctx.window.paintSessionIcon(item.querySelector('.session-icon'), session.sessionId, session);
    assert.match(item.querySelector('.session-icon').title, /CLI status: waiting · question$/);
  } finally { ctx.destroy(); }
});

for (const rootSeen of [false, true]) for (const status of ['busy', 'idle', 'waiting']) {
  test(`a remote merged ${status} head keeps base liveness and icon with root descriptor ${rootSeen ? 'present' : 'absent'}`, () => {
    const ctx = setupSidebarDom();
    try {
      ctx.window.Date.now = () => now;
      const descriptors = [
        ...(rootSeen ? [{ sessionId: 'A', status: 'shell', statusUpdatedAt: now - 120000, waitingFor: 'root reason' }] : []),
        { sessionId: 'B', status, statusUpdatedAt: now - 60000, waitingFor: status === 'waiting' ? 'permission prompt' : null },
      ];
      const annotate = new Function('remoteIndexer', 'remoteAttachAdapter', 'remoteActivityTracker',
        'cliSessionState', 'attachBlockReason', 'sendBlockReason',
        extractFunction(fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8'), 'annotateRemoteAttachable')
          + '\nreturn annotateRemoteAttachable;')({
        getRemoteSessions: () => ({ sessions: descriptors, at: now, error: null }),
        getRemoteHostState: () => ({ consecutiveFailures: 0, nextAttemptAt: 0 }),
        getRemoteHostProfile: () => computeHostProfile({ at: now, error: null, descriptors }),
      }, { supports: () => false }, { activeAt: () => null }, {}, attachBlockReason, sendBlockReason);
      const session = sessionFor({ sessionId: 'A', headSessionId: 'B',
        mergedMemberIds: ['B'], remoteAlias: 'host' });
      annotate([{ remoteAlias: 'host', sessions: [session] }]);
      ctx.window.sessionMap.set(session.sessionId, session);
      ctx.window.applyRemoteDescriptor(session);
      const check = (item, seeded = false) => {
        const reason = status === 'waiting' ? 'permission prompt · ' : '';
        assert.equal(item.querySelector('.session-status').textContent, reason + '1m ago');
        const slot = item.querySelector('.session-icon');
        const detail = `CLI status: ${status}${status === 'waiting' ? ' · permission prompt' : ''}`;
        assert.ok(slot.title.endsWith('\n' + detail), slot.title);
        assert.ok(slot.getAttribute('aria-label').endsWith(' · ' + detail));
        assert.doesNotMatch(slot.title, /root reason|CLI status: shell/);
        assert.equal(item.classList.contains('is-alive'), seeded || rootSeen, 'd1b956fc liveness');
        assert.equal(slot.className, 'session-icon session-icon--' + (seeded ? 'waiting' : 'idle'), 'd1b956fc icon slot');
      };
      check(ctx.sidebar.buildSessionItem(session));
      ctx.sidebar.renderProjects([makeSampleProject({ remoteAlias: 'host', sessions: [session] })], true);
      const item = ctx.document.getElementById('si-' + session.sessionId);
      check(item, true);
      ctx.window.paintSessionIcon(item.querySelector('.session-icon'), session.sessionId, session);
      check(item, true);
      const local = ctx.window.snapshotForLocal(session.headSessionId);
      assert.equal(local.liveness, 'unknown', 'an implicit member lookup cannot seed local liveness');
    } finally { ctx.destroy(); }
  });
}

test('a remote attention repaint preserves the descriptor status and waiting reason', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.window.Date.now = () => now;
    const session = sessionFor({ status: 'waiting', waitingFor: 'permission prompt',
      remoteAlias: 'host-563', remoteDescriptorSeen: true });
    ctx.window.applyRemoteDescriptor(session);
    const state = ctx.remoteSessionStates.get(session.sessionId);
    assert.equal(state.snapshot().attention, true);
    assert.equal(state.snapshot().attached, false);
    const item = ctx.sidebar.buildSessionItem(session);
    const slot = item.querySelector('.session-icon');
    assert.ok(slot.classList.contains('session-icon--attention'));
    assert.match(slot.title, /\nCLI status: waiting · permission prompt$/);
    assert.match(slot.getAttribute('aria-label'), / · CLI status: waiting · permission prompt$/);
    assert.equal(item.querySelector('.session-status').textContent, 'permission prompt · 1m ago');
  } finally { ctx.destroy(); }
});

test('first render keeps reason plus age and the status slot for every CLI status', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.window.Date.now = () => now;
    ctx.evalPublic('agents-view.js');
    for (const entry of [...cases, cases[1]]) {
      const item = ctx.sidebar.buildSessionItem(sessionFor(entry));
      const status = item.querySelector('.session-status');
      assert.ok(status, entry.status);
      assert.equal(status.textContent, entry.text, entry.status);
      assert.doesNotMatch(status.textContent.toLowerCase(), /\b(busy|idle|waiting|shell)\b/);
    }
  } finally { ctx.destroy(); }
});

test('live descriptor updates keep the same reason plus age as the first render', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.window.Date.now = () => now;
    ctx.evalPublic('agents-view.js');
    const session = sessionFor({ status: 'idle' });
    ctx.window.activePtyIds.add(session.sessionId);
    ctx.sidebar.renderProjects([makeSampleProject({ sessions: [session] })], true);
    const item = ctx.document.getElementById('si-' + session.sessionId);
    for (const entry of [...cases, cases[1]]) {
      const updated = sessionFor(entry);
      ctx.window.sessionMap.set(session.sessionId, updated);
      ctx.window.applyStateClasses(session.sessionId, ctx.window.snapshotForLocal(session.sessionId, updated));
      assert.equal(item.querySelector('.session-status').textContent, entry.text, entry.status);
      assert.equal(item.querySelector('.session-status').textContent,
        ctx.sidebar.buildSessionItem(updated).querySelector('.session-status').textContent);
    }
  } finally { ctx.destroy(); }
});

test('first and live status slots expose the CLI status and reason in title and aria-label', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.window.Date.now = () => now;
    ctx.evalPublic('agents-view.js');
    const session = sessionFor({ status: 'idle' });
    ctx.window.activePtyIds.add(session.sessionId);
    ctx.sidebar.renderProjects([makeSampleProject({ sessions: [session] })], true);
    const item = ctx.document.getElementById('si-' + session.sessionId);
    for (const entry of [...cases, cases[1]]) {
      const updated = sessionFor(entry);
      ctx.window.sessionMap.set(session.sessionId, updated);
      ctx.window.applyStateClasses(session.sessionId, ctx.window.snapshotForLocal(session.sessionId, updated));
      for (const row of [ctx.sidebar.buildSessionItem(updated), item]) {
        const slot = row.querySelector('.session-icon');
        assert.equal(slot.getAttribute('role'), 'img');
        for (const label of [slot.title, slot.getAttribute('aria-label')]) {
          assert.match(label, new RegExp('\\b' + entry.status + '\\b'), entry.status);
          if (entry.waitingFor) assert.ok(label.includes(entry.waitingFor), label);
          else assert.ok(!label.includes('permission prompt'), 'the previous reason is cleared');
        }
        if (row === item) {
          const title = slot.title;
          const accessibleName = slot.getAttribute('aria-label');
          ctx.window.paintSessionIcon(slot, session.sessionId, updated);
          assert.equal(slot.title, title, 'an icon refresh keeps the descriptor detail');
          assert.equal(slot.getAttribute('aria-label'), accessibleName);
        }
      }
    }
  } finally { ctx.destroy(); }
});
