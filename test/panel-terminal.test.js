// The panel shell: a terminal mounted inside the right-hand file panel,
// running in the owning session's own working directory.
// See .ai/contexts/panel-terminal.md for the design.
//
// Three assumptions in terminal-manager.js had to be lifted for this to work,
// and each has a test here that goes red if the lift is reverted:
//   1. createTerminalEntry appended to #terminals unconditionally;
//   2. showSession cleared .visible from EVERY .terminal-container;
//   3. isHiddenSingleViewSession suspended every non-active session's writes.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupTerminalDom } = require('./terminal-manager-harness');

function withDims(cols, rows) {
  return { proposeDimensions: () => ({ cols, rows }) };
}

// Panel harness: the file panel built, one owner session known to sessionMap.
function setupPanel(extra = {}) {
  const ctx = setupTerminalDom({ filePanel: true, ...withDims(100, 40), ...extra });
  ctx.window.sessionMap.set('owner', { sessionId: 'owner', projectPath: '/proj' });
  ctx.window.sessionMap.set('other', { sessionId: 'other', projectPath: '/proj' });
  ctx.document = ctx.window.document;
  return ctx;
}

function mouse(window, type, clientY) {
  return new window.MouseEvent(type, { clientY, bubbles: true, cancelable: true });
}

// --- 1. Mount point -------------------------------------------------

test('createTerminalEntry still appends to #terminals when no mount is given', () => {
  const { window, destroy } = setupTerminalDom(withDims(80, 24));
  try {
    const entry = window.createTerminalEntry({ sessionId: 's1' });
    assert.equal(entry.element.parentElement, window.terminalsEl);
    assert.equal(entry.element.classList.contains('panel-terminal'), false);
    assert.equal(entry.panel, false);
  } finally { destroy(); }
});

test('createTerminalEntry mounts into the given container and marks it as a panel terminal', () => {
  const { window, destroy } = setupTerminalDom(withDims(80, 24));
  try {
    const host = window.document.createElement('div');
    window.document.body.appendChild(host);
    const entry = window.createTerminalEntry({ sessionId: 's1' }, { mount: host, panel: true });
    assert.equal(entry.element.parentElement, host);
    assert.ok(entry.element.classList.contains('panel-terminal'));
    assert.equal(entry.panel, true);
    assert.equal(entry.panelMounted, false, 'mounting into the DOM is not the same as being shown');
  } finally { destroy(); }
});

// --- 2. showSession scoping -----------------------------------------

test('showSession does not blank a panel terminal when another session is shown', async () => {
  const ctx = setupPanel();
  try {
    const { window } = ctx;
    await window.togglePanelTerminal('owner');
    const panelEntry = window.openSessions.get('panel:owner');
    assert.ok(panelEntry.element.classList.contains('visible'));

    window.createTerminalEntry({ sessionId: 'other' });
    window.showSession('other');

    assert.ok(panelEntry.element.classList.contains('visible'),
      'an unrelated session switch must not hide the panel terminal');
    assert.equal(panelEntry.panelMounted, true);
  } finally { ctx.destroy(); }
});

// --- 3. Hidden-write exemption ---------------------------------------

test('a mounted panel terminal is written to while another session is active', () => {
  const ctx = setupPanel();
  try {
    const { window, spies } = ctx;
    return window.togglePanelTerminal('owner').then(() => {
      window.activeSessionId = 'other';
      spies.writes.length = 0;

      window.handleTerminalData('panel:owner', 'live-output');
      window.flushTerminalBuffer('panel:owner');

      assert.deepEqual(spies.writes, ['live-output'],
        'the panel terminal is visible by construction — its output is never suspended');
      assert.equal(ctx.inCtx("hiddenAccumulators.has('panel:owner')"), false);
    });
  } finally { ctx.destroy(); }
});

test('an unmounted panel terminal suspends like any hidden session and replays on return', async () => {
  const ctx = setupPanel();
  try {
    const { window, spies } = ctx;
    await window.togglePanelTerminal('owner');
    window.activeSessionId = 'other';

    window.switchPanel('other'); // the panel now follows another session
    spies.writes.length = 0;
    window.handleTerminalData('panel:owner', 'while-away');

    assert.deepEqual(spies.writes, [], 'nothing is written while the region does not show it');
    assert.equal(ctx.inCtx("hiddenAccumulators.has('panel:owner')"), true);

    window.switchPanel('owner');
    assert.deepEqual(spies.writes, ['while-away'], 'the accumulated output replays on return');
  } finally { ctx.destroy(); }
});

test('an ordinary hidden session is still suspended (the exemption does not leak)', async () => {
  const ctx = setupPanel();
  try {
    const { window, spies } = ctx;
    window.createTerminalEntry({ sessionId: 'owner' });
    window.createTerminalEntry({ sessionId: 'other' });
    await window.togglePanelTerminal('owner');
    window.activeSessionId = 'other';
    spies.writes.length = 0;

    window.handleTerminalData('owner', 'hidden-output');

    assert.deepEqual(spies.writes, []);
    assert.equal(ctx.inCtx("hiddenAccumulators.has('owner')"), true);
  } finally { ctx.destroy(); }
});

// --- 4. LRU ----------------------------------------------------------

test('the LRU cap never evicts a panel terminal with a live PTY', async () => {
  const ctx = setupPanel();
  try {
    const { window } = ctx;
    await window.togglePanelTerminal('owner');
    // pollActiveSessions fills activePtyIds from the main process, which lists
    // every non-exited session including this one.
    window.activePtyIds.add('panel:owner');
    // Worst case for the panel entry: marked closed, so only activePtyIds
    // stands between it and eviction.
    window.openSessions.get('panel:owner').closed = true;

    for (let i = 0; i < 20; i++) {
      const entry = window.createTerminalEntry({ sessionId: 'filler' + i });
      entry.closed = true;
      window.lruTouch('filler' + i);
    }

    assert.ok(window.openSessions.has('panel:owner'), 'a running panel shell survives the cap');
  } finally { ctx.destroy(); }
});

// --- 5. The region, the splitter, and the panel ----------------------

test('opening the panel shell opens the file panel and shows the region', async () => {
  const ctx = setupPanel();
  try {
    const { window, document } = ctx;
    await window.togglePanelTerminal('owner');

    assert.ok(document.getElementById('file-panel').classList.contains('open'),
      'the shell region keeps the panel open with no tab');
    assert.ok(document.getElementById('panel-terminal-region').classList.contains('open'));
    assert.ok(document.getElementById('panel-terminal-handle').classList.contains('open'));
    assert.equal(document.getElementById('panel-terminal-toggle-btn').classList.contains('active'), true);
    assert.equal(window.openSessions.get('panel:owner').element.parentElement.id, 'panel-terminal-region');
  } finally { ctx.destroy(); }
});

test('the shell is spawned for the owning session, with no path from the renderer', async () => {
  const ctx = setupPanel();
  try {
    const { window, spies } = ctx;
    await window.togglePanelTerminal('owner');

    assert.equal(spies.openTerminal.length, 1);
    const call = spies.openTerminal[0];
    assert.equal(call.id, 'panel:owner');
    assert.equal(call.projectPath, '/proj');
    assert.deepEqual({ ...call.sessionOptions }, { type: 'terminal', panelFor: 'owner' });
  } finally { ctx.destroy(); }
});

test('returning to a session reattaches its shell instead of spawning a second one', async () => {
  const ctx = setupPanel();
  try {
    const { window, spies } = ctx;
    await window.togglePanelTerminal('owner');
    window.switchPanel('other');
    window.switchPanel('owner');

    assert.equal(spies.openTerminal.length, 1, 'the panel session id is stable per session');
    assert.ok(window.openSessions.get('panel:owner').element.classList.contains('visible'));
  } finally { ctx.destroy(); }
});

test('closing the shell stops the PTY, tears the terminal down, and closes the panel', async () => {
  const ctx = setupPanel();
  try {
    const { window, document, spies } = ctx;
    await window.togglePanelTerminal('owner');
    window.togglePanelTerminal('owner');

    assert.deepEqual(spies.stopSession, ['panel:owner'], 'close-terminal only detaches — the PTY is stopped explicitly');
    assert.equal(window.openSessions.has('panel:owner'), false);
    assert.equal(document.getElementById('panel-terminal-region').classList.contains('open'), false);
    assert.equal(document.getElementById('file-panel').classList.contains('open'), false);
  } finally { ctx.destroy(); }
});

test('destroying a session destroys its panel shell with it', async () => {
  const ctx = setupPanel();
  try {
    const { window, spies } = ctx;
    window.createTerminalEntry({ sessionId: 'owner' });
    await window.togglePanelTerminal('owner');

    window.destroySession('owner');

    assert.equal(window.openSessions.has('panel:owner'), false);
    assert.deepEqual(spies.stopSession, ['panel:owner']);
  } finally { ctx.destroy(); }
});

test('a refused spawn shows the reason and mounts no terminal', async () => {
  const ctx = setupPanel({ openTerminal: () => ({ ok: false, error: 'a remote session cannot host a panel shell' }) });
  try {
    const { window, document } = ctx;
    await window.togglePanelTerminal('owner');

    assert.equal(window.openSessions.has('panel:owner'), false, 'no terminal is left behind');
    assert.equal(document.querySelectorAll('#panel-terminal-region .terminal-container').length, 0);
    const message = document.getElementById('panel-terminal-message');
    assert.equal(message.style.display, 'block');
    assert.match(message.textContent, /remote session cannot host a panel shell/);
  } finally { ctx.destroy(); }
});

test('dragging the handle resizes the region, persists the height, and refits the shell', async () => {
  const ctx = setupPanel();
  try {
    const { window, document, spies } = ctx;
    await window.togglePanelTerminal('owner');

    const region = document.getElementById('panel-terminal-region');
    const handle = document.getElementById('panel-terminal-handle');
    region.style.height = '200px';
    const resizesBefore = spies.resize.length;

    handle.dispatchEvent(mouse(window, 'mousedown', 400));
    document.dispatchEvent(mouse(window, 'mousemove', 340)); // dragged up 60px
    assert.equal(region.style.height, '260px', 'dragging the handle up grows the region below it');

    document.dispatchEvent(mouse(window, 'mouseup', 340));
    assert.equal(window.localStorage.getItem('panelTerminalHeight'), '260');
    assert.ok(spies.resize.length > resizesBefore, 'the drag refits the panel terminal explicitly');
    assert.equal(handle.classList.contains('dragging'), false);
  } finally { ctx.destroy(); }
});

test('the region never grows past the panel, leaving room for the content above it', () => {
  const ctx = setupPanel();
  try {
    // jsdom lays nothing out, so the height ceiling (a function of the panel's
    // own height) is exercised directly rather than through a drag.
    assert.equal(ctx.inCtx('clampPanelTerminalHeight(500, 300)'), 180);
    assert.equal(ctx.inCtx('clampPanelTerminalHeight(500, 0)'), 500, 'an unmeasured panel imposes no ceiling');
    assert.equal(ctx.inCtx('clampPanelTerminalHeight(500, 150)'), 80, 'the floor wins over the ceiling');
  } finally { ctx.destroy(); }
});

test('the region height never drops below the floor', async () => {
  const ctx = setupPanel();
  try {
    const { window, document } = ctx;
    await window.togglePanelTerminal('owner');

    const region = document.getElementById('panel-terminal-region');
    const handle = document.getElementById('panel-terminal-handle');
    region.style.height = '120px';

    handle.dispatchEvent(mouse(window, 'mousedown', 400));
    document.dispatchEvent(mouse(window, 'mousemove', 900));
    document.dispatchEvent(mouse(window, 'mouseup', 900));

    assert.equal(region.style.height, '80px');
  } finally { ctx.destroy(); }
});
