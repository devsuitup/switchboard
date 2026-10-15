// A remote row whose process is alive on the host must show the stop control
// even when nobody has attached to it — session.remoteDescriptorSeen /
// snapshot.liveness === 'alive' is a fact independent of attach state. See
// .ai/contexts/session-state.md ("The two lifecycle verbs: detach and stop").
//
// Four layers are covered:
//   1. The CSS "show rule" itself (public/style.css) — a real cascade test,
//      not a source-grep, so a selector typo would also be caught.
//   2. The class writer (public/session-activity-dom.js's applyStateClasses),
//      via the real remote-ssh adapter — same technique as
//      test/remote-session-adapter.test.js.
//   3. The sidebar's initial paint (public/sidebar.js's buildSessionItem),
//      via the real dom-setup.js harness, so a first render (before any
//      live event fires) is covered too.
//   4. The shipped grid and app projection functions, loaded into jsdom.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

const STYLE_PATH = path.join(__dirname, '..', 'public', 'style.css');

// --- 1. The CSS show rule, real cascade -------------------------------------

test('style.css: .session-stop-btn shows for .is-alive alone, not only .has-running-pty (mutation target: dropping .is-alive from the show rule)', () => {
  const css = fs.readFileSync(STYLE_PATH, 'utf8');
  const dom = new JSDOM(
    `<!doctype html><html><head><style>${css}</style></head><body>
       <div class="session-item"><button class="session-stop-btn"></button></div>
     </body></html>`,
    { pretendToBeVisual: true, url: 'http://localhost/' },
  );
  const { window } = dom;
  const item = window.document.querySelector('.session-item');
  const btn = window.document.querySelector('.session-stop-btn');

  assert.equal(window.getComputedStyle(btn).display, 'none', 'hidden by default');

  item.classList.add('has-running-pty');
  assert.equal(window.getComputedStyle(btn).display, 'flex', 'has-running-pty still shows it (unchanged behavior)');
  item.classList.remove('has-running-pty');

  item.classList.add('is-alive');
  assert.equal(window.getComputedStyle(btn).display, 'flex',
    'is-alive alone must also show it — an unattached-but-alive remote row');

  window.close();
});

// --- 2. The class writer, via the real remote-ssh adapter -------------------

const STATE_SRC = path.join(__dirname, '..', 'public', 'session-state.js');
const DOM_SRC = path.join(__dirname, '..', 'public', 'session-activity-dom.js');
const ACTIVITY_SRC = path.join(__dirname, '..', 'public', 'session-activity.js');
const REMOTE_SRC = path.join(__dirname, '..', 'public', 'remote-activity-ui.js');

function setupRemoteAdapter(sessionIds = ['s1']) {
  const items = sessionIds
    .map(id => `<div class="session-item" data-session-id="${id}"><span class="session-status-dot"></span></div>`)
    .join('');
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${items}</body></html>`,
    { url: 'http://localhost/', runScripts: 'outside-only' });
  const { window } = dom;
  Object.defineProperty(window, 'activeSessionId', { value: null, writable: true, configurable: true });
  Object.defineProperty(window, 'api', { value: { onRemoteActivity: () => {} }, writable: true, configurable: true });
  Object.defineProperty(window, 'setTimeout', { value: () => 1, writable: true, configurable: true });
  Object.defineProperty(window, 'clearTimeout', { value: () => {}, writable: true, configurable: true });

  const ctx = dom.getInternalVMContext();
  vm.runInContext(fs.readFileSync(STATE_SRC, 'utf8'), ctx, { filename: STATE_SRC });
  vm.runInContext(fs.readFileSync(DOM_SRC, 'utf8'), ctx, { filename: DOM_SRC });
  vm.runInContext(fs.readFileSync(ACTIVITY_SRC, 'utf8'), ctx, { filename: ACTIVITY_SRC });
  vm.runInContext(fs.readFileSync(REMOTE_SRC, 'utf8'), ctx, { filename: REMOTE_SRC });

  const call = (fnName, arg) => vm.runInContext(`${fnName}(${JSON.stringify(arg)})`, ctx);
  return {
    window,
    item: (id) => window.document.querySelector(`.session-item[data-session-id="${id}"]`),
    applyRemoteDescriptor: (session) => call('applyRemoteDescriptor', session),
    applyRemoteStopped: (id) => call('applyRemoteStopped', id),
    destroy: () => window.close(),
  };
}

test('applyRemoteDescriptor marks an alive, unattached row .is-alive', () => {
  const t = setupRemoteAdapter(['s1']);
  t.applyRemoteDescriptor({ sessionId: 's1', remoteAlias: 'planificator', remoteDescriptorSeen: true, status: 'idle' });
  assert.ok(t.item('s1').classList.contains('is-alive'), 'a matched descriptor must mark the row is-alive');
  t.destroy();
});

test('applyRemoteDescriptor leaves a row not is-alive when the descriptor was not seen', () => {
  const t = setupRemoteAdapter(['s1']);
  t.applyRemoteDescriptor({ sessionId: 's1', remoteAlias: 'planificator', remoteDescriptorSeen: false, status: null });
  assert.ok(!t.item('s1').classList.contains('is-alive'), 'liveness stays unknown, never treated as alive');
  t.destroy();
});

test('applyRemoteStopped clears is-alive once the host confirms the process is gone', () => {
  const t = setupRemoteAdapter(['s1']);
  t.applyRemoteDescriptor({ sessionId: 's1', remoteAlias: 'planificator', remoteDescriptorSeen: true, status: 'idle' });
  assert.ok(t.item('s1').classList.contains('is-alive'), 'precondition: alive before the stop');
  t.applyRemoteStopped('s1');
  assert.ok(!t.item('s1').classList.contains('is-alive'), 'a successful stop must clear is-alive immediately');
  t.destroy();
});

// --- 3. The sidebar's initial paint (first render, no prior live event) ----

function remoteProject(session) {
  return makeSampleProject({
    projectPath: '/srv/supervision',
    folder: 'planificator::-srv-supervision',
    remoteAlias: 'planificator',
    sessions: [session],
  });
}

test('buildSessionItem: an unattached remote session with a live descriptor paints is-alive on first render', () => {
  const ctx = setupSidebarDom();
  try {
    const session = {
      sessionId: 'remote-alive', summary: 'alive, unattached', modified: '2026-09-06T10:00:00.000Z',
      starred: false, archived: 0, messageCount: 1,
      remoteAlias: 'planificator', remoteDescriptorSeen: true, status: 'idle',
    };
    ctx.sidebar.renderProjects([remoteProject(session)], true);

    const item = ctx.document.querySelector('#si-remote-alive');
    assert.ok(item, 'the row must exist');
    assert.ok(item.classList.contains('is-alive'), 'a live, unattached remote row must show is-alive on its very first paint');
  } finally { ctx.destroy(); }
});

test('buildSessionItem: a remote session with no matching descriptor is not painted is-alive', () => {
  const ctx = setupSidebarDom();
  try {
    const session = {
      sessionId: 'remote-dead', summary: 'no live process', modified: '2026-09-06T10:00:00.000Z',
      starred: false, archived: 0, messageCount: 1,
      remoteAlias: 'planificator', remoteDescriptorSeen: false, status: null,
    };
    ctx.sidebar.renderProjects([remoteProject(session)], true);

    const item = ctx.document.querySelector('#si-remote-dead');
    assert.ok(item);
    assert.ok(!item.classList.contains('is-alive'), 'no descriptor match must never be painted is-alive');
  } finally { ctx.destroy(); }
});

test('buildSessionItem: a plain local session is never painted is-alive by this path', () => {
  const ctx = setupSidebarDom();
  try {
    const project = makeSampleProject({
      sessions: [{
        sessionId: 'local-1', summary: 'local work', modified: '2026-09-06T10:00:00.000Z',
        starred: false, archived: 0, messageCount: 2,
      }],
    });
    ctx.sidebar.renderProjects([project], true);

    const item = ctx.document.querySelector('#si-local-1');
    assert.ok(item);
    assert.ok(!item.classList.contains('is-alive'));
  } finally { ctx.destroy(); }
});

function gridContext(t) {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const session = { sessionId: 'remote-alive', remoteAlias: 'planificator', remoteDescriptorSeen: true,
    status: 'idle', modified: new Date().toISOString() };
  ctx.window.sessionMap.set(session.sessionId, session);
  ctx.sidebar.renderProjects([remoteProject(session)], true);
  Object.assign(ctx.window, { terminalsEl: ctx.document.getElementById('terminals'), gridViewActive: false,
    replayHiddenBuffer() {}, renderDefaultStatus() {} });
  ctx.evalPublic('shortcuts.js');
  ctx.evalPublic('grid-view.js');
  loadAppFunctions(ctx.context, { functions: ['updateRunningIndicators'], declarations: ['_lastPtySignature'] });
  ctx.window.openSessions.set(session.sessionId, { session, element: ctx.document.createElement('div') });
  ctx.window.wrapInGridCard(session.sessionId);
  return { ctx, button: ctx.document.querySelector('.grid-card-stop-btn') };
}

test('wrapInGridCard shows Stop for a live unattached remote process', t => {
  const { ctx, button } = gridContext(t);
  assert.equal(ctx.window.activePtyIds.size, 0);
  assert.equal(button.style.display, '');
});

test('updateRunningIndicators preserves remote Stop reachability through unrelated PTY changes and a confirmed stop', t => {
  const { ctx, button } = gridContext(t);
  ctx.window.activePtyIds.add('unrelated');
  ctx.window.updateRunningIndicators();
  assert.equal(button.style.display, '');
  ctx.window.activePtyIds.clear();
  ctx.window.updateRunningIndicators();
  assert.equal(button.style.display, '');
  ctx.window.applyRemoteStopped('remote-alive');
  ctx.window.updateRunningIndicators();
  assert.equal(button.style.display, 'none');
});
