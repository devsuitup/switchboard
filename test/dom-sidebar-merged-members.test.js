'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

const row = { sessionId: 'A', headSessionId: 'B', mergedMemberIds: ['B', 'C'], summary: 'Conversation', modified: new Date().toISOString(), messageCount: 3 };

function turn(ctx, sessionId, state) {
  const revision = (ctx.turnRevision || 0) + 1;
  ctx.turnRevision = revision;
  ctx.window.applyHeadTurnSnapshot({ sessionId, state, revision });
}

function render(ctx, sessions = [row]) {
  ctx.window.sessionMap = new Map(sessions.map(s => [s.sessionId, s]));
  ctx.sidebar.renderProjects([makeSampleProject({ sessions })], true);
  return ctx.document.getElementById('si-A');
}

test('a merged row renders the running indicator of its live member', t => {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  ctx.window.activePtyIds.add('B');
  const item = render(ctx);
  assert.ok(item.classList.contains('has-running-pty'));
  assert.ok(item.querySelector('.session-icon').classList.contains('running'));
});

test('a merged row is active when its open member is active', t => {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  ctx.window.openSessions.set('B', { terminal: { focus() {} } });
  ctx.window.activeSessionId = 'B';
  assert.ok(render(ctx).classList.contains('active'));
});

test('showSession highlights the merged row when switching to its member', t => {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const item = render(ctx);
  Object.assign(ctx.window, {
    gridViewActive: true, agentsViewActive: false, gridCards: new Map([['B', {}]]),
    terminalsEl: { classList: { contains: () => true } },
    setActiveSession: id => { ctx.window.activeSessionId = id; }, clearNotifications() {}, lruTouch() {}, focusGridCard() {},
  });
  ctx.window.openSessions.set('B', { session: { sessionId: 'B' } });
  const { showSession } = loadAppFunctions(ctx.context, { functions: ['showSession'], sourcePath: path.join(__dirname, '../public/terminal-manager.js') });
  showSession('B');
  assert.ok(item.classList.contains('active'));
});

for (const [name, prepare, className] of [
  ['busy', ctx => { ctx.window.activePtyIds.add('B'); turn(ctx, 'B', 'open'); }, 'cli-busy'],
  ['attention', ctx => ctx.attentionSessions.add('B'), 'needs-attention'],
  ['response ready', ctx => { turn(ctx, 'B', 'open'); turn(ctx, 'B', 'closed'); }, 'response-ready'],
]) {
  test(`a merged row renders its member's ${name} state`, t => {
    const ctx = setupSidebarDom();
    t.after(() => ctx.destroy());
    prepare(ctx);
    assert.ok(render(ctx).classList.contains(className));
  });
}

test('member activity updates the merged row and a sibling idle update preserves it', t => {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const item = render(ctx);
  ctx.window.activePtyIds.add('B');
  turn(ctx, 'B', 'open');
  ctx.setActivity('B', true, 'test');
  assert.ok(item.classList.contains('cli-busy'));
  ctx.setActivity('C', false, 'test');
  assert.ok(item.classList.contains('cli-busy'));
  ctx.setActivity('B', false, 'test');
  turn(ctx, 'B', 'closed');
  assert.ok(item.classList.contains('response-ready'));
  ctx.read("setAttention('B', true, 'test')");
  assert.ok(item.classList.contains('needs-attention'));
});

test('running polls keep a merged member running and clear it when the member stops', t => {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const item = render(ctx);
  Object.assign(ctx.window, { gridCards: new Map(), terminalHeaderStatus: {}, renderDefaultStatus() {} });
  const { updateRunningIndicators } = loadAppFunctions(ctx.context, { functions: ['updateRunningIndicators'], declarations: ['_lastPtySignature'] });
  ctx.window.activePtyIds.add('B');
  updateRunningIndicators();
  turn(ctx, 'B', 'open');
  assert.ok(item.classList.contains('has-running-pty'));
  ctx.setActivity('B', true, 'test');
  ctx.window.activePtyIds.add('unrelated');
  updateRunningIndicators();
  assert.ok(item.classList.contains('cli-busy'));
  ctx.window.activePtyIds.delete('B');
  updateRunningIndicators();
  assert.equal(item.classList.contains('has-running-pty'), false);
  assert.equal(item.classList.contains('cli-busy'), false);
});

test('the running filter and ordering include a row whose merged member is live', t => {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  ctx.window.activePtyIds.add('B');
  const sessions = [{ sessionId: 'other', modified: new Date(Date.now() + 1000).toISOString() }, row];
  render(ctx, sessions);
  assert.equal(ctx.document.querySelector('.session-item').dataset.sessionId, 'A');
  ctx.window.showRunningOnly = true;
  assert.ok(render(ctx, sessions));
  assert.equal(ctx.document.getElementById('si-other'), null);
});

test('a slug group promotes a row whose merged member is live', t => {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  ctx.window.activePtyIds.add('B');
  render(ctx, [{ ...row, scheduleSlug: 'group' }, { sessionId: 'other', scheduleSlug: 'group', modified: row.modified }]);
  assert.ok(ctx.document.querySelector('.slug-group-dot.running'));
  assert.ok(ctx.document.querySelector('.slug-group.has-promoted'));
});

test('a sibling projection preserves the merged member waiting-for-input icon', t => {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const item = render(ctx);
  ctx.window.activePtyIds.add('B');
  turn(ctx, 'B', 'closed');
  ctx.setActivity('B', false, 'test', { armReady: false });
  assert.equal(item.querySelector('.session-icon').title, 'Waiting for input');
  ctx.read("projectLocalPtyState('A')");
  assert.equal(item.querySelector('.session-icon').title, 'Waiting for input');
});

test('a sibling transcript decay preserves the head with an open turn', t => {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const item = render(ctx);
  ctx.window.activePtyIds.add('B');
  turn(ctx, 'B', 'open');
  ctx.emitSessionTranscriptActivity({ sessionId: 'B' });
  ctx.emitSessionTranscriptActivity({ sessionId: 'C' });
  ctx.read("decayLocalTranscriptBusy('C')");
  assert.ok(item.classList.contains('cli-busy'));
  assert.ok(render(ctx).classList.contains('cli-busy'));
});

test('the merged row stop control passes every member to the shared Stop plan', t => {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  ctx.window.activePtyIds.add('B');
  const stopped = [];
  ctx.window.confirmAndStopSession = row => stopped.push(row);
  const item = render(ctx);
  item.querySelector('.session-stop-btn').click();
  assert.equal(stopped.length, 1);
  assert.deepEqual(Array.from(ctx.window.rowSessionIds(stopped[0])), ['A', 'B', 'C']);
});

test('member subagent transitions keep the merged row busy until all members finish', t => {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const item = render(ctx);
  for (const id of ['B', 'C']) {
    ctx.window.activePtyIds.add(id);
    ctx.setActivity(id, false, 'test', { armReady: false });
    ctx.emitSubagentSpawned({ parentSessionId: id, agentId: 'worker' });
  }
  assert.ok(item.classList.contains('has-busy-agents'));
  ctx.emitSubagentCompleted({ parentSessionId: 'B', agentId: 'worker' });
  assert.ok(item.classList.contains('has-busy-agents'));
  ctx.emitSubagentCompleted({ parentSessionId: 'C', agentId: 'worker' });
  assert.equal(item.classList.contains('has-busy-agents'), false);
});

test('running polls attach the actual remote member and retain its local activity', t => {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const remoteRow = { ...row, remoteAlias: 'host', remoteAttachable: true };
  const item = render(ctx, [remoteRow]);
  Object.assign(ctx.window, { gridCards: new Map(), terminalHeaderStatus: {}, renderDefaultStatus() {} });
  const { updateRunningIndicators } = loadAppFunctions(ctx.context, { functions: ['updateRunningIndicators'], declarations: ['_lastPtySignature'] });
  ctx.read("remoteState('B')");
  ctx.window.activePtyIds.add('B');
  updateRunningIndicators();
  assert.equal(ctx.remoteSessionStates.get('B').snapshot().attached, true);
  assert.equal(ctx.remoteSessionStates.get('A').snapshot().attached, false);
  turn(ctx, 'B', 'open');
  ctx.setActivity('B', true, 'test');
  ctx.read("decayRemoteBusy('B')");
  assert.ok(item.classList.contains('cli-busy'));
});

test('a remote merged member stays alive across render and Stop keeps its host', async t => {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const remoteRow = { ...row, remoteAlias: 'host', remoteAttachable: true };
  const item = render(ctx, [remoteRow]);
  ctx.read("remoteState('B').apply({ type: 'liveness', value: 'alive' }); projectRemoteState('B')");
  assert.ok(item.classList.contains('is-alive'));
  assert.ok(render(ctx, [remoteRow]).classList.contains('is-alive'));
  const stopped = [];
  Object.assign(ctx.window, { appConfirm: async () => true, gridViewActive: false, refreshSidebar() {} });
  ctx.window.api.remoteStopSession = async (alias, id) => { stopped.push([alias, id]); return { ok: true }; };
  ctx.window.api.stopSession = async id => { stopped.push(['local', id]); return { ok: true }; };
  loadAppFunctions(ctx.context, { functions: ['confirmAndStopSession'] });
  await ctx.document.querySelector('#si-A .session-stop-btn').onclick({ stopPropagation() {} });
  assert.deepEqual(stopped, [['host', 'B']]);
});

test('remote member subagent activity survives a merged row render', t => {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const remoteRow = { ...row, remoteAlias: 'host', remoteAttachable: true };
  render(ctx, [remoteRow]);
  ctx.window.onRemoteActivityEvent({ kind: 'subagent', parentSessionId: 'B', agentId: 'worker' });
  assert.ok(ctx.document.getElementById('si-A').classList.contains('has-busy-agents'));
  assert.ok(render(ctx, [remoteRow]).classList.contains('has-busy-agents'));
});
