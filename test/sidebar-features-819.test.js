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
  ctx.window.api.getSessionLiveElsewhere = async () => null;
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

test('older archive names eligible and kept rows and locks slug groups', async () => {
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
    assert.match(confirm.title, /2 older sessions/);
    assert.match(confirm.message, /1.*visible|first 1/i);
    assert.match(confirm.message, /3650.*days/);
    assert.match(confirm.message, /refused/);
    assert.match(confirm.message, /good/);
    assert.match(confirm.message, /remote.*kept|kept.*remote/is);
    assert.deepEqual(calls, ['archive:refused', 'archive:good']);
    assert.equal(rows[1].archived, 1);
    assert.equal(rows[2].archived, 1);
    assert.equal(rows[3].archived, 0);
    ctx.sidebar.renderProjects([project]);
    assert.match(ctx.document.getElementById('app-notices').textContent, /2 sessions archived/);
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
    assert.deepEqual(archived.sort(), ['good']);
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

test('an idle busy edge without arming readiness clears manual unread through the PTY adapter', () => {
  const ctx = setupSidebarDom();
  try {
    const row = session('pty');
    ctx.window.sessionMap.set('pty', row);
    ctx.window.activePtyIds.add('pty');
    ctx.sidebar.renderProjects([{ projectPath: '/proj', sessions: [row] }], true);
    ctx.window.markUnread('pty');
    ctx.setActivity('pty', false, 'test', { armReady: false });
    assert.equal(ctx.read("localPtyStates.get('pty').snapshot().manualUnread"), false);
    assert.equal(ctx.responseReadySessions.has('pty'), false);
    assert.equal(ctx.document.querySelector('.session-item').classList.contains('response-ready'), false);
  } finally { ctx.destroy(); }
});

test('unchanged activity does not rewrite unread button attributes or reparse its SVG per row', async () => {
  const ctx = setupSidebarDom();
  try {
    const descriptor = Object.getOwnPropertyDescriptor(ctx.window.Element.prototype, 'innerHTML');
    let parses = 0;
    Object.defineProperty(ctx.window.Element.prototype, 'innerHTML', { ...descriptor, set(value) {
      if (this.classList.contains('session-unread-btn')) parses++;
      descriptor.set.call(this, value);
    } });
    olderFixture(ctx);
    assert.equal(parses, 0, 'clone the unread template instead of parsing for each row');
    const button = ctx.document.querySelector('.session-unread-btn');
    const observer = new ctx.window.MutationObserver(() => {});
    observer.observe(button, { attributes: true, attributeFilter: ['title', 'aria-label'] });
    ctx.window.applyStateClasses('recent', ctx.window.storedActivitySnapshot('recent'));
    assert.equal(observer.takeRecords().length, 0);
    ctx.window.markUnread('recent');
    assert.equal(button.title, 'Mark as read');
    assert.equal(observer.takeRecords().length, 2);
    observer.disconnect();
  } finally { ctx.destroy(); }
});

test('preflight refusal plus Cancel produces no notice and counts only eligible rows', async () => {
  const ctx = setupSidebarDom();
  try {
    olderFixture(ctx);
    ctx.window.api.bgAgentLiveJob = async id => id === 'refused' ? { known: true, job: { id: 'abcd1234' } } : { known: true };
    let confirm;
    ctx.window.appConfirm = async options => { confirm = options; return false; };
    await ctx.document.querySelector('.sessions-older-archive-btn').onclick(new ctx.window.MouseEvent('click'));
    assert.equal(ctx.document.getElementById('app-notices').textContent, '');
    assert.match(confirm.title, /1 older session\?/);
    assert.match(confirm.message, /good/);
    assert.match(confirm.message, /refused.*background job abcd1234/s);
    assert.equal(ctx.document.getElementById('app-notices').textContent, '');
  } finally { ctx.destroy(); }
});

test('all refused produces one notice and no confirmation', async () => {
  const ctx = setupSidebarDom();
  try {
    olderFixture(ctx);
    ctx.window.api.bgAgentLiveJob = async () => ({ known: true, job: { id: 'abcd1234' } });
    let confirms = 0;
    ctx.window.appConfirm = async () => { confirms++; return true; };
    await ctx.document.querySelector('.sessions-older-archive-btn').onclick(new ctx.window.MouseEvent('click'));
    assert.equal(confirms, 0);
    assert.equal(ctx.document.querySelectorAll('#app-notices > *').length, 1);
    assert.match(ctx.document.getElementById('app-notices').textContent, /Nothing.*archive/is);
    assert.equal(ctx.document.querySelector('.sessions-older-archive-btn').disabled, true);
  } finally { ctx.destroy(); }
});

test('older batch keeps active, closed open tabs, live elsewhere, and remote live rows by name', async () => {
  const ctx = setupSidebarDom();
  try {
    const { rows, project } = olderFixture(ctx);
    rows.push(session('on-screen', { modified: '2026-01-01' }), session('closed-tab', { modified: '2026-01-01' }), session('elsewhere', { modified: '2026-01-01' }));
    for (const row of rows) ctx.window.sessionMap.set(row.sessionId, row);
    ctx.window.activeSessionId = 'on-screen';
    ctx.window.openSessions.set('closed-tab', { closed: true });
    ctx.window.api.getSessionLiveElsewhere = async id => id === 'elsewhere' ? { kind: 'interactive', pid: 123 } : null;
    ctx.sidebar.renderProjects([project], true);
    const writes = [];
    ctx.window.api.archiveSession = async id => { writes.push(id); return { ok: true }; };
    ctx.window.api.remoteStopSession = async () => assert.fail('bulk archive must not stop remote sessions');
    let confirm;
    ctx.window.appConfirm = async options => { confirm = options; return true; };
    await ctx.document.querySelector('.sessions-older-archive-btn').onclick(new ctx.window.MouseEvent('click'));
    assert.match(confirm.title, /2 older sessions/);
    assert.match(confirm.message, /on-screen.*active/i);
    assert.match(confirm.message, /closed-tab.*tab.*open/i);
    assert.match(confirm.message, /elsewhere.*live elsewhere/i);
    assert.match(confirm.message, /remote.*host/i);
    assert.deepEqual(writes.sort(), ['good', 'refused']);
    assert.equal(ctx.document.querySelector('.sessions-older-archive-btn').disabled, true);
    ctx.sidebar.renderProjects([project]);
    assert.equal(ctx.document.querySelector('.sessions-older').querySelectorAll('.session-item:not([data-subagent])').length, 6);
    assert.equal(ctx.document.querySelector('.sessions-more-label').textContent, '+ 6 older');
  } finally { ctx.destroy(); }
});

test('confirmation lists cap eligible names with a remaining count', async () => {
  const ctx = setupSidebarDom();
  try {
    ctx.window.api.getSessionLiveElsewhere = async () => null;
    ctx.window.visibleSessionCount = 1;
    const rows = [session('recent'), ...Array.from({ length: 14 }, (_, i) => session(`old-${i}`, { modified: '2026-01-01' }))];
    for (const row of rows) ctx.window.sessionMap.set(row.sessionId, row);
    ctx.sidebar.renderProjects([{ projectPath: '/proj', sessions: rows }], true);
    let confirm;
    ctx.window.appConfirm = async options => { confirm = options; return false; };
    await ctx.document.querySelector('.sessions-older-archive-btn').onclick(new ctx.window.MouseEvent('click'));
    assert.match(confirm.title, /14 older sessions/);
    assert.match(confirm.message, /old-0/);
    assert.match(confirm.message, /\+4 more/);
    assert.doesNotMatch(confirm.message, /old-13/);
  } finally { ctx.destroy(); }
});

test('a row becoming live elsewhere during confirmation is kept and never stopped', async () => {
  const ctx = setupSidebarDom();
  try {
    olderFixture(ctx);
    const archived = [];
    ctx.window.api.archiveSession = async id => { archived.push(id); return { ok: true }; };
    ctx.window.api.stopSession = async () => assert.fail('bulk archive must not stop a newly live session');
    ctx.window.appConfirm = async () => {
      ctx.window.api.getSessionLiveElsewhere = async id => id === 'good' ? { kind: 'interactive' } : null;
      return true;
    };
    await ctx.document.querySelector('.sessions-older-archive-btn').onclick(new ctx.window.MouseEvent('click'));
    assert.deepEqual(archived, ['refused']);
  } finally { ctx.destroy(); }
});

test('older count includes every displayed conversation while zero eligible rows disable archive', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.window.visibleSessionCount = 1;
    const rows = [session('recent'), session('kept', { remoteAlias: 'vps', remoteDescriptorSeen: true, modified: '2026-01-01' }),
      session('already-archived', { archived: 1, modified: '2026-01-01' })];
    for (const row of rows) ctx.window.sessionMap.set(row.sessionId, row);
    ctx.sidebar.renderProjects([{ projectPath: '/proj', sessions: rows }], true);
    assert.equal(ctx.document.querySelector('.sessions-more-label').textContent, '+ 2 older');
    ctx.document.querySelector('.sessions-more-label').click();
    ctx.document.querySelector('.sessions-more-label').click();
    assert.equal(ctx.document.querySelector('.sessions-more-label').textContent, '+ 2 older');
    assert.equal(ctx.document.querySelector('.sessions-older-archive-btn').disabled, true);
  } finally { ctx.destroy(); }
});
