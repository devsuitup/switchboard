'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { setupTerminalDom } = require('./terminal-manager-harness');

const PUBLIC_DIR = path.join(__dirname, '../public');
const CSS = fs.readFileSync(path.join(PUBLIC_DIR, 'style.css'), 'utf8');

function setupLayout({ display = '', panelOpen = false } = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8'), {
    runScripts: 'outside-only', url: 'http://localhost/',
  });
  const { window } = dom;
  const { document } = window;
  Object.assign(window, {
    currentPanelSessionId: null, openSessions: new Map(), filePanelState: new Map(),
    gridViewActive: false, gridCards: new Map(), isMac: false, appShortcuts: {},
    formatBinding: () => '',
  });
  for (const file of ['header-controls.js', 'tool-bar.js']) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8'), dom.getInternalVMContext());
  }
  const area = document.getElementById('terminal-area');
  area.style.display = display;
  const split = document.createElement('div');
  split.id = 'terminal-split';
  const panel = document.createElement('div');
  panel.id = 'file-panel';
  panel.classList.toggle('open', panelOpen);
  split.append(panel);
  area.append(split);
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  window.initToolBar(split);
  return { window, document, main: document.getElementById('main'), area, panel, style, destroy: () => window.close() };
}

function cssRules(sheet) {
  return [...sheet.cssRules].flatMap(rule => [rule, ...(rule.cssRules ? cssRules(rule) : [])]);
}

test('terminal ancestors never use :has() selectors', () => {
  const ctx = setupLayout();
  try {
    const selectors = cssRules(ctx.style.sheet).map(rule => rule.selectorText).filter(Boolean);
    assert.deepEqual(selectors.filter(selector => /(?:#main\b|\bbody\b|\bhtml\b)[^\s,>+~]*:has\s*\(/i.test(selector)), []);
    assert.ok(selectors.includes('#agents-worktrees-toggle:has(input:disabled)'));
  } finally { ctx.destroy(); }
});

test('class selectors preserve both main min-width declarations and their conditions', async () => {
  const ctx = setupLayout();
  try {
    const rules = cssRules(ctx.style.sheet);
    const closed = rules.find(rule => rule.selectorText === '#main.terminal-area-shown');
    const open = rules.find(rule => rule.selectorText === '#main.terminal-area-shown.file-panel-open');
    assert.ok(closed, 'shown terminal area has a class-driven floor');
    assert.ok(open, 'open panel has a class-driven floor');
    assert.equal(closed.style.getPropertyValue('min-width'), 'var(--tool-main-floor)');
    assert.equal(open.style.getPropertyValue('min-width'), 'min(var(--tool-open-main-floor), calc(100vw - var(--tool-sidebar-offset)))');
    assert.equal(ctx.main.matches(closed.selectorText), true);
    assert.equal(ctx.main.matches(open.selectorText), false);
    assert.equal(ctx.window.getComputedStyle(ctx.main).minWidth, 'var(--tool-main-floor)');
    ctx.panel.classList.add('open');
    ctx.window.syncToolBar();
    assert.equal(ctx.main.matches(open.selectorText), true);
    ctx.area.style.display = 'none';
    await Promise.resolve();
    assert.equal(ctx.main.matches(closed.selectorText), false);
    assert.equal(ctx.main.matches(open.selectorText), false);
    assert.equal(ctx.window.getComputedStyle(ctx.main).minWidth, '0px');
  } finally { ctx.destroy(); }
});

for (const display of ['', 'none']) {
  for (const panelOpen of [false, true]) {
    test(`startup classes reflect terminal display ${JSON.stringify(display)} and panel open ${panelOpen}`, () => {
      const ctx = setupLayout({ display, panelOpen });
      try {
        assert.equal(ctx.main.classList.contains('terminal-area-shown'), display !== 'none');
        assert.equal(ctx.main.classList.contains('file-panel-open'), panelOpen);
      } finally { ctx.destroy(); }
    });
  }
}

test('the style observer follows terminal visibility without a session owner, including grid mode', async () => {
  const ctx = setupLayout({ display: 'none' });
  try {
    for (const display of ['', 'none', 'flex', 'none', '']) {
      ctx.area.style.display = display;
      await Promise.resolve();
      assert.equal(ctx.main.classList.contains('terminal-area-shown'), display !== 'none', display);
    }
    ctx.window.gridViewActive = true;
    ctx.window.syncToolBar();
    assert.equal(ctx.main.classList.contains('terminal-area-shown'), true);
    ctx.area.style.display = 'none';
    await Promise.resolve();
    assert.equal(ctx.main.classList.contains('terminal-area-shown'), false);
    ctx.area.style.display = '';
    await Promise.resolve();
    assert.equal(ctx.main.classList.contains('terminal-area-shown'), true);
  } finally { ctx.destroy(); }
});

test('panel open and close classes follow the real panel operations synchronously', () => {
  const ctx = setupTerminalDom({ filePanel: true });
  try {
    const { window } = ctx;
    const main = window.document.createElement('div');
    main.id = 'main';
    window.document.body.append(main);
    main.append(window.document.getElementById('terminal-area'));
    window.createTerminalEntry({ sessionId: 's1' });
    window.switchPanel('s1');
    const panel = window.document.getElementById('file-panel');
    const check = expected => {
      assert.equal(panel.classList.contains('open'), expected);
      assert.equal(main.classList.contains('file-panel-open'), expected);
    };
    check(false);
    window.showPanel({ panelWidth: 450 });
    check(true);
    window.hidePanel();
    check(false);
    window.showPanel({ panelWidth: 450 });
    window.switchPanel(null);
    check(false);
    window.switchPanel('s1');
    window.togglePanelTerminal('s1');
    check(true);
    window.hidePanel();
    check(true);
    window.togglePanelTerminal('s1');
    check(false);
  } finally { ctx.destroy(); }
});
