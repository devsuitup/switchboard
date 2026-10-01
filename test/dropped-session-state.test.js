// A session main no longer holds must stop counting as running — in the
// sidebar row, the status bar and the activity state. see .ai/contexts/session-state.md ("A session main drops")
//
// app.js cannot be evaluated whole in jsdom, so the shipped onProcessExited
// handler and updateRunningIndicators are cut out of its source and run
// against stubs (same technique as process-exit-status.test.js).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { setupSidebarDom } = require('./dom-setup');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

function sliceBlock(marker, tail = '') {
  const start = APP_SRC.indexOf(marker);
  assert.notEqual(start, -1, `app.js must contain ${marker}`);
  const lineEndingBrace = /\{\r?\n/g;
  lineEndingBrace.lastIndex = start;
  const open = lineEndingBrace.exec(APP_SRC);
  let depth = 0;
  for (let i = open.index; i < APP_SRC.length; i++) {
    if (APP_SRC[i] === '{') depth++;
    else if (APP_SRC[i] === '}' && --depth === 0) return APP_SRC.slice(start, i + 1) + tail;
  }
  throw new Error(`unbalanced block after ${marker}`);
}

const PRELUDE = `
  let activePtyIds = new Set();
  let _lastPtySignature = '';
  const calls = { dropped: [], status: 0, indicators: 0 };
  const openSessions = new Map();
  const sessionMap = new Map();
  const pendingSessions = new Map();
  const cachedProjects = [];
  const cachedAllProjects = [];
  const gridCards = new Map();
  const sessionBusyState = new Map();
  let gridViewActive = false;
  let activeSessionId = null;
  const gridViewerCount = document.createElement('span');
  const terminalHeader = document.createElement('div');
  const placeholder = document.createElement('div');
  function isPanelTerminalSession() { return false; }
  function notePanelTerminalExit() {}
  function noteSessionExit() {}
  function lastSessionExit() { return { exitCode: 0, signal: null, stopped: true }; }
  function exitBannerColour() { return ''; }
  function exitBannerPhrase() { return ''; }
  function destroySession() {}
  function setActiveSession() {}
  function refreshSidebar() {}
  function schedulePersistWorkingSet() {}
  function pollActiveSessions() {}
  function setHasBusyAgents() {}
  function setRemoteAttached() {}
  function localTranscriptPtyTakeover() {}
  function paintSessionIcon() {}
  function isSessionAlive() { return false; }
  function sessionItemEl(id) { return document.querySelector('.session-item[data-session-id="' + id + '"]'); }
  function dropLocalPtySession(id, via) { calls.dropped.push([id, via]); }
  function renderDefaultStatus() { calls.status++; }
`;

function setup() {
  const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' });
  const { window } = dom;
  let exitHandler = null;
  window.api = { onProcessExited: (cb) => { exitHandler = cb; } };
  const ctx = dom.getInternalVMContext();
  const run = (src, filename) => vm.runInContext(src, ctx, { filename });
  run(PRELUDE, 'prelude.js');
  run(sliceBlock('function updateRunningIndicators() {'), 'app.js#updateRunningIndicators');
  run(`function updateTerminalHeader() {}`, 'stub.js');
  run(sliceBlock('window.api.onProcessExited((', ');'), 'app.js#onProcessExited');
  return {
    exit: (id) => exitHandler(id, 0, null, true),
    read: (expr) => run(expr, 'read.js'),
    window,
  };
}

test('a busy signal that lands after the pty-set scan is cleared when the session is dropped', () => {
  const ctx = setupSidebarDom();
  try {
    const item = ctx.document.createElement('div');
    item.className = 'session-item';
    item.dataset.sessionId = 'dropped-1';
    item.innerHTML = '<span class="session-status-dot"></span>';
    ctx.document.getElementById('sidebar-content').append(item);

    ctx.setActivity('dropped-1', true, 'onCliBusyState');
    assert.ok(item.classList.contains('cli-busy'), 'precondition: the late busy signal marked the row');

    ctx.window.dropLocalPtySession('dropped-1', 'process-exited');

    assert.ok(!item.classList.contains('cli-busy'), 'the dropped row must stop reading as busy');
    assert.equal(ctx.sessionBusyState.has('dropped-1'), false, 'no activity state survives the drop');
  } finally {
    ctx.destroy();
  }
});

test('dropping a session also clears its attention mark', () => {
  const ctx = setupSidebarDom();
  try {
    const item = ctx.document.createElement('div');
    item.className = 'session-item';
    item.dataset.sessionId = 'dropped-2';
    item.innerHTML = '<span class="session-status-dot"></span>';
    ctx.document.getElementById('sidebar-content').append(item);

    ctx.window.setAttention('dropped-2', true, 'onTerminalNotification');
    assert.ok(item.classList.contains('needs-attention'), 'precondition');

    ctx.window.dropLocalPtySession('dropped-2', 'process-exited');

    assert.ok(!item.classList.contains('needs-attention'));
    assert.equal(ctx.attentionSessions.has('dropped-2'), false);
  } finally {
    ctx.destroy();
  }
});

test('process-exited removes the session from the running set and drops its activity state', () => {
  const h = setup();
  h.read("activePtyIds = new Set(['a', 'b']); sessionMap.set('b', { sessionId: 'b', type: 'claude' })");
  h.exit('b');
  assert.equal(h.read('JSON.stringify(Array.from(activePtyIds))'), '["a"]', 'b no longer counts as running');
  assert.equal(h.read('JSON.stringify(calls.dropped)'), '[["b","process-exited"]]');
});

test('process-exited leaves a remote row to its own adapter, even with no sessionMap entry', () => {
  const h = setup();
  h.read("const row = document.createElement('div'); row.className = 'session-item'; row.dataset.sessionId = 'r'; row.dataset.remoteAlias = 'vps'; document.body.append(row)");
  h.exit('r');
  assert.equal(h.read('calls.dropped.length'), 0, 'a remote row is not purged by the local drop path');
});

test('an exit that lands while the same id is being reopened does not drop the new pty', () => {
  const h = setup();
  h.read("activePtyIds = new Set(['b']); sessionMap.set('b', { sessionId: 'b', type: 'claude' }); openSessions.set('b', { closed: false, opening: true, terminal: { write() {} } })");
  h.exit('b');
  assert.equal(h.read('JSON.stringify(Array.from(activePtyIds))'), '["b"]', 'the new pty stays in the running set');
  assert.equal(h.read('calls.dropped.length'), 0, 'its live state is not purged');
});

test('a change in the running set refreshes the status bar count, an unchanged one does not', () => {
  const h = setup();
  h.read("activePtyIds = new Set(['a', 'b']); updateRunningIndicators()");
  assert.equal(h.read('calls.status'), 1, 'set changed: status bar redrawn');
  h.read('updateRunningIndicators()');
  assert.equal(h.read('calls.status'), 1, 'set unchanged: no redraw');
  h.read("activePtyIds = new Set(['a']); updateRunningIndicators()");
  assert.equal(h.read('calls.status'), 2, 'a session dropped by main: status bar redrawn');
});

test('process-exited refreshes the status bar through the running-set change', () => {
  const h = setup();
  h.read("activePtyIds = new Set(['a', 'b']); updateRunningIndicators(); sessionMap.set('b', { sessionId: 'b', type: 'claude' })");
  const before = h.read('calls.status');
  h.exit('b');
  assert.equal(h.read('calls.status'), before + 1);
});
