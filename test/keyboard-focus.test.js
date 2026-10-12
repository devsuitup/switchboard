'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');
const { setupTerminalDom } = require('./terminal-manager-harness');
const { loadAppFunctions } = require('./app-source');

function setup(surface = 'single') {
  const writes = [];
  const ctx = setupTerminalDom({ api: { sendInput: (...args) => writes.push(args) } });
  const { window } = ctx;
  const doc = window.document;
  doc.body.insertAdjacentHTML('afterbegin', '<aside id="sidebar"><button id="sidebar-first">Sessions</button><div class="session-item" data-session-id="s1">Active session</div></aside>');
  window.activeSessionId = 's1';
  const container = doc.createElement('div');
  container.className = 'terminal-container visible';
  container.innerHTML = '<div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>';
  if (surface === 'grid') {
    const grid = doc.createElement('div');
    grid.id = 'grid-container';
    grid.innerHTML = '<div class="grid-card" data-session-id="s1"></div>';
    doc.getElementById('terminal-area').appendChild(grid);
    grid.firstElementChild.appendChild(container);
    window.gridViewActive = true;
    window.gridCards.set('s1', grid.firstElementChild);
  } else if (surface === 'panel shell') {
    const region = doc.createElement('div');
    region.id = 'panel-terminal-region';
    doc.getElementById('terminal-area').appendChild(region);
    region.appendChild(container);
  } else {
    doc.getElementById('terminals').appendChild(container);
  }
  const textarea = container.querySelector('textarea');
  const terminal = { attachCustomKeyEventHandler(fn) { this.handler = fn; }, focus() { textarea.focus(); } };
  window.openSessions.set('s1', { element: container, terminal });
  window.setupTerminalKeyBindings(terminal, container, () => 's1');
  textarea.addEventListener('keydown', e => {
    if (terminal.handler(e)) window.api.sendInput('s1', e.key);
  });
  const { handleGlobalShortcut } = loadAppFunctions(ctx.context, { functions: ['handleGlobalShortcut'] });
  doc.addEventListener('keydown', handleGlobalShortcut);
  const press = (key, options = {}) => {
    const e = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
    doc.activeElement.dispatchEvent(e);
    return e;
  };
  return { ...ctx, writes, terminal, container, textarea, press };
}

for (const surface of ['single', 'grid', 'panel shell']) {
  test(`F6 from ${surface} moves focus to the active sidebar row without writing to the PTY`, () => {
    const ctx = setup(surface);
    try {
      ctx.textarea.focus();
      const e = ctx.press('F6');
      assert.equal(ctx.window.document.activeElement, ctx.window.document.querySelector('.session-item'));
      assert.deepEqual(ctx.writes, []);
      assert.equal(e.defaultPrevented, true);
    } finally { ctx.destroy(); }
  });
}

test('Shift+F6 from the sidebar returns focus to the active terminal', () => {
  const ctx = setup();
  try {
    ctx.window.document.getElementById('sidebar-first').focus();
    const e = ctx.press('F6', { shiftKey: true });
    assert.equal(ctx.window.document.activeElement, ctx.textarea);
    assert.equal(e.defaultPrevented, true);
    assert.deepEqual(ctx.writes, []);
  } finally { ctx.destroy(); }
});

function loadPublic(ctx, name) {
  const file = path.join(__dirname, '../public', name);
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx.context, { filename: file });
}

for (const dialog of ['choice', 'New Session']) {
  for (const shiftKey of [false, true]) {
    test(`${shiftKey ? 'Shift+F6' : 'F6'} keeps focus inside an open ${dialog} dialog`, async () => {
      const ctx = setup();
      try {
        loadPublic(ctx, 'choice-dialog.js');
        loadPublic(ctx, 'app-dialogs.js');
        loadPublic(ctx, 'setting-defaults.js');
        loadPublic(ctx, 'dialogs.js');
        const doc = ctx.window.document;
        if (dialog === 'choice') {
          ctx.window.showChoiceDialog({ title: 'Confirm' });
        } else {
          await ctx.window.showNewSessionDialog({ projectPath: '/fixture' });
          doc.querySelector('.new-session-cancel-btn').focus();
        }
        const focused = doc.activeElement;
        const event = ctx.press('F6', { shiftKey });
        assert.equal(doc.activeElement, focused);
        assert.equal(event.defaultPrevented, false);
        assert.deepEqual(ctx.writes, []);
      } finally { ctx.destroy(); }
    });
  }
}

for (const shiftKey of [false, true]) {
  test(`${shiftKey ? 'Shift+F6' : 'F6'} leaves an editor outside the terminal and sidebar focused`, () => {
    const ctx = setup();
    try {
      const doc = ctx.window.document;
      const editor = doc.createElement('textarea');
      doc.body.appendChild(editor);
      editor.focus();
      const event = ctx.press('F6', { shiftKey });
      assert.equal(doc.activeElement, editor);
      assert.equal(event.defaultPrevented, false);
    } finally { ctx.destroy(); }
  });
}

test('F6 preserves the focused sidebar row through a renderProjects refresh', () => {
  const ctx = setupSidebarDom();
  try {
    const doc = ctx.document;
    const sidebar = doc.createElement('aside');
    sidebar.id = 'sidebar';
    doc.body.appendChild(sidebar);
    sidebar.appendChild(doc.getElementById('sidebar-content'));
    loadPublic(ctx, 'shortcuts.js');
    loadPublic(ctx, 'terminal-manager.js');
    ctx.window.appShortcuts = {};
    const project = makeSampleProject();
    ctx.window.activeSessionId = 's-top-1';
    ctx.sidebar.renderProjects([project]);
    const terminal = doc.createElement('div');
    terminal.className = 'terminal-container';
    terminal.innerHTML = '<textarea class="xterm-helper-textarea"></textarea>';
    doc.getElementById('terminals').appendChild(terminal);
    terminal.firstElementChild.focus();
    doc.addEventListener('keydown', ctx.window.handleFocusShortcut);
    terminal.firstElementChild.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'F6', bubbles: true, cancelable: true }));
    const row = doc.getElementById('si-s-top-1');
    assert.equal(doc.activeElement, row);
    ctx.sidebar.renderProjects([project]);
    assert.equal(row.getAttribute('tabindex'), '-1');
    assert.equal(doc.activeElement, row);
  } finally { ctx.destroy(); }
});

test('F6 from a panel shell with its own PTY id leaves it and Shift+F6 focuses the owner terminal', () => {
  const ctx = setup();
  try {
    const doc = ctx.window.document;
    const shell = doc.createElement('div');
    shell.className = 'terminal-container visible';
    shell.innerHTML = '<div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>';
    const region = doc.createElement('div');
    region.id = 'panel-terminal-region';
    doc.getElementById('terminal-area').appendChild(region);
    region.appendChild(shell);
    const textarea = shell.querySelector('textarea');
    const terminal = { attachCustomKeyEventHandler(fn) { this.handler = fn; } };
    ctx.window.setupTerminalKeyBindings(terminal, shell, () => 'panel-shell:s1');
    textarea.addEventListener('keydown', e => {
      if (terminal.handler(e)) ctx.window.api.sendInput('panel-shell:s1', e.key);
    });
    textarea.focus();
    ctx.press('F6');
    assert.equal(doc.activeElement, doc.querySelector('.session-item'));
    ctx.press('F6', { shiftKey: true });
    assert.equal(doc.activeElement, ctx.textarea);
    assert.deepEqual(ctx.writes, []);
  } finally { ctx.destroy(); }
});

test('F6 skips a hidden active row and disabled controls when choosing a sidebar fallback', () => {
  const ctx = setup();
  try {
    const doc = ctx.window.document;
    doc.querySelector('.session-item').hidden = true;
    doc.getElementById('sidebar-first').disabled = true;
    doc.getElementById('sidebar').insertAdjacentHTML('beforeend', '<button id="fallback">Add project</button>');
    ctx.textarea.focus();
    ctx.press('F6');
    assert.equal(doc.activeElement.id, 'fallback');
    assert.deepEqual(ctx.writes, []);
  } finally { ctx.destroy(); }
});

test('modified F6 goes to the PTY and F6 keyup neither writes nor moves focus', () => {
  const ctx = setup();
  try {
    ctx.textarea.focus();
    ctx.press('F6', { ctrlKey: true });
    assert.equal(ctx.window.document.activeElement, ctx.textarea);
    assert.deepEqual(ctx.writes, [['s1', 'F6']]);
    assert.equal(ctx.terminal.handler(new ctx.window.KeyboardEvent('keyup', { key: 'F6' })), false);
    assert.equal(ctx.window.document.activeElement, ctx.textarea);
  } finally { ctx.destroy(); }
});

test('Shift+F6 does not focus an active terminal hidden by another view', () => {
  const ctx = setup();
  try {
    const doc = ctx.window.document;
    doc.getElementById('terminal-area').style.display = 'none';
    doc.getElementById('sidebar-first').focus();
    ctx.press('F6', { shiftKey: true });
    assert.equal(doc.activeElement.id, 'sidebar-first');
  } finally { ctx.destroy(); }
});
