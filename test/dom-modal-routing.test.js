'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setupTerminalDom } = require('./terminal-manager-harness');
const { loadAppFunctions } = require('./app-source');
const { setupSidebarDom } = require('./dom-setup');

function setup(api = {}) {
  const writes = [];
  const ctx = setupTerminalDom({ api: { sendInput: (...args) => writes.push(args), getEffectiveSettings: async () => ({}), ...api } });
  const { window } = ctx;
  window.cachedAllProjects = [];
  for (const name of ['choice-dialog.js', 'app-dialogs.js', 'setting-defaults.js', 'dialogs.js']) {
    const filename = path.join(__dirname, '../public', name);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), ctx.context, { filename });
  }
  const doc = window.document;
  const container = doc.createElement('div');
  container.className = 'terminal-container visible';
  container.innerHTML = '<textarea class="xterm-helper-textarea"></textarea>';
  doc.getElementById('terminals').append(container);
  const textarea = container.firstElementChild;
  const terminal = { attachCustomKeyEventHandler(handler) { this.handler = handler; } };
  window.setupTerminalKeyBindings(terminal, container, () => 's1');
  textarea.addEventListener('keydown', e => { if (terminal.handler(e)) window.api.sendInput('s1', e.key); });
  const { handleGlobalShortcut } = loadAppFunctions(ctx.context, { functions: ['handleGlobalShortcut'] });
  doc.addEventListener('keydown', handleGlobalShortcut);
  const press = (target, key, init = {}) => {
    const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  };
  return { ...ctx, doc, writes, textarea, terminal, press, handleGlobalShortcut };
}

for (const kind of ['Touched info', "What's new"]) {
  test(`the topmost ${kind} modal owns Escape over a choice question`, async () => {
    const ctx = setupSidebarDom();
    try {
      const doc = ctx.document;
      const pending = ctx.window.appConfirm({ title: 'Underneath' });
      const origin = doc.createElement('button');
      doc.body.append(origin);
      if (kind === 'Touched info') {
        const filename = path.join(__dirname, '../public/touched-files-view.js');
        vm.runInContext(fs.readFileSync(filename, 'utf8'), ctx.context, { filename });
        ctx.window.showTouchedInfo(origin);
      } else {
        require('../public/whats-new').showWhatsNew(doc, { whatsNewDismissed() {} }, ctx.window.escapeHtml,
          { sections: [] });
      }
      doc.body.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      assert.ok(doc.querySelector('.choice-dialog-overlay'), 'the underlying question must stay open');
      assert.equal(doc.querySelectorAll('.choice-dialog-overlay, .touched-info-overlay, .new-session-overlay, .whats-new-overlay').length, 1);
      doc.querySelector('.choice-dialog-cancel').click();
      await pending;
    } finally { ctx.destroy(); }
  });
}

for (const kind of ['session', 'worktree']) {
  test(`a ${kind} deletion question waits for the active choice question`, async () => {
    const ctx = setupSidebarDom();
    try {
      const first = ctx.window.appConfirm({ title: 'First' });
      const deleting = kind === 'session' ? ctx.window.showDeleteSessionDialog({ sessionId: 's1' })
        : ctx.window.showDeleteWorktreeDialog('fixture', '/fixture');
      assert.equal(ctx.document.querySelector('.new-session-overlay'), null);
      ctx.document.querySelector('.choice-dialog-confirm').click();
      assert.equal(await first, true);
      assert.ok(ctx.document.querySelector('.new-session-overlay'));
      ctx.document.body.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      assert.equal(await deleting, false);
      assert.equal(ctx.window.hasOpenModal(), false);
    } finally { ctx.destroy(); }
  });
}

for (const kind of ['New Session', 'Resume', 'Add Project', 'Remote launch', 'Send prompt', 'Dispatch agent']) {
  test(`${kind} traps body Tab, blocks background shortcuts and cancels from outside`, async () => {
    const ctx = setup();
    try {
      if (kind === 'New Session') await ctx.window.showNewSessionDialog({ projectPath: '/fixture' });
      else if (kind === 'Resume') await ctx.window.showResumeSessionDialog({ sessionId: 's1', projectPath: '/fixture' });
      else if (kind === 'Add Project') ctx.window.showAddProjectDialog();
      else if (kind === 'Remote launch') ctx.window.showRemoteLaunchDialog({ projectPath: '/fixture', remoteAlias: 'box' });
      else if (kind === 'Send prompt') ctx.window.showSendPromptDialog({ sessionId: 's1', remoteAlias: 'box' });
      else await ctx.window.showDispatchAgentDialog({ projectPath: '/fixture' });
      const overlay = ctx.doc.querySelector('.new-session-overlay, .add-project-overlay');
      const tools = [];
      ctx.window.handleToolShortcut = e => { tools.push(e.key); return false; };
      ctx.textarea.focus();
      ctx.press(ctx.textarea, 'y');
      ctx.handleGlobalShortcut(new ctx.window.KeyboardEvent('keydown', { key: 'X' }));
      assert.equal(ctx.terminal.handler(new ctx.window.KeyboardEvent('keydown', { key: 'y' })), false);
      assert.deepEqual(tools, []);
      assert.deepEqual(ctx.writes, []);
      ctx.textarea.blur();
      ctx.press(ctx.doc.body, 'Tab');
      assert.ok(overlay.contains(ctx.doc.activeElement));
      ctx.press(ctx.doc.body, 'Tab', { shiftKey: true });
      assert.ok(overlay.contains(ctx.doc.activeElement));
      const field = overlay.querySelector('input[type="text"], textarea');
      if (field) {
        if (kind === 'Remote launch') field.value = '';
        field.focus();
        assert.equal(ctx.press(field, 'y').defaultPrevented, false);
        assert.equal(ctx.press(field, 'Enter').defaultPrevented, kind === 'Add Project' || kind === 'Remote launch');
      }
      ctx.press(ctx.textarea, 'Escape');
      assert.equal(overlay.isConnected, false);
      assert.equal(ctx.window.hasOpenModal(), false);
      ctx.handleGlobalShortcut(new ctx.window.KeyboardEvent('keydown', { key: 'X' }));
      assert.deepEqual(tools, ['X']);
    } finally { ctx.destroy(); }
  });
}

test('N1: terminal and document shortcuts and PTY input stop under an open question', async () => {
  const ctx = setup();
  try {
    const tools = [], navigation = [];
    ctx.window.handleToolShortcut = e => { tools.push(e.key); return false; };
    ctx.window.isSessionNavKey = e => e.key === 'ArrowRight';
    ctx.window.handleSessionNavKey = e => navigation.push(e.key);
    const pending = ctx.window.appConfirm({ danger: true });
    ctx.textarea.focus();
    for (const key of ['X', 'ArrowRight', 'Enter', 'y']) ctx.press(ctx.textarea, key);
    assert.deepEqual(tools, []);
    assert.deepEqual(navigation, []);
    assert.deepEqual(ctx.writes, []);
    for (const key of ['X', 'ArrowRight', 'Enter', 'y']) {
      assert.equal(ctx.terminal.handler(new ctx.window.KeyboardEvent('keydown', { key })), false);
      ctx.handleGlobalShortcut(new ctx.window.KeyboardEvent('keydown', { key }));
    }
    assert.deepEqual(tools, []);
    assert.deepEqual(navigation, []);
    assert.deepEqual(ctx.writes, []);
    ctx.doc.querySelector('.choice-dialog-cancel').click();
    assert.equal(await pending, false);
    assert.equal(ctx.terminal.handler(new ctx.window.KeyboardEvent('keydown', { key: 'y' })), true);
  } finally { ctx.destroy(); }
});

test('N1: xterm protocol replies reach every PTY while a modal is open', async () => {
  const ctx = setup();
  const entries = [];
  try {
    vm.runInContext(fs.readFileSync(require.resolve('@xterm/xterm'), 'utf8'), ctx.context);
    const Xterm = ctx.window.Terminal;
    ctx.window.Terminal = class extends Xterm {
      loadAddon() {}
      get unicode() { return { activeVersion: '' }; }
      open() {}
    };
    for (const [sessionId, options] of [['s1', {}], ['background', {}], ['shell', { panel: true }]]) {
      entries.push(ctx.window.createTerminalEntry({ sessionId }, options));
    }
    const pending = ctx.window.appConfirm({ danger: true });
    for (const entry of entries) {
      await new Promise(resolve => entry.terminal.write('\x1b[6n\x1b[c\x1b[?1$p', resolve));
    }
    assert.deepEqual(ctx.writes, ['s1', 'background', 'shell'].flatMap(id => [
      [id, '\x1b[1;1R'], [id, '\x1b[?1;2c'], [id, '\x1b[?1;2$y'],
    ]));
    ctx.doc.querySelector('.choice-dialog-cancel').click();
    await pending;
    await new Promise(resolve => entries[0].terminal.write('\x1b[6n', resolve));
    assert.deepEqual(ctx.writes.at(-1), ['s1', '\x1b[1;1R']);
  } finally {
    for (const entry of entries) entry.terminal.dispose();
    ctx.destroy();
  }
});

test('registering a modal removes focus from the terminal textarea', () => {
  const ctx = setup();
  try {
    ctx.textarea.focus();
    const overlay = ctx.doc.createElement('div');
    overlay.innerHTML = '<div class="modal-dialog">Dialog</div>';
    ctx.doc.body.append(overlay);
    const unregister = ctx.window.registerModal({ overlay, cancel() {} });
    assert.equal(ctx.doc.activeElement, overlay.firstElementChild);
    assert.equal(ctx.doc.activeElement.tabIndex, -1);
    unregister();
    overlay.remove();
  } finally { ctx.destroy(); }
});

for (const mode of [null, 'plan', 'dangerous-skip']) {
  test(`Resume focuses its selected ${mode || 'default'} mode and Enter resumes from the opener`, async () => {
    const ctx = setup({ getEffectiveSettings: async () => mode === 'dangerous-skip'
      ? { dangerouslySkipPermissions: true } : { permissionMode: mode } });
    try {
      const actions = [];
      ctx.window.openSession = (session, options) => actions.push({ session, options });
      const session = { sessionId: 's1', projectPath: '/fixture' };
      ctx.textarea.focus();
      await ctx.window.showResumeSessionDialog(session);
      assert.equal(ctx.doc.activeElement.dataset.mode, String(mode));
      assert.equal(ctx.press(ctx.doc.activeElement, 'Enter').defaultPrevented, true);
      assert.equal(actions.length, 1);
      assert.equal(actions[0].session, session);
      assert.equal(actions[0].options.permissionMode, mode === 'plan' ? 'plan' : undefined);
      assert.equal(actions[0].options.dangerouslySkipPermissions, mode === 'dangerous-skip' ? true : undefined);
      assert.equal(ctx.window.hasOpenModal(), false);
      assert.deepEqual(ctx.writes, []);
    } finally { ctx.destroy(); }
  });
}

test('remote launch focuses its path and Enter launches from the opener', () => {
  const ctx = setup();
  try {
    const actions = [];
    ctx.window.launchRemoteSession = (project, request) => actions.push({ project, request });
    const project = { projectPath: '/fixture', remoteAlias: 'box' };
    ctx.textarea.focus();
    ctx.window.showRemoteLaunchDialog(project);
    assert.equal(ctx.doc.activeElement, ctx.doc.getElementById('rld-path'));
    assert.equal(ctx.press(ctx.doc.activeElement, 'Enter').defaultPrevented, true);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].project, project);
    assert.equal(actions[0].request.cwd, '/fixture');
    assert.equal(ctx.window.hasOpenModal(), false);
    assert.deepEqual(ctx.writes, []);
  } finally { ctx.destroy(); }
});

test('outside keys keep native defaults while app shortcuts stay suppressed under a modal', async () => {
  const ctx = setup();
  try {
    const pending = ctx.window.appConfirm({ danger: true });
    const native = [['I', { ctrlKey: true, shiftKey: true }], ['z', { ctrlKey: true }],
      ['a', { ctrlKey: true }], ['a', { metaKey: true }], ['F12', {}], ['F11', {}], ['y', {}]];
    for (const [key, init] of native) {
      assert.equal(ctx.press(ctx.textarea, key, init).defaultPrevented, false, key);
    }
    assert.equal(ctx.press(ctx.textarea, 'g', { ctrlKey: true, shiftKey: true }).defaultPrevented, true);
    ctx.window.setAppShortcuts({ gridToggle: { primary: true, alt: false, shift: true, key: 'x' } });
    assert.equal(ctx.press(ctx.textarea, 'x', { ctrlKey: true, shiftKey: true }).defaultPrevented, true);
    assert.equal(ctx.press(ctx.textarea, 'F6').defaultPrevented, true);
    assert.deepEqual(ctx.writes, []);
    ctx.press(ctx.doc.body, 'Escape');
    assert.equal(await pending, false);
  } finally { ctx.destroy(); }
});

test('unused question-idle adapters are absent from the renderer API', () => {
  const ctx = setup();
  try {
    for (const name of ['appDialogsIdle', 'whenChoiceDialogsIdle', 'whenModalQuestionsIdle']) {
      assert.equal(typeof ctx.window[name], 'undefined', name);
    }
  } finally { ctx.destroy(); }
});

for (const kind of ['New Session', 'Resume', 'Add Project']) {
  for (const target of ['body', 'button']) {
    test(`N3: choice Enter from ${target} never submits the underlying ${kind}`, async () => {
      const ctx = setup();
      try {
        const actions = [];
        ctx.window.launchNewSession = () => actions.push('launch');
        ctx.window.openSession = () => actions.push('resume');
        ctx.window.api.addProject = async () => { actions.push('add'); return {}; };
        ctx.window.loadProjects = async () => {};
        if (kind === 'New Session') await ctx.window.showNewSessionDialog({ projectPath: '/fixture' });
        else if (kind === 'Resume') await ctx.window.showResumeSessionDialog({ sessionId: 's1', projectPath: '/fixture' });
        else {
          ctx.window.showAddProjectDialog();
          ctx.doc.getElementById('add-project-path').value = '/fixture';
        }
        const underneath = ctx.doc.querySelector('.new-session-overlay, .add-project-overlay');
        const pending = ctx.window.appConfirm({ title: 'Top', danger: true });
        if (target === 'body') ctx.doc.activeElement.blur();
        else ctx.doc.querySelector('.choice-dialog-confirm').focus();
        const event = ctx.press(ctx.doc.activeElement, 'Enter');
        assert.equal(actions.length, 0);
        assert.equal(underneath.isConnected, true);
        assert.equal(event.defaultPrevented, true);
        if (target === 'body') {
          assert.ok(ctx.doc.querySelector('.choice-dialog-overlay'));
          ctx.doc.querySelector('.choice-dialog-cancel').click();
          assert.equal(await pending, false);
        } else assert.equal(await pending, true);
        ctx.press(ctx.doc.body, 'Escape');
        assert.equal(underneath.isConnected, false);
      } finally { ctx.destroy(); }
    });
  }
}
