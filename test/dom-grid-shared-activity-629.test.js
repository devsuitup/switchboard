'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

function setup(t, kind = 'local-pty', overrides = {}) {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const session = { sessionId: 'head-629', name: 'Shared activity', status: 'busy', modified: new Date().toISOString(),
    ...(kind === 'remote' ? { remoteAlias: 'host', remoteDescriptorSeen: true } : {}),
    ...(kind === 'background' ? { bgJobId: 'job-629', bgSessionId: 'head-629' } : {}), ...overrides };
  Object.assign(ctx.window, {
    terminalsEl: ctx.document.getElementById('terminals'), gridViewActive: false,
    replayHiddenBuffer() {}, renderDefaultStatus() {},
  });
  ctx.window.sessionMap.set(session.sessionId, session);
  ctx.window.activeSessionId = session.sessionId;
  if (kind === 'local-pty') ctx.window.activePtyIds.add(session.sessionId);
  const render = () => ctx.sidebar.renderProjects([makeSampleProject({ sessions: [session],
    ...(kind === 'remote' ? { remoteAlias: 'host' } : {}) })], true);
  render();
  ctx.evalPublic('shortcuts.js');
  ctx.evalPublic('grid-view.js');
  loadAppFunctions(ctx.context, { functions: ['updateRunningIndicators'], declarations: ['_lastPtySignature'] });
  const element = ctx.document.createElement('div');
  ctx.window.openSessions.set(session.sessionId, { session, element, terminal: { focus() {}, buffer: { active: { viewportY: 0, baseY: 0 } } } });
  const create = () => { ctx.window.wrapInGridCard(session.sessionId); return ctx.document.querySelector('.grid-card'); };
  let revision = 0;
  const turn = state => ctx.emitHeadTurn(session.headSessionId || session.sessionId, state, { revision: ++revision });
  const tasks = entries => ctx.window.taskRegistry.applySnapshot({ parentSessionId: session.sessionId, revision: ++revision,
    known: true, tasks: entries.map(entry => ({ at: Date.now(), kind: 'agent', terminal: false, ...entry })) });
  return { ctx, session, render, create, turn, tasks };
}

test('#629 process exit preserves the local exit reason after its descriptor disappears', t => {
  const { ctx, session, create } = setup(t);
  const card = create();
  delete session.status;
  ctx.window.schedulePersistWorkingSet = () => {};
  loadAppFunctions(ctx.context, { functions: ['applyProcessExit'] });
  ctx.window.applyProcessExit(session.sessionId, 1, null, false);
  assert.equal(card.querySelector('.grid-card-footer').firstChild.textContent, 'Exited (code 1)');
  assert.equal(card.querySelector('.grid-card-stop-btn').style.display, 'none');
});

for (const kind of ['local-pty', 'local-transcript', 'remote', 'background']) {
  test(`#629 ${kind}: footer separates attachment, liveness and remembered exit information`, t => {
    const { ctx, session, create, render } = setup(t, kind);
    const card = create();
    const footer = () => card.querySelector('.grid-card-footer').firstChild.textContent;
    assert.equal(footer(), kind === 'local-pty' ? 'Running' : 'Running elsewhere');
    ctx.window.noteSessionExit(session.sessionId, 1, null, false);
    ctx.window.updateRunningIndicators();
    assert.equal(footer(), kind === 'local-pty' ? 'Running' : 'Running elsewhere', 'live process wins over an old exit');
    ctx.window.activePtyIds.delete(session.sessionId);
    delete session.status;
    session.remoteDescriptorSeen = false;
    ctx.window.dropLocalPtySession(session.sessionId, 'process-exited');
    render();
    ctx.window.updateRunningIndicators();
    assert.equal(footer(), 'Exited (code 1)');
    ctx.window.noteSessionExit(session.sessionId, null, 'SIGTERM', false);
    ctx.window.updateRunningIndicators();
    assert.equal(footer(), 'Killed (SIGTERM)');
    ctx.window.noteSessionExit(session.sessionId, 1, null, true);
    ctx.window.updateRunningIndicators();
    assert.equal(footer(), 'Stopped');
    ctx.window.forgetSessionExit(session.sessionId);
    ctx.window.updateRunningIndicators();
    assert.equal(footer(), 'Liveness unknown');
    const state = kind === 'remote' ? ctx.remoteSessionStates.get(session.sessionId) : ctx.window.localPtyState(session.sessionId);
    state.apply({ type: 'liveness', value: 'dead' });
    ctx.window.updateRunningIndicators();
    assert.equal(footer(), 'Stopped');
  });
}

test('#629 one head update looks up and paints only its indexed card', t => {
  const { ctx, create, turn } = setup(t);
  const card = create();
  for (const id of ['unrelated-1', 'unrelated-2']) {
    const session = { sessionId: id, modified: new Date().toISOString() };
    ctx.window.sessionMap.set(id, session);
    ctx.window.openSessions.set(id, { session, element: ctx.document.createElement('div') });
    ctx.window.wrapInGridCard(id);
  }
  const lookups = [];
  const get = ctx.window.sessionMap.get.bind(ctx.window.sessionMap);
  ctx.window.sessionMap.get = id => { lookups.push(id); return get(id); };
  const paints = [];
  for (const el of ctx.document.querySelectorAll('.grid-card')) {
    const query = el.querySelector.bind(el);
    el.querySelector = selector => { if (selector === '.grid-card-dot') paints.push(el.dataset.sessionId); return query(selector); };
  }
  turn('open');
  assert.deepEqual(paints, ['head-629']);
  assert.equal(card.querySelector('.grid-card-dot').title, 'Working');
  assert.deepEqual(lookups, ['head-629', 'head-629', 'head-629']);
});

test('#629 busy head with running agents shares the sidebar violet tint', t => {
  const { ctx, create, turn, tasks } = setup(t);
  const card = create();
  turn('open');
  tasks([{ id: 'A' }]);
  parity(ctx, card, 'Working');
  assert.equal(card.classList.contains('has-busy-agents'), true);
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/style.css'), 'utf8');
  assert.match(css, /\.grid-card\.has-busy-agents\s+\.session-icon--busy::before[^{}]*\{\s*color:\s*(?:#8088ff|var\(--accent\))/);
  tasks([]);
  assert.equal(card.classList.contains('has-busy-agents'), false);
});

test('#629 indexed membership follows hidden merged-row changes, aliases, re-key and removal', t => {
  const { ctx, session, create, render } = setup(t, 'local-transcript', { mergedMemberIds: ['old-member'] });
  const card = create();
  session.mergedMemberIds = ['new-member'];
  render();
  ctx.document.getElementById('si-' + session.sessionId).remove();
  ctx.window.indexLocalMergedMemberRows([makeSampleProject({ sessions: [session] })]);
  const paints = [];
  const query = card.querySelector.bind(card);
  card.querySelector = selector => { if (selector === '.grid-card-dot') paints.push(card.dataset.sessionId); return query(selector); };
  ctx.window.applyStateClasses('old-member', {});
  assert.deepEqual(paints, [], 'removed member no longer visits the card');
  ctx.window.taskRegistry.applySnapshot({ parentSessionId: 'new-member', revision: 1, known: true,
    tasks: [{ id: 'A', kind: 'agent', terminal: false, at: Date.now() }] });
  assert.equal(card.querySelector('.grid-subagent-count').textContent, '1 subagent running');
  ctx.window.taskRegistry.rekey('new-member', 'aliased-member', { continued: true });
  ctx.window.taskRegistry.end('aliased-member', 'A');
  assert.equal(card.querySelector('.grid-subagent-count'), null, 'canonical member updates still reach the card');
  const next = { ...session, sessionId: 'rekeyed-card' };
  const entry = ctx.window.openSessions.get(session.sessionId);
  ctx.window.openSessions.delete(session.sessionId);
  ctx.window.openSessions.set(next.sessionId, { ...entry, session: next });
  ctx.window.sessionMap.delete(session.sessionId);
  ctx.window.sessionMap.set(next.sessionId, next);
  ctx.window.rekeyGridCard(session.sessionId, next.sessionId);
  paints.length = 0;
  ctx.window.applyStateClasses(next.sessionId, {});
  assert.deepEqual(paints, [next.sessionId]);
  ctx.window.destroyGridCard(next.sessionId);
  paints.length = 0;
  ctx.window.applyStateClasses('aliased-member', {});
  assert.deepEqual(paints, [], 'destroyed card leaves no indexed references');
  assert.equal(ctx.read('gridCardsByMember.size'), 0);
  assert.equal(ctx.read('gridCardMemberKeys.size'), 0);
});

test('#629 a shared member updates both matching cards and unwrapping clears the index', t => {
  const { ctx, session, create } = setup(t, 'local-transcript', { mergedMemberIds: ['shared-member'] });
  create();
  const sibling = { ...session, sessionId: 'sibling-card' };
  ctx.window.sessionMap.set(sibling.sessionId, sibling);
  ctx.window.openSessions.set(sibling.sessionId, { session: sibling, element: ctx.document.createElement('div') });
  ctx.window.wrapInGridCard(sibling.sessionId);
  ctx.window.taskRegistry.applySnapshot({ parentSessionId: 'shared-member', revision: 1, known: true,
    tasks: [{ id: 'A', kind: 'agent', terminal: false, at: Date.now() }] });
  for (const card of ctx.document.querySelectorAll('.grid-card')) {
    assert.equal(card.querySelector('.grid-subagent-count').textContent, '1 subagent running');
  }
  ctx.window.unwrapGridCards();
  assert.equal(ctx.read('gridCardsByMember.size'), 0);
  assert.equal(ctx.read('gridCardMemberKeys.size'), 0);
});

function parity(ctx, card, expected) {
  const sidebar = ctx.window.sessionItemEl(card.dataset.sessionId);
  const icon = sidebar.querySelector('.session-icon');
  const slot = card.querySelector('.grid-card-dot');
  assert.equal(slot.dataset.glyph, icon.dataset.glyph, 'grid and sidebar glyph match');
  assert.equal(slot.title, icon.title, 'grid and sidebar tooltip match');
  assert.equal(slot.getAttribute('aria-label'), icon.getAttribute('aria-label'));
  const classes = el => [...el.classList].filter(c => c.startsWith('session-icon--')).sort();
  assert.deepEqual(classes(slot), classes(icon));
  assert.equal(slot.title, expected);
  assert.equal(card.querySelectorAll('.grid-card-dot').length, 1);
  assert.equal(card.classList.contains('unseen-written-activity'), sidebar.classList.contains('unseen-written-activity'));
  assert.equal(card.querySelector('.grid-subagent-count')?.textContent, sidebar.querySelector('.session-subagent-count')?.textContent);
}

for (const kind of ['local-pty', 'local-transcript', 'remote', 'background']) {
  test(`#629 ${kind}: grid follows head turns, static work, attention and response-ready immediately`, t => {
    const { ctx, create, turn, tasks } = setup(t, kind);
    const card = create();
    turn('open');
    parity(ctx, card, 'Working');
    ctx.window.noteWrittenActivity('head-629');
    parity(ctx, card, 'Working');
    assert.equal(card.classList.contains('unseen-written-activity'), true);
    turn('closed');
    parity(ctx, card, 'Waiting for input');
    tasks([{ id: 'A' }]);
    parity(ctx, card, 'Background work running');
    assert.equal(card.querySelector('.grid-subagent-count').textContent, '1 subagent running');
    tasks([{ id: 'A', terminal: true }, { id: 'shell', kind: 'bash' }, { id: 'cron', kind: 'cron' }]);
    parity(ctx, card, 'Background work running');
    assert.equal(card.querySelector('.grid-subagent-count'), null);
    tasks([]);
    turn('open');
    ctx.window.activeSessionId = 'elsewhere';
    turn('closed');
    parity(ctx, card, 'Response ready');
    tasks([{ id: 'A' }]);
    parity(ctx, card, 'Response ready');
    if (kind === 'remote') ctx.window.applyRemoteDescriptor({ ...ctx.window.sessionMap.get('head-629'), status: 'waiting' });
    else ctx.window.setAttention('head-629', true);
    parity(ctx, card, 'Needs your attention');
    if (kind === 'remote') ctx.window.applyRemoteDescriptor({ ...ctx.window.sessionMap.get('head-629'), status: 'busy' });
    else ctx.window.setAttention('head-629', false);
    parity(ctx, card, 'Background work running');
  });
}

test('#629 unattached live, unknown and dead liveness are distinct from activity', t => {
  const { ctx, session, create, turn, render } = setup(t, 'remote');
  const card = create();
  turn('open');
  assert.equal(card.querySelector('.grid-card-footer').firstChild.textContent, 'Running elsewhere');
  assert.equal(card.querySelector('.grid-card-stop-btn').style.display, '');
  session.status = null;
  session.remoteDescriptorSeen = false;
  render();
  ctx.window.updateRunningIndicators();
  parity(ctx, card, 'Idle');
  assert.equal(card.querySelector('.grid-card-footer').firstChild.textContent, 'Liveness unknown');
  ctx.remoteSessionStates.get(session.sessionId).apply({ type: 'liveness', value: 'dead' });
  ctx.window.applyStateClasses(session.sessionId, ctx.remoteSessionStates.get(session.sessionId).snapshot());
  assert.equal(card.querySelector('.grid-card-footer').firstChild.textContent, 'Stopped');
  assert.equal(card.querySelector('.grid-card-stop-btn').style.display, 'none');
});

test('#629 Stop visibility follows descriptor liveness on the same projection', t => {
  const { ctx, session, create } = setup(t, 'remote');
  const card = create();
  ctx.remoteSessionStates.get(session.sessionId).apply({ type: 'liveness', value: 'dead' });
  ctx.window.applyStateClasses(session.sessionId, ctx.remoteSessionStates.get(session.sessionId).snapshot());
  assert.equal(card.querySelector('.grid-card-stop-btn').style.display, 'none');
});

test('#629 an unknown head with its PTY here does not animate and shows the same idle dot on both surfaces', t => {
  const { ctx, create } = setup(t);
  const card = create();
  parity(ctx, card, 'Idle');
});

test('#629 written output paints the title blue and visible rendered output clears both surfaces', t => {
  const { ctx, session, create } = setup(t);
  const card = create();
  ctx.window.openSessions.get(session.sessionId).renderedWrittenWatermark = ctx.window.noteWrittenActivity(session.sessionId);
  assert.equal(card.classList.contains('unseen-written-activity'), true);
  parity(ctx, card, 'Idle');
  ctx.window.gridViewActive = true;
  card.dataset.outputVisible = 'false';
  ctx.window.markTerminalOutputSeen(ctx.window.openSessions.get(session.sessionId));
  assert.equal(card.classList.contains('unseen-written-activity'), true, 'clipped card remains unread');
  card.dataset.outputVisible = 'true';
  ctx.window.markTerminalOutputSeen(ctx.window.openSessions.get(session.sessionId));
  assert.equal(card.classList.contains('unseen-written-activity'), false);
  parity(ctx, card, 'Idle');
});

test('#629 completion while a card is absent cannot resurrect tasks when it is created', t => {
  const { ctx, create, turn, tasks } = setup(t);
  turn('closed');
  tasks([{ id: 'A' }]);
  ctx.emitSubagentSpawned({ parentSessionId: 'head-629', agentId: 'A' });
  tasks([{ id: 'A', terminal: true }]);
  ctx.emitSubagentSpawned({ parentSessionId: 'head-629', agentId: 'A', _heartbeat: true });
  const card = create();
  parity(ctx, card, 'Idle');
  assert.equal(card.querySelector('.grid-subagent-count'), null);
});

test('#629 overlapping sources and ten-minute silence keep one canonical agent and glyph', t => {
  const { ctx, create, turn, tasks } = setup(t);
  const card = create();
  turn('closed');
  tasks([{ id: 'A' }]);
  for (const source of ['local-ipc', 'attached-ipc', 'remote-watch', 'local-transcript']) ctx.window.taskRegistry.note('head-629', 'A', source);
  const now = ctx.window.Date.now();
  ctx.window.Date.now = () => now + 600001;
  ctx.window.runSubagentTtlTick();
  parity(ctx, card, 'Background work running');
  assert.equal(card.querySelector('.grid-subagent-count').textContent, '1 subagent running');
  turn('open');
  parity(ctx, card, 'Working');
  ctx.window.activePtyIds.add('unrelated');
  ctx.window.updateRunningIndicators();
  parity(ctx, card, 'Working');
});

test('#629 merged head selection includes sibling activity and survives a hidden sidebar', t => {
  const { ctx, session, create, turn } = setup(t, 'local-transcript', { sessionId: 'root-629', headSessionId: 'head-629',
    mergedMemberIds: ['head-629', 'older-629'], mergedMemberStatuses: { 'head-629': { status: 'busy' }, 'older-629': { status: 'busy' } } });
  ctx.window.indexLocalMergedMemberRows([makeSampleProject({ sessions: [session] })]);
  ctx.window.sessionMap.set('head-629', { sessionId: 'head-629', status: 'busy' });
  const card = create();
  turn('closed');
  ctx.emitHeadTurn('older-629', 'open');
  ctx.window.taskRegistry.note('older-629', 'A', 'cli-task');
  parity(ctx, card, 'Background work running');
  ctx.document.getElementById('si-root-629').remove();
  turn('open');
  assert.equal(card.querySelector('.grid-card-dot').title, 'Working');
  ctx.window.taskRegistry.end('older-629', 'A');
  assert.equal(card.querySelector('.grid-subagent-count'), null);
});

test('#629 grid loading adds no second IPC lifecycle owner', t => {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  let registrations = 0;
  ctx.window.api.onSubagentSpawned = () => registrations++;
  ctx.window.api.onSubagentCompleted = () => registrations++;
  ctx.evalPublic('shortcuts.js');
  ctx.evalPublic('grid-view.js');
  assert.equal(registrations, 0);
});
