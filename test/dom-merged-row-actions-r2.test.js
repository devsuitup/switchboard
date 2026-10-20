'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');
const cache = require('../session-cache');

const row = { sessionId: 'A', mergedMemberIds: ['B', 'C'], projectPath: '/project', summary: 'Conversation', modified: new Date().toISOString() };

function setup(t, session = row) {
  session = { ...session };
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  ctx.window.sessionMap.set(session.sessionId, session);
  ctx.sidebar.renderProjects([makeSampleProject({ projectPath: session.projectPath, sessions: [session] })], true);
  return ctx;
}

test('a click on a merged row with nothing open opens its head', t => {
  const session = { ...row, headSessionId: 'B' };
  const ctx = setup(t, session);
  const opened = [];
  ctx.window.openSession = target => opened.push(target);
  ctx.document.getElementById('si-A').click();
  assert.deepEqual(opened.map(target => target.sessionId), ['B']);
  assert.deepEqual(Array.from(opened[0].mergedMemberIds), ['C', 'A']);
  assert.equal(opened[0].summary, session.summary);
  assert.equal(ctx.window.sessionMap.get('A').sessionId, 'A');
});

function open(ctx, id, closed = false) {
  const element = ctx.document.createElement('div');
  element.className = 'terminal-container visible';
  const terminals = ctx.document.getElementById('terminals');
  terminals.appendChild(element);
  const entry = { element, closed, session: { ...row, sessionId: id }, terminal: { focus() {}, options: {} } };
  ctx.window.openSessions.set(id, entry);
  return entry;
}

function grid(ctx) {
  Object.assign(ctx.window, {
    terminalsEl: ctx.document.getElementById('terminals'), gridViewActive: false,
    isMac: false, replayHiddenBuffer() {}, updateRunningIndicators() {},
    setActiveSession(id) { ctx.window.activeSessionId = id; },
    clearNotifications() {}, lruTouch() {}, refreshRemoteTerminalOnReturn() {},
  });
  ctx.window.Element.prototype.scrollIntoView = function () {};
  ctx.evalPublic('shortcuts.js');
  ctx.evalPublic('grid-view.js');
}

for (const grouped of [true, false]) {
  test(`grid ${grouped ? 'grouped' : 'flat'} layout wraps every open merged member in sidebar order`, t => {
    const ctx = setup(t);
    grid(ctx);
    open(ctx, 'B');
    open(ctx, 'A');
    const c = open(ctx, 'C', true);
    ctx.read(`gridGroupByProject = ${grouped}`);
    assert.deepEqual(Array.from(ctx.window.layoutGridCards(ctx.window.openGridSessionIds())), ['A', 'B']);
    assert.deepEqual(Array.from(ctx.document.querySelectorAll('.grid-card'), el => el.dataset.sessionId), ['A', 'B']);
    assert.ok(ctx.window.openSessions.get('B').element.classList.contains('visible'));
    assert.equal(c.element.classList.contains('visible'), false);
    assert.equal(ctx.document.querySelectorAll('.grid-project-heading').length, grouped ? 1 : 0);
  });
}

test('session navigation includes open merged members and skips closed members', t => {
  const ctx = setup(t);
  grid(ctx);
  open(ctx, 'B');
  open(ctx, 'A');
  open(ctx, 'C', true);
  assert.deepEqual(Array.from(ctx.window.getOrderedOpenSessionIds()), ['A', 'B']);
  const shown = [];
  ctx.window.showSession = id => shown.push(id);
  ctx.window.activeSessionId = 'A';
  ctx.window.navigateSession(1);
  ctx.window.activeSessionId = 'B';
  ctx.window.navigateSession(1);
  assert.deepEqual(shown, ['B', 'A']);
});

test('focusing a merged member grid card highlights its representative row', t => {
  const ctx = setup(t);
  grid(ctx);
  open(ctx, 'B');
  ctx.window.wrapInGridCard('B');
  ctx.window.focusGridCard('B');
  assert.equal(ctx.window.activeSessionId, 'B');
  assert.ok(ctx.document.getElementById('si-A').classList.contains('active'));
  assert.ok(ctx.document.querySelector('.grid-card.focused[data-session-id="B"]'));
});

function recordingApi(ctx, failedId = null) {
  ctx.confirmations = [];
  ctx.window.appConfirm = async options => { ctx.confirmations.push(options); return true; };
  const calls = [];
  ctx.window.api.bgAgentLiveJob = async () => ({ known: true, job: null });
  ctx.window.api.stopSession = async id => {
    calls.push(['stop', id]);
    return id === failedId ? { ok: false, error: 'stop refused' } : { ok: true };
  };
  ctx.window.api.archiveSession = async (id, value) => { calls.push(['archive', id, value]); return { ok: true }; };
  ctx.window.api.deleteSession = async id => { calls.push(['delete', id]); return { ok: true }; };
  return calls;
}

test('Archive stops every open or running merged member before hiding the representative', async t => {
  const ctx = setup(t);
  const calls = recordingApi(ctx);
  open(ctx, 'B');
  ctx.window.activePtyIds.add('C');
  await ctx.document.querySelector('#si-A .session-archive-btn').onclick({ stopPropagation() {} });
  assert.deepEqual(calls, [['stop', 'B'], ['stop', 'C'], ['archive', 'A', 1]]);
  assert.equal(ctx.confirmations.length, 1);
  assert.match(ctx.confirmations[0].message, /2 running processes[\s\S]*Part B.*in this window[\s\S]*Part C.*in this window/);
  assert.equal(ctx.window.activePtyIds.has('C'), false);
});

test('a merged member stop failure blocks Archive and surfaces the existing failure message', async t => {
  const ctx = setup(t, { ...row });
  const calls = recordingApi(ctx, 'B');
  ctx.window.activePtyIds.add('B');
  const button = ctx.document.querySelector('#si-A .session-archive-btn');
  await button.onclick({ stopPropagation() {} });
  assert.deepEqual(calls, [['stop', 'B']]);
  assert.equal(ctx.confirmations.length, 1);
  assert.match(ctx.confirmations[0].message, /Part B.*in this window/);
  assert.equal(ctx.window.activePtyIds.has('B'), true);
  assert.equal(ctx.window.sessionMap.get('A').archived || 0, 0);
  assert.match(ctx.document.querySelector('[role="alert"]').textContent, /stop refused/);
});

test('Archive checks all member background jobs before stopping any member', async t => {
  const ctx = setup(t);
  const calls = recordingApi(ctx);
  ctx.window.activePtyIds.add('B');
  ctx.window.api.bgAgentLiveJob = async id => ({ known: true, job: id === 'C' ? { id: 'job-C' } : null });
  const button = ctx.document.querySelector('#si-A .session-archive-btn');
  await button.onclick({ stopPropagation() {} });
  assert.deepEqual(calls, []);
  assert.match(ctx.document.querySelector('[role="alert"]').textContent, /background job job-C/);
  assert.equal(ctx.confirmations.length, 0);
  assert.ok(ctx.window.activePtyIds.has('B'));
});

test('Archive stops live remote members on their host and leaves dead members alone', async t => {
  const ctx = setup(t, { ...row, remoteAlias: 'host' });
  const calls = recordingApi(ctx);
  ctx.read("remoteState('B').apply({ type: 'liveness', value: 'alive' }); remoteState('C').apply({ type: 'liveness', value: 'dead' })");
  ctx.window.api.remoteStopSession = async (alias, id) => { calls.push(['remoteStop', alias, id]); return { ok: true }; };
  await ctx.document.querySelector('#si-A .session-archive-btn').onclick({ stopPropagation() {} });
  assert.deepEqual(calls, [['remoteStop', 'host', 'B'], ['archive', 'A', 1]]);
  assert.equal(ctx.confirmations.length, 1);
  assert.match(ctx.confirmations[0].message, /Part B.*on host/);
  assert.equal(ctx.remoteSessionStates.get('B').snapshot().liveness, 'dead');
});

test('Delete refuses a live merged member without stopping or deleting anything', async t => {
  const ctx = setup(t);
  const calls = recordingApi(ctx);
  ctx.window.activePtyIds.add('B');
  ctx.window.showDeleteSessionDialog = async () => true;
  const button = ctx.document.querySelector('#si-A .session-delete-btn');
  await button.onclick({ stopPropagation() {} });
  assert.deepEqual(calls, []);
  assert.match(ctx.document.querySelector('[role="alert"]').textContent, /still running/);
});

test('Delete refuses an open merged member even before the running poll catches up', async t => {
  const ctx = setup(t);
  const calls = recordingApi(ctx);
  open(ctx, 'B');
  ctx.window.showDeleteSessionDialog = async () => true;
  const button = ctx.document.querySelector('#si-A .session-delete-btn');
  await button.onclick({ stopPropagation() {} });
  assert.deepEqual(calls, []);
  assert.match(ctx.document.querySelector('[role="alert"]').textContent, /still running/);
});

for (const ownOpen of [false, true]) {
  test(`Refresh screen uses an open merged member${ownOpen ? ' before the representative' : ''}`, t => {
    const ctx = setup(t, { ...row, headSessionId: 'B' });
    open(ctx, 'B', true);
    open(ctx, 'C');
    if (ownOpen) open(ctx, 'A');
    const refreshed = [];
    ctx.window.requestTerminalRefresh = id => refreshed.push(id);
    ctx.document.getElementById('si-A').oncontextmenu({ preventDefault() {}, stopPropagation() {}, clientX: 10, clientY: 10 });
    const button = ctx.document.querySelector('.session-refresh-btn');
    assert.equal(button.disabled, false);
    button.click();
    assert.deepEqual(refreshed, ['C']);
  });
}

function cachedRow(ctx) {
  const base = { projectPath: '/project', folder: 'project', created: '2026-10-10T10:00:00Z', messageCount: 1 };
  const rows = [
    { ...base, sessionId: 'A', modified: '2026-10-10T10:00:00Z' },
    { ...base, sessionId: 'B', mergedIntoSessionId: 'A', modified: '2026-10-10T11:00:00Z' },
    { ...base, sessionId: 'C', mergedIntoSessionId: 'A', modified: '2026-10-10T12:00:00Z' },
  ];
  cache.init({ PROJECTS_DIR: '/project', activeSessions: new Map(), getMainWindow: () => null, log: console, db: {
    getAllCached: () => rows, getAllMeta: () => new Map(), getAllFolderMeta: () => new Map(), getSetting: () => ({}),
  } });
  const session = cache.buildProjectsFromCache(false).flatMap(p => p.sessions).find(s => s.sessionId === 'A');
  ctx.window.sessionMap.set('A', session);
  ctx.sidebar.renderProjects([makeSampleProject({ projectPath: '/project', sessions: [session] })], true);
  return session;
}

for (const ownOpen of [false, true]) {
  test(`cached member order makes openSession prefer its head${ownOpen ? ' over its representative open tab' : ''}`, async t => {
    const ctx = setup(t);
    const session = cachedRow(ctx);
    const shown = [];
    Object.assign(ctx.window, { restoringWorkingSet: false, sessionOpenedOutsideRestore: false, continuationRetryCancelled: false, showSession: id => shown.push(id) });
    open(ctx, 'B');
    open(ctx, 'C');
    if (ownOpen) open(ctx, 'A');
    const { openSession } = loadAppFunctions(ctx.context, { functions: ['openSession', 'openSessionNow', 'indexedRowOf', 'indexedSessionById', 'dormantRowIds', 'syncDormantRow', 'clearDormantRow'], declarations: ['openingSessions', 'dormantWorkingSet'] });
    await openSession(session);
    assert.deepEqual(shown, ['C']);
  });
}

test('Stop passes the whole cached row once for all its live members', async t => {
  const ctx = setup(t);
  const session = cachedRow(ctx);
  const stopped = [];
  ctx.window.activePtyIds.add('B');
  ctx.window.activePtyIds.add('C');
  ctx.window.confirmAndStopSession = row => stopped.push(row);
  const button = ctx.document.querySelector('#si-A .session-stop-btn');
  await button.onclick({ stopPropagation() {} });
  assert.deepEqual(stopped, [session]);
  assert.deepEqual(Array.from(stopped[0].mergedMemberIds), ['C', 'B']);
});

test('Stop includes the live representative and every cached member in the same row request', async t => {
  const ctx = setup(t);
  const session = cachedRow(ctx);
  const stopped = [];
  for (const id of ['A', 'B', 'C']) ctx.window.activePtyIds.add(id);
  ctx.window.confirmAndStopSession = row => stopped.push(row);
  await ctx.document.querySelector('#si-A .session-stop-btn').onclick({ stopPropagation() {} });
  assert.deepEqual(stopped, [session]);
  assert.deepEqual(Array.from(ctx.window.rowSessionIds(stopped[0])), ['A', 'C', 'B']);
});

test('a remote merged row retains a confirmed dead state over a stale descriptor', t => {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  ctx.read("remoteState('A').apply({ type: 'liveness', value: 'dead' })");
  const item = ctx.sidebar.buildSessionItem({ ...row, remoteAlias: 'host', remoteDescriptorSeen: true });
  assert.equal(item.classList.contains('is-alive'), false);
});

test('a remote merged row with a seen descriptor paints alive before remote state is seeded', t => {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const item = ctx.sidebar.buildSessionItem({ ...row, remoteAlias: 'host', remoteDescriptorSeen: true });
  assert.equal(ctx.remoteSessionStates.has('A'), false);
  assert.ok(item.classList.contains('is-alive'));
});

test('a merged row paints its local icon once while retaining member activity', t => {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  ctx.window.activePtyIds.add('B');
  ctx.setActivity('B', true, 'test');
  ctx.emitHeadTurn('B', 'open');
  let paints = 0;
  const original = ctx.window.writeIconSlot;
  ctx.window.writeIconSlot = (...args) => { paints++; return original(...args); };
  const item = ctx.sidebar.buildSessionItem({ ...row, headSessionId: 'B' });
  assert.equal(item.querySelector('.session-icon').title, 'Working · Open here');
  assert.equal(paints, 1);
});
