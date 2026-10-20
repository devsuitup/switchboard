'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');
const { parseJobState, mergeRoster } = require('../bg-agents-roster');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
const GREEN = 'rgb(62, 207, 90)';

function row(t, { pty = true, extra = {}, focused = true } = {}) {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const style = ctx.document.createElement('style');
  style.textContent = css;
  ctx.document.head.appendChild(style);
  const session = { sessionId: 'root', status: 'idle', statusUpdatedAt: Date.now(), modified: new Date().toISOString(), ...extra };
  ctx.window.sessionMap.set('root', session);
  ctx.window.activeSessionId = focused ? 'root' : 'other';
  if (pty) ctx.window.activePtyIds.add('root');
  const render = () => ctx.sidebar.renderProjects([makeSampleProject({ sessions: [session] })], true);
  render();
  let revision = 0;
  const turn = (state, id = 'root') => ctx.emitHeadTurn(id, state, { revision: ++revision });
  const icon = () => ctx.document.getElementById('si-root').querySelector('.session-icon');
  const slot = () => [...icon().classList].filter(c => c.startsWith('session-icon--'));
  const background = () => ctx.window.getComputedStyle(icon()).backgroundColor;
  return { ctx, session, render, turn, icon, slot, background };
}

for (const first of [null, 'closed', 'unknown']) {
  test(`#714 a PTY-here row at rest shows the green running dot (first head turn: ${first || 'none'})`, t => {
    const { turn, icon, slot, background } = row(t);
    if (first) turn(first);
    assert.deepEqual(slot(), ['session-icon--idle']);
    assert.ok(icon().classList.contains('running'));
    assert.equal(background(), GREEN);
    assert.equal(icon().title, 'Idle · Open here\nCLI status: idle');
  });
}

test('#714 an OSC turn end observed here shows the waiting ring, focused or not', t => {
  for (const focused of [true, false]) {
    const { ctx, icon, slot, background } = row(t, { focused });
    ctx.setActivity('root', true, 'onCliBusyState');
    ctx.setActivity('root', false, 'onCliBusyState');
    assert.deepEqual(slot(), ['session-icon--waiting'], `focused: ${focused}`);
    assert.equal(background(), 'rgba(0, 0, 0, 0)');
    assert.equal(icon().dataset.glyph, '○');
    if (!focused) assert.ok(!ctx.document.getElementById('si-root').classList.contains('response-ready'));
  }
});

test('#714 a head turn seen open then closed here shows the waiting ring, kept across a same-state revision and a rebuild', t => {
  const { ctx, turn, slot, render } = row(t);
  turn('open');
  assert.deepEqual(slot(), ['session-icon--busy']);
  turn('closed');
  assert.deepEqual(slot(), ['session-icon--waiting']);
  turn('closed');
  assert.deepEqual(slot(), ['session-icon--waiting'], 'a later closed revision keeps the observed end');
  render();
  assert.deepEqual(slot(), ['session-icon--waiting'], 'a sidebar rebuild keeps the observed end');
  turn('open');
  assert.deepEqual(slot(), ['session-icon--busy'], 'a new turn replaces the ring with the spinner');
  void ctx;
});

test('#714 an OSC busy edge clears an end observed only through OSC', t => {
  const { ctx, turn, slot } = row(t);
  ctx.setActivity('root', true, 'onCliBusyState');
  ctx.setActivity('root', false, 'onCliBusyState');
  assert.deepEqual(slot(), ['session-icon--waiting']);
  ctx.setActivity('root', true, 'onCliBusyState');
  assert.deepEqual(slot(), ['session-icon--idle'], 'OSC busy is a new turn: the OSC-observed end is gone');
  turn('unknown');
  assert.deepEqual(slot(), ['session-icon--idle']);
});

test('#714 a row live elsewhere keeps the waiting ring without any observed turn end', t => {
  const { turn, slot, icon } = row(t, { pty: false });
  assert.deepEqual(slot(), ['session-icon--waiting']);
  turn('closed');
  assert.deepEqual(slot(), ['session-icon--waiting']);
  assert.ok(!icon().classList.contains('running'));
});

test('#714 a plain terminal row with its PTY here keeps the green halo', t => {
  const { icon, slot, ctx } = row(t, { extra: { type: 'terminal', status: undefined } });
  assert.ok(ctx.document.getElementById('si-root').classList.contains('is-terminal'));
  assert.deepEqual(slot(), ['session-icon--idle']);
  const computed = ctx.window.getComputedStyle(icon());
  assert.equal(computed.backgroundColor, GREEN);
  assert.match(computed.boxShadow, /62,\s*207,\s*90/);
});

test('#714 a merged row reads the observed turn end of its head, not of an older member', t => {
  const { ctx, slot } = row(t, { extra: { headSessionId: 'head', mergedMemberIds: ['old', 'head'],
    mergedMemberStatuses: { head: { status: 'idle' }, old: { status: 'idle' } } }, pty: false });
  ctx.window.activePtyIds.add('head');
  ctx.window.activePtyIds.add('old');
  ctx.window.applyStateClasses('head', ctx.window.storedActivitySnapshot('head'));
  assert.deepEqual(slot(), ['session-icon--idle']);
  ctx.setActivity('old', true, 'onCliBusyState');
  ctx.setActivity('old', false, 'onCliBusyState');
  assert.deepEqual(slot(), ['session-icon--idle'], 'an older member cannot put the ring on the head');
  ctx.setActivity('head', true, 'onCliBusyState');
  ctx.setActivity('head', false, 'onCliBusyState');
  assert.deepEqual(slot(), ['session-icon--waiting']);
});

test('#714 a merged row whose only PTY is on an older part follows that part\'s observed turn end', t => {
  const { ctx, turn, slot } = row(t, { extra: { headSessionId: 'head', mergedMemberIds: ['old', 'head'],
    mergedMemberStatuses: { head: { status: 'idle' }, old: { status: 'idle' } } }, pty: false });
  ctx.window.activePtyIds.add('old');
  ctx.window.applyStateClasses('old', ctx.window.storedActivitySnapshot('old'));
  assert.deepEqual(slot(), ['session-icon--idle'], 'a live head descriptor alone does not put the ring on a row whose PTY is here');
  ctx.setActivity('old', true, 'onCliBusyState');
  ctx.setActivity('old', false, 'onCliBusyState');
  assert.deepEqual(slot(), ['session-icon--waiting'], 'the PTY part\'s OSC turn end');
  ctx.setActivity('old', true, 'onCliBusyState');
  assert.deepEqual(slot(), ['session-icon--idle']);
  turn('open', 'old');
  turn('closed', 'old');
  assert.deepEqual(slot(), ['session-icon--waiting'], 'the PTY part\'s transcript turn end');
  turn('open', 'head');
  assert.deepEqual(slot(), ['session-icon--busy'], 'the head still owns the spinner');
});

test('#714 a merged row whose PTY part ended a turn shows no ring while a head without a process has an open turn', t => {
  const { ctx, turn, slot } = row(t, { extra: { headSessionId: 'head', mergedMemberIds: ['old', 'head'],
    mergedMemberStatuses: { head: {}, old: { status: 'idle' } } }, pty: false });
  ctx.window.activePtyIds.add('old');
  ctx.setActivity('old', true, 'onCliBusyState');
  ctx.setActivity('old', false, 'onCliBusyState');
  assert.deepEqual(slot(), ['session-icon--waiting']);
  turn('open', 'head');
  assert.deepEqual(slot(), ['session-icon--idle'], 'an open head turn is not waiting for the user');
});

test('#714 an attach tab on a live background job is green at rest and shows the ring after an observed turn end', t => {
  const SID = 'aaaaaaaa-1234-4321-abcd-123456789abc';
  const at = Date.now() - 10_000;
  const job = parseJobState(JSON.stringify({ state: 'working', updatedAt: new Date(at).toISOString(),
    inFlight: { tasks: 0, kinds: [] }, sessionId: SID, fan: [] }));
  const entries = mergeRoster({ cli: [{ id: 'aaaaaaaa', kind: 'background', sessionId: SID, state: 'working', status: 'busy' }],
    jobs: new Map([['aaaaaaaa', job]]), descriptors: [{ kind: 'bg', jobId: 'aaaaaaaa', sessionId: SID,
      status: 'busy', statusUpdatedAt: 1, cwd: '/repo', pid: 10 }] });
  const h = setupSidebarDom();
  t.after(() => h.destroy());
  h.evalPublic('agents-view.js');
  const session = { sessionId: SID, bgJobId: 'aaaaaaaa', status: 'busy', statusUpdatedAt: 1, modified: new Date().toISOString() };
  h.window.sessionMap.set(SID, session);
  h.window.activePtyIds.add(SID);
  h.window.openSessions.set(SID, { session, attach: true });
  h.window.activeSessionId = SID;
  h.window.applyAgentsSnapshot({ roster: entries, daemonReachable: true });
  h.document.getElementById('sidebar-content').replaceChildren(h.sidebar.buildSessionItem(session));
  const slot = () => [...h.document.querySelector('.session-icon').classList].filter(c => c.startsWith('session-icon--'));
  h.emitHeadTurn(SID, 'closed', { revision: 1 });
  assert.deepEqual(slot(), ['session-icon--idle']);
  assert.equal(h.window.agentRowIcon(entries[0]).slotClass, 'session-icon--idle');
  h.emitHeadTurn(SID, 'open', { revision: 2 });
  h.emitHeadTurn(SID, 'closed', { revision: 3 });
  assert.deepEqual(slot(), ['session-icon--waiting']);
  assert.equal(h.window.agentRowIcon(entries[0]).slotClass, 'session-icon--waiting');
});

test('#714 a grid card whose PTY is here is green at rest and shows the ring after an observed turn end', t => {
  const { ctx, session, turn } = row(t);
  Object.assign(ctx.window, { terminalsEl: ctx.document.getElementById('terminals'), gridViewActive: false,
    replayHiddenBuffer() {}, renderDefaultStatus() {} });
  ctx.evalPublic('shortcuts.js');
  ctx.evalPublic('grid-view.js');
  loadAppFunctions(ctx.context, { functions: ['updateRunningIndicators'], declarations: ['_lastPtySignature'] });
  ctx.window.openSessions.set('root', { session, element: ctx.document.createElement('div'),
    terminal: { focus() {}, buffer: { active: { viewportY: 0, baseY: 0 } } } });
  ctx.window.wrapInGridCard('root');
  const dot = () => ctx.document.querySelector('.grid-card .grid-card-dot');
  assert.ok(dot().classList.contains('session-icon--idle'));
  assert.equal(ctx.window.getComputedStyle(dot()).backgroundColor, GREEN);
  turn('open');
  turn('closed');
  assert.ok(dot().classList.contains('session-icon--waiting'));
  assert.equal(ctx.window.getComputedStyle(dot()).backgroundColor, 'rgba(0, 0, 0, 0)');
});

test('#714 a turn end observed before this PTY started does not count', t => {
  const { ctx, turn, slot } = row(t, { pty: false });
  loadAppFunctions(ctx.context, { functions: ['beginPtyOpen'], declarations: ['pendingOpens'] });
  turn('open');
  turn('closed');
  assert.deepEqual(slot(), ['session-icon--waiting'], 'live elsewhere: the ring');
  ctx.window.beginPtyOpen('root');
  ctx.window.activePtyIds.add('root');
  ctx.window.projectLocalPtyState('root');
  assert.deepEqual(slot(), ['session-icon--idle'], 'opened here: green');
  turn('closed');
  assert.deepEqual(slot(), ['session-icon--idle'], 'a later closed snapshot is not a new observed end');
  ctx.setActivity('root', true, 'onCliBusyState');
  ctx.setActivity('root', false, 'onCliBusyState');
  assert.deepEqual(slot(), ['session-icon--waiting']);
  ctx.window.dropLocalPtySession('root', 'process-exited');
  ctx.window.activePtyIds.delete('root');
  ctx.window.beginPtyOpen('root');
  ctx.window.activePtyIds.add('root');
  ctx.window.projectLocalPtyState('root');
  assert.deepEqual(slot(), ['session-icon--idle'], 'reopened after exit: green');
});

function remoteRow(t) {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  ctx.window.renderDefaultStatus = () => {};
  loadAppFunctions(ctx.context, { functions: ['beginPtyOpen', 'updateRunningIndicators'], declarations: ['pendingOpens', '_lastPtySignature'] });
  const session = { sessionId: 'remote-root', remoteAlias: 'host', remoteDescriptorSeen: true, status: 'idle',
    statusUpdatedAt: Date.now(), modified: new Date().toISOString() };
  ctx.window.sessionMap.set(session.sessionId, session);
  ctx.window.activeSessionId = session.sessionId;
  const render = sessions => ctx.sidebar.renderProjects([makeSampleProject({ remoteAlias: 'host', sessions })], true);
  render([session]);
  const open = () => {
    ctx.window.openSessions.set(session.sessionId, { session, closed: false, element: ctx.document.createElement('div'),
      terminal: { focus() {}, buffer: { active: { viewportY: 0, baseY: 0 } } } });
    ctx.window.beginPtyOpen(session.sessionId);
  };
  const attach = () => {
    ctx.window.activePtyIds.add(session.sessionId);
    ctx.window.updateRunningIndicators();
  };
  const slot = () => [...ctx.document.getElementById('si-remote-root').querySelector('.session-icon').classList]
    .filter(c => c.startsWith('session-icon--'));
  return { ctx, session, render, open, attach, slot };
}

test('#714 attaching a remote session after its activity decayed is green, with no manual repaint', t => {
  const { ctx, open, attach, slot } = remoteRow(t);
  ctx.window.markRemoteBusy('remote-root', 'remote-watch', Date.now());
  ctx.window.decayRemoteBusy('remote-root');
  assert.deepEqual(slot(), ['session-icon--waiting'], 'live elsewhere: the ring');
  open();
  ctx.window.decayRemoteBusy('remote-root');
  attach();
  assert.deepEqual(slot(), ['session-icon--idle'], 'a decay before or after the open is not an observed end');
});

function idlePoll(ctx) {
  ctx.window.activePtyIds.add('remote-root');
  ctx.window.reconcileBusyState([{ sessionId: 'remote-root', busy: false }], ctx.window.currentActivitySeq());
  ctx.window.updateRunningIndicators();
}

test('#714 remote activity before the open, with its decay still pending, is not an observed end after attach', t => {
  const { ctx, open, slot } = remoteRow(t);
  ctx.window.markRemoteBusy('remote-root', 'remote-watch', Date.now());
  open();
  ctx.window.decayRemoteBusy('remote-root');
  idlePoll(ctx);
  assert.deepEqual(slot(), ['session-icon--idle'], 'the first poll reports the attach idle; nothing ended in this PTY');
});

test('#714 remote activity while the tab is opening is not an observed end after attach', t => {
  const { ctx, open, slot } = remoteRow(t);
  open();
  ctx.window.markRemoteBusy('remote-root', 'remote-watch', Date.now());
  ctx.window.decayRemoteBusy('remote-root');
  idlePoll(ctx);
  assert.deepEqual(slot(), ['session-icon--idle']);
});

test('#714 an attached remote session keeps its ring across a prune, a re-render and another PTY change', t => {
  const { ctx, session, render, open, attach, slot } = remoteRow(t);
  open();
  attach();
  assert.deepEqual(slot(), ['session-icon--idle']);
  ctx.setActivity('remote-root', true, 'onCliBusyState');
  ctx.setActivity('remote-root', false, 'onCliBusyState');
  assert.deepEqual(slot(), ['session-icon--waiting']);
  render([]);
  ctx.window.pruneRemoteActivityTimers();
  render([session]);
  assert.deepEqual(slot(), ['session-icon--waiting']);
  ctx.window.activePtyIds.add('another-pty');
  ctx.window.updateRunningIndicators();
  assert.deepEqual(slot(), ['session-icon--waiting'], 'no PTY started for this row, so its observed end still counts');
});

test('#714 a head turn going unknown clears the observed end until a new end is observed', t => {
  const { ctx, turn, slot } = row(t);
  turn('open');
  turn('closed');
  assert.deepEqual(slot(), ['session-icon--waiting']);
  turn('unknown');
  assert.deepEqual(slot(), ['session-icon--idle'], 'unknown clears the transcript-observed end');
  turn('closed');
  assert.deepEqual(slot(), ['session-icon--idle'], 'closed without an open in between brings no ring back');
  ctx.setActivity('root', true, 'onCliBusyState');
  ctx.setActivity('root', false, 'onCliBusyState');
  assert.deepEqual(slot(), ['session-icon--waiting'], 'a new OSC end counts');
  turn('unknown');
  assert.deepEqual(slot(), ['session-icon--idle'], 'unknown also clears the OSC-observed end');
});

function rowWithGrid(t, options) {
  const h = row(t, options);
  const { ctx, session } = h;
  Object.assign(ctx.window, { terminalsEl: ctx.document.getElementById('terminals'), gridViewActive: false,
    replayHiddenBuffer() {}, renderDefaultStatus() {} });
  ctx.evalPublic('shortcuts.js');
  ctx.evalPublic('grid-view.js');
  loadAppFunctions(ctx.context, { functions: ['beginPtyOpen', 'updateRunningIndicators'],
    declarations: ['pendingOpens', '_lastPtySignature'] });
  ctx.window.openSessions.set('root', { session, element: ctx.document.createElement('div'),
    terminal: { focus() {}, buffer: { active: { viewportY: 0, baseY: 0 } } } });
  ctx.window.wrapInGridCard('root');
  return { ...h, icons: () => [h.icon(), ctx.document.querySelector('.grid-card .grid-card-dot')] };
}

for (const surface of ['sidebar', 'grid']) {
  test(`#714 an open head from before PTY start cannot arm a later closed snapshot on ${surface}`, t => {
    const { ctx, turn, icons } = rowWithGrid(t, { pty: false });
    const icon = () => icons()[surface === 'sidebar' ? 0 : 1];
    turn('open');
    ctx.window.beginPtyOpen('root');
    ctx.window.activePtyIds.add('root');
    ctx.window.updateRunningIndicators();
    turn('closed');
    assert.ok(icon().classList.contains('session-icon--idle'));
    assert.equal(ctx.window.getComputedStyle(icon()).backgroundColor, GREEN);
    turn('open');
    turn('closed');
    assert.ok(icon().classList.contains('session-icon--waiting'));
    assert.equal(ctx.window.getComputedStyle(icon()).backgroundColor, 'rgba(0, 0, 0, 0)');
  });

  test(`#714 an unknown head after an OSC turn end shows Turn state unavailable on ${surface}`, t => {
    const { ctx, turn, icons } = rowWithGrid(t, { extra: { status: undefined } });
    const icon = () => icons()[surface === 'sidebar' ? 0 : 1];
    turn('unknown');
    ctx.setActivity('root', true, 'osc');
    ctx.setActivity('root', false, 'osc');
    assert.ok(icon().classList.contains('session-icon--waiting'));
    assert.equal(icon().title, surface === 'Agents' ? 'Turn state unavailable' : 'Turn state unavailable · Open here');
  });
}
