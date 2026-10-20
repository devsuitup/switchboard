'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

const row = { sessionId: 'A', mergedMemberIds: ['B'], projectPath: '/project', summary: 'Conversation', modified: new Date().toISOString() };

function setup(t, session = row) {
  session = { ...session };
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  ctx.window.sessionMap.set(session.sessionId, session);
  ctx.sidebar.renderProjects([makeSampleProject({ projectPath: session.projectPath, sessions: [session] })], true);
  return ctx;
}

function open(ctx, id) {
  ctx.window.openSessions.set(id, { closed: false });
}

function recordingApi(ctx) {
  ctx.window.appConfirm = async () => true;
  const calls = [];
  ctx.window.api.bgAgentLiveJob = async () => ({ known: true, job: null });
  ctx.window.api.stopSession = async id => { calls.push(['stop', id]); return { ok: true }; };
  ctx.window.api.remoteStopSession = async (alias, id) => { calls.push(['remoteStop', alias, id]); return { ok: true }; };
  ctx.window.api.archiveSession = async (id, value) => { calls.push(['archive', id, value]); return { ok: true }; };
  ctx.window.api.deleteSession = async id => { calls.push(['delete', id]); return { ok: true }; };
  return calls;
}

async function click(ctx, id, action) {
  const button = ctx.document.querySelector(`#si-${id} .session-${action}-btn`);
  await button.onclick({ stopPropagation() {} });
  return button;
}

test('a remote merged representative rebuild keeps its Working icon consistent with cli-busy', t => {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  ctx.read("remoteState('A').apply({ type: 'liveness', value: 'alive' }); remoteState('A').apply({ type: 'busy', active: true })");
  ctx.emitHeadTurn('A', 'open');
  for (let rebuild = 0; rebuild < 2; rebuild++) {
    const item = ctx.sidebar.buildSessionItem({ ...row, remoteAlias: 'host' });
    assert.ok(item.classList.contains('cli-busy'));
    assert.equal(item.querySelector('.session-icon').title, 'Working');
  }
});

test('a merged representative rebuild uses its stored transcript activity for the icon', t => {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  ctx.read("localTranscriptState('A').apply({ type: 'liveness', value: 'alive' }); localTranscriptState('A').apply({ type: 'busy', active: true })");
  ctx.emitHeadTurn('A', 'open');
  const item = ctx.sidebar.buildSessionItem({ ...row, status: 'busy', statusUpdatedAt: Date.now() });
  assert.ok(item.classList.contains('cli-busy'));
  assert.equal(item.querySelector('.session-icon').title, 'Working');
});

test('a merged local member still paints Working exactly once', t => {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  ctx.window.activePtyIds.add('B');
  ctx.setActivity('B', true, 'test');
  ctx.emitHeadTurn('B', 'open');
  let paints = 0;
  const original = ctx.window.writeIconSlot;
  ctx.window.writeIconSlot = (...args) => { paints++; return original(...args); };
  const item = ctx.sidebar.buildSessionItem({ ...row, headSessionId: 'B' });
  assert.ok(item.classList.contains('cli-busy'));
  assert.equal(item.querySelector('.session-icon').title, 'Working');
  assert.equal(paints, 1);
});

test('Archive proceeds for a plain local row with an open tab that is not running', async t => {
  const ctx = setup(t, { ...row, sessionId: 'X', mergedMemberIds: [] });
  const calls = recordingApi(ctx);
  open(ctx, 'X');
  ctx.window.api.stopSession = async id => { calls.push(['stop', id]); return { ok: false, error: 'not running' }; };
  assert.equal(ctx.window.activePtyIds.has('X'), false);
  await click(ctx, 'X', 'archive');
  assert.deepEqual(calls.filter(call => call[0] === 'archive'), [['archive', 'X', 1]]);
});

test('Archive proceeds for a plain remote row whose open tab is absent on its host', async t => {
  const ctx = setup(t, { ...row, sessionId: 'X', mergedMemberIds: [], remoteAlias: 'host' });
  const calls = recordingApi(ctx);
  open(ctx, 'X');
  ctx.read("remoteState('X').apply({ type: 'liveness', value: 'dead' })");
  ctx.window.api.remoteStopSession = async (alias, id) => { calls.push(['remoteStop', alias, id]); return { ok: false, error: 'session not found on that host' }; };
  await click(ctx, 'X', 'archive');
  assert.deepEqual(calls.filter(call => call[0] === 'archive'), [['archive', 'X', 1]]);
});

test('Archive stops a running merged member before archiving its representative', async t => {
  const ctx = setup(t);
  const calls = recordingApi(ctx);
  open(ctx, 'B');
  ctx.window.activePtyIds.add('B');
  await click(ctx, 'A', 'archive');
  assert.deepEqual(calls, [['stop', 'B'], ['archive', 'A', 1]]);
  assert.equal(ctx.window.activePtyIds.has('B'), false);
});

test('Archive still stops an open running member before the poll catches up', async t => {
  const ctx = setup(t);
  const calls = recordingApi(ctx);
  open(ctx, 'B');
  await click(ctx, 'A', 'archive');
  assert.deepEqual(calls, [['stop', 'B'], ['archive', 'A', 1]]);
});

test('Archive still refuses a genuine remote stop failure', async t => {
  const ctx = setup(t, { ...row, remoteAlias: 'host' });
  const calls = recordingApi(ctx);
  ctx.read("remoteState('B').apply({ type: 'liveness', value: 'alive' })");
  ctx.window.api.remoteStopSession = async (alias, id) => { calls.push(['remoteStop', alias, id]); return { ok: false, error: 'host unreachable' }; };
  await click(ctx, 'A', 'archive');
  assert.deepEqual(calls, [['remoteStop', 'host', 'B']]);
  assert.match(ctx.document.querySelector('[role="alert"]').textContent, /host unreachable/);
});

test('Delete stops then deletes a merged row when only its representative tab runs', async t => {
  const ctx = setup(t);
  const calls = recordingApi(ctx);
  open(ctx, 'A');
  ctx.window.activePtyIds.add('A');
  ctx.window.showDeleteSessionDialog = async session => ({ partIds: [session.sessionId, ...session.mergedMemberIds] });
  await click(ctx, 'A', 'delete');
  assert.deepEqual(calls, [['stop', 'A'], ['delete', 'A']]);
});

for (const state of ['live', 'open']) {
  test(`Delete refuses ${state === 'open' ? 'an open' : 'a live'} merged member without stopping the representative`, async t => {
    const ctx = setup(t);
    const calls = recordingApi(ctx);
    ctx.window.activePtyIds.add('A');
    if (state === 'live') ctx.window.activePtyIds.add('B');
    else open(ctx, 'B');
    ctx.window.showDeleteSessionDialog = async () => { assert.fail('Delete confirmation must not open'); };
    await click(ctx, 'A', 'delete');
    assert.deepEqual(calls, []);
    assert.match(ctx.document.querySelector('[role="alert"]').textContent, /merged member is still running/);
  });
}

test('Archive stops an unseeded remote member with a seen descriptor before hiding the row', async t => {
  const ctx = setup(t, { ...row, remoteAlias: 'host', remoteDescriptorSeen: true });
  const calls = recordingApi(ctx);
  ctx.read("remoteState('A').apply({ type: 'liveness', value: 'dead' }); remoteSessionStates.delete('B')");
  assert.equal(ctx.remoteSessionStates.has('B'), false);
  await click(ctx, 'A', 'archive');
  assert.deepEqual(calls, [['remoteStop', 'host', 'B'], ['archive', 'A', 1]]);
  assert.equal(ctx.remoteSessionStates.get('B').snapshot().liveness, 'dead');
});

test('Archive leaves a confirmed dead remote member alone despite a seen descriptor', async t => {
  const ctx = setup(t, { ...row, remoteAlias: 'host', remoteDescriptorSeen: true });
  const calls = recordingApi(ctx);
  ctx.read("remoteState('A').apply({ type: 'liveness', value: 'dead' }); remoteState('B').apply({ type: 'liveness', value: 'dead' })");
  await click(ctx, 'A', 'archive');
  assert.deepEqual(calls, [['archive', 'A', 1]]);
});

test('a plain remote row keeps confirmed dead liveness over a stale descriptor', t => {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  ctx.read("remoteState('X').apply({ type: 'liveness', value: 'dead' })");
  const item = ctx.sidebar.buildSessionItem({ ...row, sessionId: 'X', mergedMemberIds: [], remoteAlias: 'host', remoteDescriptorSeen: true });
  assert.equal(item.classList.contains('is-alive'), false);
});
