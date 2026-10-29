'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom } = require('./dom-setup');
const { createSessionState } = require('../public/session-state');

function session(id, extra = {}) {
  return { sessionId: id, projectPath: '/proj', summary: id, modified: new Date().toISOString(), archived: 0, ...extra };
}

test('markUnread is a reducer event cleared by reading and fresh activity', () => {
  const state = createSessionState('local-pty');
  state.apply({ type: 'markUnread' });
  assert.equal(state.snapshot().responseReady, true);
  state.apply({ type: 'clearUnread' });
  assert.equal(state.snapshot().responseReady, false);
  state.apply({ type: 'markUnread' });
  state.apply({ type: 'busy', active: true });
  assert.equal(state.snapshot().responseReady, false);
});

for (const remote of [false, true]) test(`unread action reaches the head and survives repaint (${remote ? 'remote' : 'local'})`, () => {
  const ctx = setupSidebarDom();
  try {
    const row = session('original', { headSessionId: 'head', mergedMemberIds: ['head'], ...(remote ? { remoteAlias: 'vps' } : {}) });
    const project = { projectPath: '/proj', sessions: [row] };
    ctx.window.sessionMap.set(row.sessionId, row);
    ctx.sidebar.renderProjects([project], true);
    let button = ctx.document.querySelector('.session-unread-btn');
    assert.ok(button, 'keyboard reachable unread action exists');
    assert.equal(button.tagName, 'BUTTON');
    assert.equal(button.getAttribute('aria-label'), 'Mark as unread');
    button.focus();
    button.click();
    assert.equal(ctx.responseReadySessions.has('head'), true);
    assert.equal(ctx.responseReadySessions.has('original'), false);
    ctx.sidebar.renderProjects([project]);
    assert.equal(ctx.document.querySelectorAll('.session-item .session-icon').length, 1);
    assert.ok(ctx.document.querySelector('.session-icon--response-ready'));
    button = ctx.document.querySelector('.session-unread-btn');
    assert.equal(button.getAttribute('aria-label'), 'Mark as read');
    button.click();
    assert.equal(ctx.document.querySelector('.session-item').classList.contains('response-ready'), false);
    ctx.window.markUnread('head');
    ctx.window.clearUnread('head', 'test-open');
    assert.equal(ctx.document.querySelector('.session-item').classList.contains('response-ready'), false);
  } finally { ctx.destroy(); }
});

function olderFixture(ctx) {
  ctx.window.visibleSessionCount = 1;
  const rows = [session('recent'), session('refused', { scheduleSlug: 'batch', modified: '2026-01-01T00:00:00Z' }),
    session('good', { scheduleSlug: 'batch', modified: '2026-01-01T00:00:00Z' }),
    session('remote', { remoteAlias: 'vps', remoteDescriptorSeen: true, modified: '2026-01-01T00:00:00Z' }),
    session('child', { parentSessionId: 'good', agentId: 'a1', modified: '2026-01-01T00:00:00Z' })];
  const project = { projectPath: '/proj', sessions: rows };
  for (const row of rows) ctx.window.sessionMap.set(row.sessionId, row);
  ctx.sidebar.renderProjects([project], true);
  return { rows, project };
}

test('older archive confirms the rule, continues after refused stop, warns about remote, and locks slug groups', async () => {
  const ctx = setupSidebarDom();
  try {
    const { rows, project } = olderFixture(ctx);
    const button = ctx.document.querySelector('.sessions-older-archive-btn');
    assert.ok(button, 'bulk archive button exists');
    assert.equal(ctx.document.querySelector('.sessions-more-label').textContent, '+ 3 older');
    const calls = [];
    let confirm;
    ctx.window.appConfirm = async options => {
      confirm = options;
      ctx.window.activePtyIds.add('refused');
      ctx.window.activePtyIds.add('good');
      assert.ok(ctx.read('archivingGroupIds.size') >= 2, 'older batch and nested slug group locked');
      ctx.sidebar.renderProjects([project]);
      assert.equal(ctx.document.querySelector('.sessions-older-archive-btn').disabled, true);
      assert.equal(ctx.document.querySelector('.slug-group-archive-btn').disabled, true);
      return true;
    };
    ctx.window.api.stopSession = async id => { calls.push(`stop:${id}`); return id === 'refused' ? { ok: false, error: 'stop refused' } : { ok: true }; };
    ctx.window.api.remoteStopSession = async () => ({ ok: false, hostUnreachable: true, error: 'offline' });
    ctx.window.api.archiveSession = async id => { calls.push(`archive:${id}`); return { ok: true }; };
    await button.onclick(new ctx.window.MouseEvent('click'));
    assert.match(confirm.title, /3 older sessions/);
    assert.match(confirm.message, /1.*visible|first 1/i);
    assert.match(confirm.message, /3650.*days/);
    assert.deepEqual(calls, ['archive:remote', 'stop:refused', 'stop:good', 'archive:good'], ctx.document.getElementById('app-notices').textContent);
    assert.equal(rows[1].archived, 0);
    assert.equal(rows[2].archived, 1);
    assert.equal(rows[3].archived, 1);
    assert.match(ctx.document.getElementById('app-notices').textContent, /stop refused/);
    assert.match(ctx.document.getElementById('app-notices').textContent, /Archived, but not stopped.*offline/s);
    ctx.sidebar.renderProjects([project]);
    assert.match(ctx.document.getElementById('app-notices').textContent, /stop refused/);
    assert.equal(ctx.read('archivingGroupIds.size'), 0);
    assert.equal(ctx.read('archivingSessionIds.size'), 0);
  } finally { ctx.destroy(); }
});

test('older archive cancellation has no side effects and keeps its controls', async () => {
  const ctx = setupSidebarDom();
  try {
    olderFixture(ctx);
    let writes = 0;
    ctx.window.api.archiveSession = async () => { writes++; return { ok: true }; };
    ctx.window.appConfirm = async () => false;
    const button = ctx.document.querySelector('.sessions-older-archive-btn');
    assert.ok(button, 'bulk archive button exists');
    await button.onclick(new ctx.window.MouseEvent('click'));
    assert.equal(writes, 0);
    assert.equal(button.disabled, false);
    ctx.document.querySelector('.sessions-more-label').click();
    assert.equal(ctx.document.querySelector('.sessions-older').style.display, '');
    assert.ok(ctx.document.querySelector('.sessions-older-archive-btn'));
  } finally { ctx.destroy(); }
});

test('older archive reports background-job refusal with the existing Stop session recovery and archives other rows', async () => {
  const ctx = setupSidebarDom();
  try {
    const { rows } = olderFixture(ctx);
    const archived = [];
    ctx.window.api.bgAgentLiveJob = async id => id === 'refused' ? { known: true, job: { id: 'abcd1234' } } : { known: true };
    ctx.window.api.archiveSession = async id => { archived.push(id); return { ok: true }; };
    ctx.window.appConfirm = async () => true;
    const button = ctx.document.querySelector('.sessions-older-archive-btn');
    assert.ok(button, 'bulk archive button exists');
    await button.onclick(new ctx.window.MouseEvent('click'));
    assert.deepEqual(archived.sort(), ['good', 'remote']);
    assert.equal(rows[1].archived, 0);
    assert.match(ctx.document.getElementById('app-notices').textContent, /background job abcd1234.*Stop session/s);
  } finally { ctx.destroy(); }
});

test('older archive keeps persistence failures visible and archives later rows', async () => {
  const ctx = setupSidebarDom();
  try {
    const { rows, project } = olderFixture(ctx);
    ctx.window.appConfirm = async () => true;
    ctx.window.api.archiveSession = async id => id === 'refused' ? { ok: false, error: 'disk unavailable' } : { ok: true };
    await ctx.document.querySelector('.sessions-older-archive-btn').onclick(new ctx.window.MouseEvent('click'));
    assert.equal(rows[1].archived, 0);
    assert.equal(rows[2].archived, 1);
    ctx.sidebar.renderProjects([project]);
    const failure = ctx.document.querySelector('[role="alert"]');
    assert.ok(failure);
    assert.match(failure.textContent, /refused.*disk unavailable/s);
    assert.equal(ctx.read('archivingSessionIds.size'), 0);
  } finally { ctx.destroy(); }
});

test('remote attention consumes a manually unread head', () => {
  const ctx = setupSidebarDom();
  try {
    const row = session('remote', { remoteAlias: 'vps', remoteDescriptorSeen: true, status: 'idle', statusUpdatedAt: 1 });
    ctx.window.sessionMap.set('remote', row);
    const project = { projectPath: '/proj', sessions: [row] };
    ctx.sidebar.renderProjects([project], true);
    ctx.document.querySelector('.session-unread-btn').click();
    row.status = 'waiting';
    row.statusUpdatedAt = 2;
    ctx.sidebar.renderProjects([project]);
    row.status = 'idle';
    row.statusUpdatedAt = 3;
    ctx.sidebar.renderProjects([project]);
    assert.equal(ctx.document.querySelector('.session-item').classList.contains('response-ready'), false, 'attention consumes unread rather than hiding it temporarily');
  } finally { ctx.destroy(); }
});

test('a fresh open head clears manual unread without changing recorded liveness', () => {
  const ctx = setupSidebarDom();
  try {
    const row = session('head');
    ctx.window.sessionMap.set('head', row);
    ctx.sidebar.renderProjects([{ projectPath: '/proj', sessions: [row] }], true);
    ctx.document.querySelector('.session-unread-btn').click();
    ctx.emitHeadTurn('head', 'open');
    assert.equal(ctx.document.querySelector('.session-item').classList.contains('response-ready'), false, 'fresh head activity clears manual unread');
    assert.equal(ctx.read("localPtyStates.get('head').snapshot().liveness"), 'unknown');
  } finally { ctx.destroy(); }
});
