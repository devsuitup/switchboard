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

// Let an awaited continuation (and anything it chains) run.
async function microtasks(n = 4) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

// Stand-ins for the lazy CodeMirror bundle the Changes tab builds its editor
// from: a DOM node, and a document the test can rewrite to dirty the buffer.
function stubChangesEditors(window) {
  const make = (parent, text) => {
    const dom = window.document.createElement('div');
    parent.appendChild(dom);
    const view = {
      dom,
      text,
      destroy() { if (dom.parentNode) dom.parentNode.removeChild(dom); },
    };
    view.state = { doc: { toString: () => view.text } };
    view.b = { state: view.state };
    return view;
  };
  window.loadCodeMirrorBundle = () => Promise.resolve();
  window.createMergeViewer = (parent, original, modified) => make(parent, modified);
  window.createUnifiedMergeViewer = (parent, original, modified) => make(parent, modified);
  window.createEditableViewer = (parent, content) => make(parent, content);
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

// The refusal is the whole point of resolving the cwd in the main process, so
// these assert what the user can see, not a style property on a node that may
// be sitting inside a closed, zero-width panel.
test('a refused spawn is visible: the panel opens on the reason, with no terminal', async () => {
  const ctx = setupPanel({ openTerminal: () => ({ ok: false, error: 'a remote session cannot host a panel shell' }) });
  try {
    const { window, document } = ctx;
    await window.togglePanelTerminal('owner');

    const panel = document.getElementById('file-panel');
    assert.ok(panel.classList.contains('open'), 'the panel must be open for the reason to be readable');
    assert.notEqual(panel.style.width, '0px');
    assert.ok(document.getElementById('panel-terminal-region').classList.contains('open'));

    const message = document.getElementById('panel-terminal-message');
    assert.equal(message.style.display, 'block');
    assert.match(message.textContent, /remote session cannot host a panel shell/);

    assert.equal(window.openSessions.has('panel:owner'), false, 'no terminal is left behind');
    assert.equal(document.querySelectorAll('#panel-terminal-region .terminal-container').length, 0);
  } finally { ctx.destroy(); }
});

test('a reply that lands after a session switch never drags the panel back', async () => {
  const gates = [];
  const ctx = setupPanel({ openTerminal: () => new Promise((resolve) => { gates.push(resolve); }) });
  try {
    const { window, document, spies } = ctx;
    const panel = document.getElementById('file-panel');

    // A refusal, answered after the user has moved on.
    const refusing = window.togglePanelTerminal('owner');
    window.switchPanel('other');
    gates[0]({ ok: false, error: 'a remote session cannot host a panel shell' });
    await refusing;

    assert.equal(ctx.inCtx('currentPanelSessionId'), 'other', 'the panel follows the session, not the reply');
    assert.equal(panel.classList.contains('open'), false);
    assert.equal(ctx.inCtx("panelTerminals.has('owner')"), false, 'nobody is there to read it, so nothing is registered');

    // The same race on the success path, which must behave identically.
    const opening = window.togglePanelTerminal('third');
    window.switchPanel('other');
    gates[1]({ ok: true });
    await opening;

    assert.equal(ctx.inCtx('currentPanelSessionId'), 'other');
    assert.equal(panel.classList.contains('open'), false);
    assert.equal(spies.openTerminal.length, 2);
  } finally { ctx.destroy(); }
});

test('a refusal is dismissed by the Shell button and does not outlive the session', async () => {
  const ctx = setupPanel({ openTerminal: () => ({ ok: false, error: 'a remote session cannot host a panel shell' }) });
  try {
    const { window, document } = ctx;
    const panel = document.getElementById('file-panel');

    await window.togglePanelTerminal('owner');
    window.togglePanelTerminal('owner'); // one click closes it again
    assert.equal(panel.classList.contains('open'), false);
    assert.equal(ctx.inCtx("panelTerminals.has('owner')"), false);

    // And a refusal left on screen does not pin the panel for ever after.
    await window.togglePanelTerminal('owner');
    window.switchPanel('other');
    assert.equal(panel.classList.contains('open'), false);
    assert.equal(ctx.inCtx("panelTerminals.has('owner')"), false, 'the refusal describes one click, not a standing state');
    window.switchPanel('owner');
    assert.equal(panel.classList.contains('open'), false);
    assert.equal(document.getElementById('panel-terminal-region').classList.contains('open'), false);
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
    // 300 of panel content, minus the 120 the tabs above keep and the handle.
    assert.equal(ctx.inCtx('clampPanelTerminalHeight(500, 300)'), 175);
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

// jsdom lays nothing out, so the panel's own height is declared by the test.
function setPanelHeight(document, px) {
  Object.defineProperty(document.getElementById('file-panel-content'), 'clientHeight', { value: px, configurable: true });
}

test('a shrinking window clamps the region for display and gives the height back', async () => {
  const ctx = setupPanel();
  try {
    const { window, document } = ctx;
    await window.togglePanelTerminal('owner');
    const region = document.getElementById('panel-terminal-region');
    const handle = document.getElementById('panel-terminal-handle');

    setPanelHeight(document, 800);
    handle.dispatchEvent(mouse(window, 'mousedown', 400));
    document.dispatchEvent(mouse(window, 'mousemove', 220)); // drag up to 400px
    document.dispatchEvent(mouse(window, 'mouseup', 220));
    assert.equal(region.style.height, '400px');
    assert.equal(window.localStorage.getItem('panelTerminalHeight'), '400');

    setPanelHeight(document, 300);
    window.dispatchEvent(new window.Event('resize'));
    assert.equal(region.style.height, '175px', 'the ceiling applies outside a drag too');

    setPanelHeight(document, 800);
    window.dispatchEvent(new window.Event('resize'));
    assert.equal(region.style.height, '400px', 'a transient shrink must not discard the height the user chose');
  } finally { ctx.destroy(); }
});

test('a drag that hits the ceiling keeps what it asked for, not what it was shown', async () => {
  const ctx = setupPanel();
  try {
    const { window, document } = ctx;
    await window.togglePanelTerminal('owner');
    const region = document.getElementById('panel-terminal-region');
    const handle = document.getElementById('panel-terminal-handle');

    setPanelHeight(document, 300); // ceiling: 300 − 120 − 5
    window.dispatchEvent(new window.Event('resize'));
    handle.dispatchEvent(mouse(window, 'mousedown', 400));
    document.dispatchEvent(mouse(window, 'mousemove', 20)); // drag well past the ceiling
    document.dispatchEvent(mouse(window, 'mouseup', 20));

    assert.equal(region.style.height, '175px', 'the ceiling still bounds what is shown');
    assert.equal(window.localStorage.getItem('panelTerminalHeight'), '555',
      'a ceiling reached by dragging must not overwrite the request, the way a resize does not');

    setPanelHeight(document, 1200);
    window.dispatchEvent(new window.Event('resize'));
    assert.equal(region.style.height, '555px');
  } finally { ctx.destroy(); }
});

test('a session round trip on a short panel does not ratchet the region down', async () => {
  const ctx = setupPanel();
  try {
    const { window, document } = ctx;
    await window.togglePanelTerminal('owner');
    const region = document.getElementById('panel-terminal-region');
    const handle = document.getElementById('panel-terminal-handle');

    setPanelHeight(document, 800);
    handle.dispatchEvent(mouse(window, 'mousedown', 400));
    document.dispatchEvent(mouse(window, 'mousemove', 220));
    document.dispatchEvent(mouse(window, 'mouseup', 220));
    assert.equal(region.style.height, '400px');

    // Leaving and returning while the panel happens to be short — no resize event.
    setPanelHeight(document, 260);
    window.switchPanel('other');
    window.switchPanel('owner');
    assert.equal(region.style.height, '135px');

    setPanelHeight(document, 800);
    window.switchPanel('other');
    window.switchPanel('owner');
    assert.equal(region.style.height, '400px');
  } finally { ctx.destroy(); }
});

// --- 6. Grid view (the other half of assumption #2) -------------------

test('a grid round trip leaves the panel shell visible, mounted and GPU-rendered', async () => {
  const ctx = setupPanel();
  try {
    const { window, spies } = ctx;
    await window.togglePanelTerminal('owner');
    const panelEntry = window.openSessions.get('panel:owner');
    const webglDisposesBefore = spies.webglDispose;

    window.showGridView();
    assert.ok(panelEntry.element.classList.contains('visible'),
      'the grid layout must not strip .visible from a panel container');

    // Nothing to restore on the way out (the owner has no terminal of its own),
    // so no showSession runs and nothing would repair a stripped container.
    window.toggleGridView();

    assert.ok(panelEntry.element.classList.contains('visible'));
    assert.equal(panelEntry.panelMounted, true);
    assert.equal(spies.webglDispose, webglDisposesBefore,
      'leaving the grid must not suspend the panel shell, which nothing would restore');

    // The exemption must still describe reality: writes go to a visible xterm.
    window.activeSessionId = 'other';
    spies.writes.length = 0;
    window.handleTerminalData('panel:owner', 'after-grid');
    window.flushTerminalBuffer('panel:owner');
    assert.deepEqual(spies.writes, ['after-grid']);
  } finally { ctx.destroy(); }
});

test('an unmounted shell gives up its GPU context and gets it back when it returns', async () => {
  const ctx = setupPanel();
  try {
    const { window } = ctx;
    await window.togglePanelTerminal('owner');
    const panelEntry = window.openSessions.get('panel:owner');
    assert.ok(panelEntry.webglAddon, 'a mounted shell renders through WebGL');

    // The ordinary "session switch: kept running" state. Chromium caps GL
    // contexts per process, so an invisible shell must not hold one.
    window.switchPanel('other');
    assert.equal(panelEntry.webglAddon, null);

    window.showGridView();
    window.toggleGridView();
    assert.equal(panelEntry.webglAddon, null);

    window.switchPanel('owner');
    assert.ok(panelEntry.webglAddon, 'mounting restores it, the way showSession does for a session');
  } finally { ctx.destroy(); }
});

// --- 7. The shell's own exit ------------------------------------------

test('a shell that exits says so in its own terms, not the sidebar\'s', async () => {
  const ctx = setupPanel();
  try {
    const { window, spies } = ctx;
    await window.togglePanelTerminal('owner');
    assert.equal(window.isPanelTerminalSession('panel:owner'), true);
    assert.equal(window.isPanelTerminalSession('owner'), false);

    spies.writes.length = 0;
    window.notePanelTerminalExit('panel:owner', 1);

    const banner = spies.writes.join('');
    assert.match(banner, /shell exited \(code 1\)/);
    assert.doesNotMatch(banner, /sidebar/, 'a panel shell has no sidebar row to re-click');
    assert.equal(window.openSessions.get('panel:owner').closed, true);
  } finally { ctx.destroy(); }
});

test('destroying an exited shell clears the panel state instead of stranding it', async () => {
  const ctx = setupPanel();
  try {
    const { window, document } = ctx;
    await window.togglePanelTerminal('owner');
    window.notePanelTerminalExit('panel:owner', 0);

    // What the LRU does to a closed entry once its PTY is gone.
    window.destroySession('panel:owner');

    assert.equal(ctx.inCtx("panelTerminals.has('owner')"), false, 'the map is keyed by owner but must clear on the shell\'s own id');
    assert.equal(document.getElementById('panel-terminal-region').classList.contains('open'), false);
    assert.equal(document.getElementById('panel-terminal-toggle-btn').classList.contains('active'), false);
    assert.equal(document.getElementById('file-panel').classList.contains('open'), false);
  } finally { ctx.destroy(); }
});

// --- 8. Spawn races ---------------------------------------------------

test('closing while the spawn is in flight stops the shell that spawn created', async () => {
  let settle;
  const gate = new Promise((resolve) => { settle = resolve; });
  const ctx = setupPanel({ openTerminal: () => gate });
  try {
    const { window, spies } = ctx;
    const opening = window.togglePanelTerminal('owner');
    window.togglePanelTerminal('owner'); // the user closes before it lands
    settle({ ok: true });
    await opening;

    assert.equal(spies.openTerminal.length, 1);
    assert.deepEqual(spies.stopSession, ['panel:owner', 'panel:owner'],
      'stopped again once the PTY the awaited call created actually exists');
    assert.equal(window.openSessions.has('panel:owner'), false);
    assert.equal(ctx.inCtx("panelTerminals.has('owner')"), false);
  } finally { ctx.destroy(); }
});

test('re-opening while a spawn is in flight waits for the close instead of racing it', async () => {
  const gates = [];
  const ctx = setupPanel({ openTerminal: () => new Promise((resolve) => { gates.push(resolve); }) });
  try {
    const { window, spies, document } = ctx;
    const opening = window.togglePanelTerminal('owner');
    window.togglePanelTerminal('owner'); // close
    window.togglePanelTerminal('owner'); // and immediately click Shell again

    assert.equal(spies.openTerminal.length, 1,
      'a second open-terminal now would reattach to the PTY the close is killing');

    gates[0]({ ok: true });
    await microtasks();
    assert.equal(spies.openTerminal.length, 2, 'the swallowed click is honoured once the close has settled');
    gates[1]({ ok: true });
    await opening;

    assert.ok(window.openSessions.has('panel:owner'), 'three clicks end with a shell, not with nothing');
    assert.ok(document.getElementById('panel-terminal-toggle-btn').classList.contains('active'));
  } finally { ctx.destroy(); }
});

test('clicks during an in-flight close keep toggling: four of them leave no shell', async () => {
  // Only the first spawn is gated; a second one would answer at once, so a
  // regression shows up as an extra shell rather than as a hang.
  const gates = [];
  const ctx = setupPanel({
    openTerminal: () => (gates.length === 0 ? new Promise((resolve) => { gates.push(resolve); }) : { ok: true }),
  });
  try {
    const { window, spies, document } = ctx;
    const opening = window.togglePanelTerminal('owner'); // open
    window.togglePanelTerminal('owner'); // close
    window.togglePanelTerminal('owner'); // open again
    window.togglePanelTerminal('owner'); // and close again — net intent: closed

    gates[0]({ ok: true });
    await opening;
    await microtasks();

    assert.equal(spies.openTerminal.length, 1, 'the queued open was cancelled by the click after it');
    assert.equal(window.openSessions.has('panel:owner'), false, 'no shell the user asked to close is left running');
    assert.equal(ctx.inCtx("panelReopenAfterSpawn.size"), 0);
    assert.equal(document.getElementById('panel-terminal-toggle-btn').classList.contains('active'), false);
  } finally { ctx.destroy(); }
});

// --- 9. Measurement, the toggle button, and the panel's own X ----------

test('the region is laid out before the shell is measured, so the PTY is born at the right size', async () => {
  let regionOpenAtMeasure = null;
  let doc = null;
  const ctx = setupTerminalDom({
    filePanel: true,
    proposeDimensions: () => {
      if (regionOpenAtMeasure === null && doc) {
        regionOpenAtMeasure = doc.getElementById('panel-terminal-region').classList.contains('open');
      }
      return { cols: 100, rows: 40 };
    },
  });
  try {
    doc = ctx.window.document;
    ctx.window.sessionMap.set('owner', { sessionId: 'owner', projectPath: '/proj' });
    await ctx.window.togglePanelTerminal('owner');

    assert.equal(regionOpenAtMeasure, true, 'a display:none ancestor would measure 0x0 and spawn at 120x30');
    const call = ctx.spies.openTerminal[0];
    assert.deepEqual({ ...call.initialSize }, { cols: 100, rows: 40 });
  } finally { ctx.destroy(); }
});

test('the Shell button toggles the shell for the session the panel is showing', async () => {
  const ctx = setupPanel();
  try {
    const { window, document, spies } = ctx;
    window.switchPanel('owner');
    const btn = document.getElementById('panel-terminal-toggle-btn');

    btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await Promise.resolve().then(() => Promise.resolve());

    assert.equal(spies.openTerminal.length, 1);
    assert.ok(btn.classList.contains('active'));

    btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    assert.equal(window.openSessions.has('panel:owner'), false);
    assert.equal(btn.classList.contains('active'), false);
  } finally { ctx.destroy(); }
});

test('closing the tab with the panel X leaves no stale tab content above the shell', async () => {
  const status = { ok: true, branch: { head: 'main', ahead: 0, behind: 0 }, files: [], totals: { files: 0, added: 0, deleted: 0 } };
  const ctx = setupPanel({ api: { gitChangesStatus: () => Promise.resolve(status) } });
  try {
    const { window, document } = ctx;
    window.switchPanel('owner');
    await window.openChangesTab('owner');
    await window.togglePanelTerminal('owner');
    assert.equal(document.getElementById('file-panel-changes').style.display, 'flex');

    window.handleClose(); // the X on the tab toolbar

    assert.equal(document.getElementById('file-panel-changes').style.display, 'none',
      'the tab is gone, so its content must be too');
    assert.ok(document.getElementById('file-panel').classList.contains('open'),
      'the shell keeps the panel open');
    assert.equal(ctx.inCtx("filePanelState.get('owner').currentTab"), null);
  } finally { ctx.destroy(); }
});

test('the panel X over a dirty buffer asks first, and a refusal keeps both the edits and the shell', async () => {
  const status = {
    ok: true,
    kind: 'local',
    branch: { head: 'main', ahead: 0, behind: 0 },
    files: [{ path: 'src/a.js', origPath: null, staged: false, unstaged: true, untracked: false, renamed: false, state: 'M', added: 1, deleted: 0 }],
    totals: { files: 1, added: 1, deleted: 0 },
  };
  const ctx = setupPanel({
    api: {
      gitChangesStatus: () => Promise.resolve(status),
      gitChangesFile: () => Promise.resolve({ ok: true, original: 'old\n', current: 'new\n', version: 'v1' }),
    },
  });
  try {
    const { window, document } = ctx;
    const asked = [];
    window.confirm = (message) => { asked.push(message); return asked.length > 1; };
    stubChangesEditors(window);

    window.switchPanel('owner');
    await window.openChangesTab('owner');
    await microtasks(12);
    document.querySelector('.changes-file-row[data-path="src/a.js"]')
      .dispatchEvent(new window.Event('click', { bubbles: true }));
    await microtasks(12);
    await window.togglePanelTerminal('owner');
    ctx.inCtx("filePanelState.get('owner').currentTab").editorView.text = 'edited\n';

    window.handleClose(); // the X on the tab toolbar, first answer: keep the edits

    assert.equal(asked.length, 1, 'unsaved edits are never dropped without asking');
    assert.equal(document.getElementById('file-panel-changes').style.display, 'flex',
      'a refused discard leaves the tab exactly where it was');
    assert.ok(ctx.inCtx("filePanelState.get('owner').currentTab"), 'and the buffer is still there to save');
    assert.ok(window.openSessions.has('panel:owner'), 'the shell below it is untouched');

    window.handleClose(); // second answer: discard

    assert.equal(asked.length, 2);
    assert.equal(document.getElementById('file-panel-changes').style.display, 'none');
    assert.equal(ctx.inCtx("filePanelState.get('owner').currentTab"), null);
    assert.ok(window.openSessions.has('panel:owner'), 'closing the tab never closes the shell');
  } finally { ctx.destroy(); }
});

// --- 10. A panel shell is a PTY, not a session ------------------------

test('a spawn that fails after the user closed it leaves nothing behind', async () => {
  let settle;
  const gate = new Promise((resolve) => { settle = resolve; });
  const ctx = setupPanel({ openTerminal: () => gate });
  try {
    const { window, document } = ctx;
    const opening = window.togglePanelTerminal('owner');
    window.togglePanelTerminal('owner');
    settle({ ok: false, error: 'a remote session cannot host a panel shell' });
    await opening;

    assert.equal(window.openSessions.has('panel:owner'), false);
    assert.equal(document.querySelectorAll('#panel-terminal-region .terminal-container').length, 0);
    assert.equal(document.getElementById('panel-terminal-message').style.display, 'none',
      'a shell the user already closed must not report its failure');
  } finally { ctx.destroy(); }
});

test('opening never leaves a second terminal in the region', async () => {
  const ctx = setupPanel();
  try {
    const { window, document } = ctx;
    // A terminal left under the panel id with no state behind it.
    window.createTerminalEntry({ sessionId: 'panel:owner' }, { mount: document.getElementById('panel-terminal-region'), panel: true });

    await window.togglePanelTerminal('owner');

    assert.equal(document.querySelectorAll('#panel-terminal-region .terminal-container').length, 1);
    assert.ok(window.openSessions.get('panel:owner').element.classList.contains('visible'));
  } finally { ctx.destroy(); }
});

test('notePanelTerminalExit is a no-op for a shell that is already gone', () => {
  const ctx = setupPanel();
  try {
    ctx.spies.writes.length = 0;
    ctx.window.notePanelTerminalExit('panel:nobody', 0);
    assert.deepEqual(ctx.spies.writes, []);
  } finally { ctx.destroy(); }
});

test('createSplitter refuses a missing handle and stops listening when destroyed', () => {
  const ctx = setupPanel();
  try {
    const { window, document } = ctx;
    assert.equal(window.createSplitter(null, { getSize: () => 0, onDrag: () => {} }), null);
    assert.equal(window.createSplitter(document.createElement('div'), {}), null);

    let drags = 0;
    const handle = document.createElement('div');
    document.body.appendChild(handle);
    const splitter = window.createSplitter(handle, { axis: 'x', getSize: () => 10, onDrag: () => { drags++; } });
    splitter.destroy();
    handle.dispatchEvent(new window.MouseEvent('mousedown', { clientX: 10, bubbles: true }));
    document.dispatchEvent(new window.MouseEvent('mousemove', { clientX: 40, bubbles: true }));
    assert.equal(drags, 0);
    assert.equal(document.body.style.cursor, '');
  } finally { ctx.destroy(); }
});

test('panel shell ids are excluded from the running-session count', () => {
  const ctx = setupPanel();
  try {
    assert.equal(ctx.window.isPanelTerminalSessionId('panel:owner'), true);
    assert.equal(ctx.window.isPanelTerminalSessionId('owner'), false);
    assert.equal(ctx.window.isPanelTerminalSessionId(null), false);
    assert.equal(ctx.window.countSessionsWithoutPanelShells(new Set(['a', 'panel:a', 'b'])), 2);
    assert.equal(ctx.window.countSessionsWithoutPanelShells(new Set(['panel:a'])), 0,
      'a lone panel shell must not pin the poll to its fast cadence');
  } finally { ctx.destroy(); }
});
