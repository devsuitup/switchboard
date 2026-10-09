'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { setupTerminalDom } = require('./terminal-manager-harness');
const { loadAppFunctions } = require('./app-source');
const { matchShortcut, normalizeShortcuts } = require('../public/shortcuts');

const DIFF = { oldFilePath: '/work/a.txt', oldContent: 'before', newContent: 'after' };
const IDS = ['changes-toggle-btn', 'diff-toggle-btn', 'touched-toggle-btn', 'panel-terminal-toggle-btn'];
const CHORDS = [['e', 'toggleChangesTab'], ['d', 'showPendingDiff'], ['t', 'toggleTouchedTab'], ['s', 'togglePanelTerminal']];
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test('the live header can shrink its titles and sidebar tabs without hiding fixed controls', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const dom = new JSDOM(html);
  try {
    const { document } = dom.window;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    document.body.className = 'window-frameless platform-linux';
    for (const id of ['terminal-header-name', 'terminal-header-pty-title']) {
      assert.equal(dom.window.getComputedStyle(document.getElementById(id)).minWidth, '0px', id);
    }
    const tab = document.querySelector('.sidebar-tab');
    assert.equal(dom.window.getComputedStyle(tab).minWidth, '0px');
    assert.equal(dom.window.getComputedStyle(document.getElementById('sidebar-collapse-btn')).flexShrink, '0');
    document.getElementById('terminal-area').style.display = 'none';
    assert.equal(dom.window.getComputedStyle(document.getElementById('main')).minWidth, '0px');
    document.getElementById('terminal-area').style.display = '';
    assert.equal(dom.window.getComputedStyle(document.getElementById('main')).minWidth, 'var(--tool-main-floor)');
  } finally { dom.window.close(); }
});

function setup() {
  const responses = [];
  const ctx = setupTerminalDom({ filePanel: true, api: {
    mcpDiffResponse: (...args) => responses.push(args),
    gitChangesStatus: async () => ({ ok: true, files: [], totals: {}, branch: {} }),
    sessionTouchedFiles: async () => ({ ok: true, files: [], unresolved: [], coverage: {} }),
  } });
  const { window } = ctx;
  window.createTerminalEntry({ sessionId: 's1' });
  window.switchPanel('s1');
  window.loadCodeMirrorBundle = () => Promise.resolve();
  let destroys = 0;
  window.createMergeViewer = (parent) => {
    const dom = window.document.createElement('div');
    parent.append(dom);
    return { dom, b: { state: { doc: { toString: () => 'edited' } } }, destroy: () => { destroys++; dom.remove(); } };
  };
  return { ...ctx, responses, state: () => ctx.inCtx("filePanelState.get('s1')"), destroys: () => destroys };
}

function event(window, key, extra = {}) {
  return new window.KeyboardEvent(extra.type || 'keydown', { key, ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true, ...extra });
}

for (const [route, invoke] of [
  ['Changes button', ctx => ctx.window.document.getElementById('changes-toggle-btn').click()],
  ['Touched button', ctx => ctx.window.document.getElementById('touched-toggle-btn').click()],
  ['Changes shortcut', ctx => ctx.window.openSessions.get('s1').terminal._customKeyHandler(event(ctx.window, 'e'))],
  ['Touched shortcut', ctx => ctx.window.openSessions.get('s1').terminal._customKeyHandler(event(ctx.window, 't'))],
]) {
  test(`D0: an unanswered diff survives or is answered through ${route}`, async () => {
    const ctx = setup();
    try {
      ctx.window.openDiffTab('s1', 'd1', DIFF);
      await flush();
      invoke(ctx);
      await flush();
      assert.ok(ctx.responses.some(r => r[1] === 'd1') || ctx.state().currentTab?.diffId === 'd1' || ctx.state().parkedDiff?.diffId === 'd1', 'd1 dropped without an answer to the CLI');
      assert.equal(ctx.state().currentTab?.type, route.startsWith('Changes') ? 'changes' : 'touched', 'the route must actually open its tool');
    } finally { ctx.destroy(); }
  });
}

test('Da1: parking detaches the edited diff and returns the same editor before one answer', async () => {
  const ctx = setup();
  try {
    ctx.window.openDiffTab('s1', 'd1', DIFF);
    await flush();
    const tab = ctx.state().currentTab;
    const view = tab.editorView;
    ctx.window.document.getElementById('changes-toggle-btn').click();
    await flush();
    const btn = ctx.window.document.getElementById('diff-toggle-btn');
    assert.ok(btn && !btn.hidden);
    assert.equal(btn.getAttribute('aria-pressed'), 'false');
    assert.equal(btn.dataset.badge, 'pending');
    assert.equal(btn.getAttribute('aria-description'), 'Claude is waiting for your answer');
    assert.equal(view.dom.isConnected, false);
    assert.deepEqual(ctx.responses, []);
    btn.click();
    await flush();
    assert.equal(ctx.state().currentTab, tab);
    assert.equal(tab.editorView, view);
    assert.equal(ctx.destroys(), 0);
    assert.equal(view.dom.parentElement.id, 'file-panel-body');
    btn.click();
    assert.equal(ctx.state().currentTab, tab);
    ctx.window.document.querySelector('.file-panel-accept-btn').click();
    assert.deepEqual(ctx.responses, [['s1', 'd1', 'accept-edited', 'edited']]);
  } finally { ctx.destroy(); }
});

for (const route of ['close_tab', 'closeAllDiffTabs']) {
  test(`Da2: ${route} clears a parked diff without closing Changes or answering`, async () => {
    const ctx = setup();
    try {
      ctx.window.openDiffTab('s1', 'd1', DIFF);
      await flush();
      ctx.window.document.getElementById('changes-toggle-btn').click();
      await flush();
      if (route === 'close_tab') ctx.window.closeDiffByDiffId('s1', 'd1');
      else ctx.window.closeAllDiffs('s1');
      assert.equal(ctx.state().currentTab.type, 'changes');
      assert.ok(ctx.window.document.getElementById('diff-toggle-btn')?.hidden);
      assert.equal(ctx.state().parkedDiff, null);
      assert.equal(ctx.destroys(), 1);
      assert.deepEqual(ctx.responses, []);
    } finally { ctx.destroy(); }
  });
}

test('Da3: the icon is absent from focus order without a diff, shown while pending, gone after an answered tool switch', async () => {
  const ctx = setup();
  try {
    const btn = ctx.window.document.getElementById('diff-toggle-btn');
    assert.ok(btn?.hidden);
    assert.equal(btn.tabIndex, -1);
    ctx.window.openDiffTab('s1', 'd1', DIFF);
    await flush();
    assert.equal(btn.hidden, false);
    assert.equal(btn.getAttribute('aria-pressed'), 'true');
    ctx.window.document.querySelector('.file-panel-reject-btn').click();
    ctx.window.document.getElementById('changes-toggle-btn').click();
    await flush();
    assert.equal(btn.hidden, true);
    assert.equal(btn.tabIndex, -1);
    assert.deepEqual(ctx.responses, [['s1', 'd1', 'reject', null]]);
  } finally { ctx.destroy(); }
});

test('a panel close over Changes leaves the parked diff and its deferred open retrievable', async () => {
  const ctx = setup();
  try {
    ctx.window.openDiffTab('s1', 'd1', DIFF);
    await flush();
    ctx.window.document.getElementById('changes-toggle-btn').click();
    await flush();
    ctx.window.handleClose();
    assert.equal(ctx.state().parkedDiff?.diffId, 'd1');
    ctx.window.document.getElementById('diff-toggle-btn').click();
    ctx.window.handleClose();
    assert.deepEqual(ctx.responses, [['s1', 'd1', 'reject', null]]);
  } finally { ctx.destroy(); }
});

test('J1: only Refresh, Stop and indicators remain in the session header', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const dom = new JSDOM(html);
  try {
    const group = dom.window.document.getElementById('terminal-header-session');
    assert.ok(group, 'session group exists');
    assert.deepEqual([...group.children].map(el => el.id), ['terminal-refresh-btn', 'terminal-stop-btn', 'terminal-header-sandbox']);
    assert.equal(dom.window.document.getElementById('terminal-header-controls'), null);
    const ctx = setup();
    try {
      assert.equal(ctx.window.document.querySelector('#terminal-header [data-header-kind="toggle"]'), null);
      assert.equal(ctx.window.document.getElementById('terminal-split').lastElementChild.id, 'tool-bar');
    } finally { ctx.destroy(); }
  } finally { dom.window.close(); }
});

test('J2: the dual-mode declaration uses the shared factory with accessible creation defaults', () => {
  const file = path.join(__dirname, '../public/tool-bar.js');
  assert.ok(fs.existsSync(file), 'tool-bar module exists');
  const bar = require(file);
  const header = require('../public/header-controls');
  assert.ok(Object.isFrozen(bar.TOOL_BAR));
  assert.deepEqual(bar.TOOL_BAR.map(c => c.id), IDS);
  assert.equal(bar.createToolToggle, header.createHeaderToggle);
  const dom = new JSDOM('<body><div id="tool-bar"></div></body>');
  try {
    for (const c of bar.TOOL_BAR) {
      const btn = bar.createToolToggle({ ...c, onClick() {} }, dom.window.document);
      assert.equal(btn.getAttribute('aria-pressed'), 'false');
      assert.equal(btn.getAttribute('aria-controls'), 'file-panel');
    }
    const ctx = setup();
    try {
      const el = ctx.window.document.getElementById('tool-bar');
      assert.equal(el.getAttribute('role'), 'toolbar');
      assert.equal(el.getAttribute('aria-orientation'), 'vertical');
      assert.equal(el.getAttribute('aria-label'), 'Session tools');
      assert.match(ctx.window.document.getElementById(IDS[0]).title, /Ctrl\+Shift\+E/);
    } finally { ctx.destroy(); }
  } finally { dom.window.close(); }
});

function disabled(ctx) {
  for (const id of IDS) {
    const btn = ctx.window.document.getElementById(id);
    assert.ok(btn?.disabled, id);
    assert.equal(btn.getAttribute('aria-disabled'), 'true');
    assert.equal(btn.getAttribute('aria-pressed'), 'false');
  }
}

for (const listener of ['onSessionDetected', 'onSessionForked']) {
  test(`R2 B2: ${listener} enables tools after activation then terminal registration`, async () => {
    const ctx = setup();
    try {
      const { window } = ctx;
      let receive;
      window.api[listener] = cb => { receive = cb; };
      window.activeSessionId = 's1';
      const order = [];
      window.setActiveSession = id => {
        order.push(['activate', window.openSessions.has(id)]);
        window.activeSessionId = id;
        window.switchPanel(id);
      };
      const register = window.openSessions.set.bind(window.openSessions);
      window.openSessions.set = (id, entry) => {
        order.push(['register', id]);
        return register(id, entry);
      };
      window.rekeyActivityState = () => {};
      window.loadProjects = () => Promise.resolve();
      window.pollActiveSessions = () => {};
      window.schedulePersistWorkingSet = () => {};
      window.pendingSessions = new Map();
      window.terminalHeaderId = window.document.createElement('span');
      window.terminalHeaderName = window.document.createElement('span');
      const src = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
      const start = src.indexOf(`window.api.${listener}(`);
      assert.ok(start >= 0);
      const end = src.indexOf('\n});', start) + '\n});'.length;
      ctx.inCtx(src.slice(start, end));
      receive('s1', 'real');
      await flush();
      assert.deepEqual(order, [['activate', false], ['register', 'real']]);
      assert.ok(window.openSessions.has('real'));
      for (const id of [IDS[0], IDS[2], IDS[3]]) {
        assert.equal(window.document.getElementById(id).disabled, false, id);
        assert.equal(window.document.getElementById(id).getAttribute('aria-disabled'), 'false', id);
      }
    } finally { ctx.destroy(); }
  });
}

test('R2 M1: parking a second diff preserves both edited proposals until each is answered', async () => {
  const ctx = setup();
  try {
    const tabs = [];
    for (const id of ['d1', 'd2']) {
      ctx.window.openDiffTab('s1', id, DIFF);
      await flush();
      tabs.push(ctx.state().currentTab);
      ctx.window.document.getElementById('changes-toggle-btn').click();
      await flush();
    }
    assert.deepEqual(ctx.responses, []);
    for (const tab of tabs) {
      ctx.window.document.getElementById('diff-toggle-btn').click();
      await flush();
      assert.equal(ctx.state().currentTab, tab, `${tab.diffId} remains retrievable`);
      assert.ok(tab.editorView.dom.isConnected);
      ctx.window.document.querySelector('.file-panel-accept-btn').click();
    }
    assert.deepEqual(ctx.responses, [['s1', 'd1', 'accept-edited', 'edited'], ['s1', 'd2', 'accept-edited', 'edited']]);
  } finally { ctx.destroy(); }
});

test('R2 M1: Diff returns the parked proposal over an answered diff', async () => {
  const ctx = setup();
  try {
    ctx.window.openDiffTab('s1', 'd1', DIFF);
    await flush();
    const tab = ctx.state().currentTab;
    ctx.window.document.getElementById('changes-toggle-btn').click();
    await flush();
    ctx.window.openDiffTab('s1', 'd2', DIFF);
    await flush();
    ctx.window.document.querySelector('.file-panel-reject-btn').click();
    ctx.window.document.getElementById('diff-toggle-btn').click();
    await flush();
    assert.equal(ctx.state().currentTab, tab);
    assert.deepEqual(ctx.responses, [['s1', 'd2', 'reject', null]]);
  } finally { ctx.destroy(); }
});

for (const route of ['MCP off', 'session exit']) {
  test(`R2 m6: ${route} clears parked proposals and their waiting badge`, async () => {
    const ctx = setup();
    try {
      ctx.window.setSessionMcpState('s1', 'connected');
      ctx.window.openDiffTab('s1', 'd1', DIFF);
      await flush();
      ctx.window.document.getElementById('changes-toggle-btn').click();
      await flush();
      if (route === 'MCP off') ctx.window.setSessionMcpState('s1', 'off');
      else {
        Object.assign(ctx.window, {
          noteSessionExit() {}, dropLocalPtySession() {}, sessionItemEl: () => null,
          lastSessionExit: () => ({}), exitBannerColour: () => '', exitBannerPhrase: () => 'exited',
          schedulePersistWorkingSet() {}, pollActiveSessions() {},
        });
        loadAppFunctions(ctx.context, { functions: ['applyProcessExit'] }).applyProcessExit('s1', 0, null, false);
      }
      const btn = ctx.window.document.getElementById('diff-toggle-btn');
      assert.equal(btn.hidden, true, 'the stopped CLI is no longer waiting');
      assert.equal(btn.dataset.badge, undefined);
      assert.equal(btn.getAttribute('aria-description'), null);
      assert.equal(ctx.destroys(), 1);
      assert.deepEqual(ctx.responses, []);
      assert.equal(ctx.state().currentTab.type, 'changes');
    } finally { ctx.destroy(); }
  });
}

test('J5(i): switching to no owner disables every button and clears pressed states', async () => {
  const ctx = setup();
  try {
    await ctx.window.openChangesTab('s1');
    ctx.window.switchPanel(null);
    disabled(ctx);
  } finally { ctx.destroy(); }
});

test('J5(ii): destroying the focused grid owner disables the bar', () => {
  const ctx = setup();
  try {
    ctx.window.gridViewActive = true;
    ctx.inCtx("gridCards.set('s1', document.createElement('div'))");
    ctx.window.switchPanel('s1');
    ctx.window.destroySession('s1');
    disabled(ctx);
  } finally { ctx.destroy(); }
});

test('J5(iii): entering an empty grid disables a previously valid single owner', () => {
  const ctx = setup();
  try {
    ctx.window.showGridView();
    disabled(ctx);
  } finally { ctx.destroy(); }
});

test('J5: an asynchronous tool render cannot press a button with no shown owner', async () => {
  const ctx = setup();
  try {
    ctx.window.openSessions.delete('s1');
    await ctx.window.openChangesTab('s1');
    disabled(ctx);
  } finally { ctx.destroy(); }
});

test('J5: removing the focused card disables tools even while its terminal is open', () => {
  const ctx = setup();
  try {
    ctx.window.gridViewActive = true;
    ctx.inCtx("gridCards.set('s1', document.createElement('div'))");
    ctx.window.switchPanel('s1');
    assert.equal(ctx.window.document.getElementById(IDS[0]).disabled, false);
    ctx.window.destroyGridCard('s1');
    disabled(ctx);
  } finally { ctx.destroy(); }
});

test('J5(iv): hiding the terminal area suspends tools and returning enables its owner', async () => {
  const ctx = setup();
  try {
    ctx.inCtx(fs.readFileSync(path.join(__dirname, '../public/agents-view.js'), 'utf8'));
    await ctx.window.showAgentsView();
    await flush();
    disabled(ctx);
    assert.equal(ctx.window.openSessions.get('s1').terminal._customKeyHandler(event(ctx.window, 'e')), true);
    ctx.window.hideAgentsView();
    await flush();
    assert.equal(ctx.window.document.getElementById(IDS[0]).disabled, false);
  } finally { ctx.destroy(); }
});

test('J7: xterm dispatches each chord once, keyup never acts, and document sees the handled event', async () => {
  const ctx = setup();
  try {
    const { handleGlobalShortcut } = loadAppFunctions(ctx.context, { functions: ['handleGlobalShortcut'] });
    ctx.window.openDiffTab('s1', 'd1', DIFF);
    await flush();
    for (const [key, action] of CHORDS) {
      const calls = [];
      ctx.window[action] = id => calls.push(id);
      const handler = ctx.window.openSessions.get('s1').terminal._customKeyHandler;
      const e = event(ctx.window, key);
      assert.equal(handler(e), false);
      handleGlobalShortcut(e);
      assert.deepEqual(calls, ['s1']);
      assert.equal(handler(event(ctx.window, key, { type: 'keyup' })), false);
      assert.deepEqual(calls, ['s1']);
    }
  } finally { ctx.destroy(); }
});

test('J7: rebinding, modifiers, absent Diff and owner gaps preserve the PTY chord', () => {
  const ctx = setup();
  try {
    const calls = [];
    ctx.window.toggleChangesTab = id => calls.push(id);
    ctx.window.matchShortcut = matchShortcut;
    ctx.window.setAppShortcuts(normalizeShortcuts({ changesToggle: { primary: true, shift: true, key: 'q' } }));
    const handler = ctx.window.openSessions.get('s1').terminal._customKeyHandler;
    assert.equal(handler(event(ctx.window, 'e')), true);
    assert.equal(handler(event(ctx.window, 'q')), false);
    assert.deepEqual(calls, ['s1']);
    assert.equal(handler(event(ctx.window, 'q', { altKey: true })), true);
    assert.equal(handler(event(ctx.window, 'd')), true);
    assert.match(ctx.window.document.getElementById(IDS[0]).title, /Ctrl\+Shift\+Q/);
    ctx.window.switchPanel(null);
    assert.equal(handler(event(ctx.window, 'q')), true);
    assert.deepEqual(calls, ['s1']);
  } finally { ctx.destroy(); }
});

test('J7: a stored existing grid chord has precedence over a tool chord', () => {
  const ctx = setup();
  try {
    const calls = [];
    ctx.window.toggleChangesTab = () => calls.push('tool');
    ctx.window.toggleGridView = () => calls.push('grid');
    ctx.window.matchShortcut = matchShortcut;
    ctx.window.setAppShortcuts(normalizeShortcuts({ gridToggle: { primary: true, shift: true, key: 'e' } }));
    const { handleGlobalShortcut } = loadAppFunctions(ctx.context, { functions: ['handleGlobalShortcut'] });
    const e = event(ctx.window, 'e');
    assert.equal(ctx.window.openSessions.get('s1').terminal._customKeyHandler(e), false);
    handleGlobalShortcut(e);
    assert.deepEqual(calls, ['grid']);
  } finally { ctx.destroy(); }
});

test('J8: arrows wrap, Home/End select edges, disappearing Diff restores focus, and null owner focuses the terminal', async () => {
  const ctx = setup();
  try {
    const doc = ctx.window.document;
    const bar = doc.getElementById('tool-bar');
    assert.ok(bar);
    const check = id => {
      assert.equal(doc.activeElement.id, id);
      assert.deepEqual([...bar.querySelectorAll('[tabindex="0"]')].map(el => el.id), [id]);
    };
    const press = key => doc.activeElement.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key, bubbles: true }));
    doc.getElementById(IDS[0]).focus();
    press('ArrowDown'); check(IDS[2]);
    press('ArrowUp'); check(IDS[0]);
    press('ArrowUp'); check(IDS[3]);
    press('Home'); check(IDS[0]);
    press('End'); check(IDS[3]);
    press('ArrowDown'); check(IDS[0]);
    ctx.window.openDiffTab('s1', 'd1', DIFF);
    await flush();
    doc.getElementById(IDS[1]).focus();
    ctx.window.closeDiffByDiffId('s1', 'd1');
    check(IDS[0]);
    const entry = ctx.window.openSessions.get('s1');
    const input = doc.createElement('textarea');
    entry.element.append(input);
    entry.terminal.focus = () => input.focus();
    ctx.window.switchPanel(null);
    assert.equal(doc.activeElement, input);
    assert.equal(bar.querySelectorAll('[tabindex="0"]').length, 0);
  } finally { ctx.destroy(); }
});
