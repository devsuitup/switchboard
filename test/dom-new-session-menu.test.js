'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setupSidebarDom } = require('./dom-setup');

function setup() {
  const ctx = setupSidebarDom();
  ctx.evalPublic('setting-defaults.js');
  const dialogsFile = path.join(__dirname, '../public/dialogs.js');
  vm.runInContext(fs.readFileSync(dialogsFile, 'utf8'), ctx.context, { filename: dialogsFile });
  const project = { projectPath: '/fixture', folder: '-fixture', sessions: [] };
  ctx.sidebar.renderProjects([project]);
  const anchor = ctx.document.querySelector('.project-new-btn');
  const press = (key, options = {}) => {
    const event = new ctx.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
    ctx.document.activeElement.dispatchEvent(event);
    return event;
  };
  const open = () => {
    anchor.click();
    return [...ctx.document.querySelectorAll('.new-session-popover button')];
  };
  return { ...ctx, project, anchor, press, open };
}

async function openConfigure(ctx) {
  const showDialog = ctx.window.showNewSessionDialog;
  let opened;
  ctx.window.showNewSessionDialog = (...args) => {
    opened = showDialog(...args);
    return opened;
  };
  ctx.anchor.focus();
  ctx.open();
  ctx.press('ArrowDown');
  ctx.press('Enter');
  await opened;
  return ctx.document.querySelector('.new-session-dialog');
}

test('keyboard Configure focuses the first New Session field', async () => {
  const ctx = setup();
  try {
    const dialog = await openConfigure(ctx);
    assert.ok(dialog);
    assert.equal(ctx.document.querySelector('.new-session-popover'), null);
    assert.equal(ctx.document.activeElement, dialog.querySelector('#nsd-mode-grid button'));
  } finally { ctx.destroy(); }
});

test('New Session focuses the configured acceptEdits mode on open', async () => {
  const ctx = setup();
  try {
    ctx.window.api.getEffectiveSettings = async () => ({ permissionMode: 'acceptEdits' });
    const dialog = await openConfigure(ctx);
    assert.equal(ctx.document.activeElement, dialog.querySelector('[data-mode="acceptEdits"]'));
  } finally { ctx.destroy(); }
});

test('New Session focuses Dangerous Skip when configured on open', async () => {
  const ctx = setup();
  try {
    ctx.window.api.getEffectiveSettings = async () => ({ dangerouslySkipPermissions: true });
    const dialog = await openConfigure(ctx);
    assert.equal(ctx.document.activeElement, dialog.querySelector('[data-mode="dangerous-skip"]'));
  } finally { ctx.destroy(); }
});

for (const action of ['Escape', 'Cancel', 'outside click']) {
  test(`${action} closes New Session and restores focus to +`, async () => {
    const ctx = setup();
    try {
      let launches = 0;
      ctx.window.launchNewSession = () => { launches++; };
      const dialog = await openConfigure(ctx);
      dialog.querySelector('#nsd-worktree-name').focus();
      if (action === 'Escape') ctx.press('Escape');
      else if (action === 'outside click') ctx.document.querySelector('.new-session-overlay').click();
      else dialog.querySelector('.new-session-cancel-btn').click();
      assert.equal(ctx.document.querySelector('.new-session-overlay'), null);
      assert.equal(ctx.document.activeElement, ctx.anchor);
      assert.equal(launches, 0);
    } finally { ctx.destroy(); }
  });
}

test('Start closes New Session without returning focus to the opener and preserves launch focus', async () => {
  const ctx = setup();
  try {
    ctx.document.getElementById('terminals').innerHTML = '<div class="terminal-container visible"><textarea class="xterm-helper-textarea"></textarea></div>';
    const terminal = ctx.document.querySelector('.xterm-helper-textarea');
    let launches = 0;
    ctx.window.launchNewSession = () => { launches++; terminal.focus(); };
    const dialog = await openConfigure(ctx);
    let openerFocuses = 0;
    ctx.anchor.addEventListener('focus', () => { openerFocuses++; });
    dialog.querySelector('.new-session-start-btn').click();
    assert.equal(ctx.document.querySelector('.new-session-overlay'), null);
    assert.equal(openerFocuses, 0);
    assert.equal(ctx.document.activeElement, terminal);
    assert.equal(launches, 1);
  } finally { ctx.destroy(); }
});

test('New Session remembers its direct opener before the settings lookup resolves', async () => {
  const ctx = setup();
  try {
    let resolveSettings;
    ctx.window.api.getEffectiveSettings = () => new Promise(resolve => { resolveSettings = resolve; });
    ctx.anchor.focus();
    const opened = ctx.window.showNewSessionDialog(ctx.project);
    ctx.anchor.blur();
    resolveSettings({});
    await opened;
    ctx.document.querySelector('#nsd-worktree-name').focus();
    ctx.press('Escape');
    assert.equal(ctx.document.activeElement, ctx.anchor);
  } finally { ctx.destroy(); }
});

test('New Session returns focus to the replacement project + when its opener is removed', async () => {
  const ctx = setup();
  try {
    await openConfigure(ctx);
    const replacement = ctx.anchor.cloneNode(true);
    ctx.anchor.replaceWith(replacement);
    ctx.document.querySelector('#nsd-worktree-name').focus();
    ctx.press('Escape');
    assert.equal(ctx.document.activeElement, replacement);
  } finally { ctx.destroy(); }
});

test('New Session falls back to the visible terminal when the project opener disappears', async () => {
  const ctx = setup();
  try {
    ctx.document.getElementById('terminals').innerHTML = '<div class="terminal-container visible"><textarea class="xterm-helper-textarea"></textarea></div>';
    await openConfigure(ctx);
    ctx.anchor.closest('.project-group').remove();
    ctx.document.querySelector('#nsd-worktree-name').focus();
    ctx.press('Escape');
    assert.equal(ctx.document.activeElement, ctx.document.querySelector('.xterm-helper-textarea'));
  } finally { ctx.destroy(); }
});

test('New Session falls back to the session terminal ahead of the visible panel shell', async () => {
  const ctx = setup();
  try {
    ctx.document.getElementById('terminals').innerHTML = '<div class="terminal-container visible panel-terminal"><textarea class="xterm-helper-textarea"></textarea></div><div class="terminal-container visible"><textarea id="session-terminal" class="xterm-helper-textarea"></textarea></div>';
    await openConfigure(ctx);
    ctx.anchor.closest('.project-group').remove();
    ctx.press('Escape');
    assert.equal(ctx.document.activeElement, ctx.document.getElementById('session-terminal'));
  } finally { ctx.destroy(); }
});

test('New Session skips a disabled opener when restoring focus', async () => {
  const ctx = setup();
  try {
    ctx.document.getElementById('terminals').innerHTML = '<div class="terminal-container visible"><textarea class="xterm-helper-textarea"></textarea></div>';
    await openConfigure(ctx);
    ctx.anchor.disabled = true;
    ctx.press('Escape');
    assert.equal(ctx.document.activeElement, ctx.document.querySelector('.xterm-helper-textarea'));
  } finally { ctx.destroy(); }
});

test('New Session falls back to Add Project when only the panel shell remains', async () => {
  const ctx = setup();
  try {
    ctx.document.body.insertAdjacentHTML('beforeend', '<button id="add-project-btn">Add Project</button>');
    ctx.document.getElementById('terminals').innerHTML = '<div class="terminal-container visible panel-terminal"><textarea class="xterm-helper-textarea"></textarea></div>';
    await openConfigure(ctx);
    ctx.anchor.closest('.project-group').remove();
    ctx.press('Escape');
    assert.equal(ctx.document.activeElement, ctx.document.getElementById('add-project-btn'));
  } finally { ctx.destroy(); }
});

for (const target of ['selected mode', 'checkbox', 'Start', 'body']) {
  test(`Enter on ${target} starts New Session once with acceptEdits`, async () => {
    const ctx = setup();
    try {
      const launches = [];
      ctx.window.api.getEffectiveSettings = async () => ({ permissionMode: 'acceptEdits' });
      ctx.window.launchNewSession = (project, options) => { launches.push({ project, options }); };
      const dialog = await openConfigure(ctx);
      const selectors = {
        'selected mode': '[data-mode="acceptEdits"]',
        checkbox: '#nsd-worktree',
        Start: '.new-session-start-btn',
      };
      const control = target === 'body' ? ctx.document.body : dialog.querySelector(selectors[target]);
      if (target === 'body') ctx.document.activeElement.blur();
      else control.focus();
      const event = ctx.press('Enter');
      if (!event.defaultPrevented && control.tagName === 'BUTTON') control.click();
      assert.equal(event.defaultPrevented, true);
      assert.equal(launches.length, 1);
      assert.equal(launches[0].project, ctx.project);
      assert.equal(launches[0].options.permissionMode, 'acceptEdits');
      assert.equal(ctx.document.querySelector('.new-session-overlay'), null);
    } finally { ctx.destroy(); }
  });
}

for (const handled of [false, true]) {
  test(`Enter ${handled ? 'already handled' : 'from a control outside the dialog'} does not start New Session`, async () => {
    const ctx = setup();
    try {
      const launches = [];
      ctx.window.launchNewSession = (project, options) => { launches.push({ project, options }); };
      const dialog = await openConfigure(ctx);
      const outside = ctx.document.createElement('textarea');
      ctx.document.body.appendChild(outside);
      const target = handled ? dialog.querySelector('.new-session-start-btn') : outside;
      target.focus();
      assert.ok(dialog.contains(ctx.document.activeElement), 'outside focus is returned to the dialog');
      if (handled) ctx.window.addEventListener('keydown', e => e.preventDefault(), { once: true, capture: true });
      target.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      assert.equal(launches.length, 0);
      assert.ok(ctx.document.querySelector('.new-session-overlay'));
    } finally { ctx.destroy(); }
  });
}

test('a mode click keeps focus on the rebuilt selected mode', async () => {
  const ctx = setup();
  try {
    const dialog = await openConfigure(ctx);
    const mode = dialog.querySelector('[data-mode="acceptEdits"]');
    mode.focus();
    mode.querySelector('.perm-name').click();
    const rebuilt = dialog.querySelector('[data-mode="acceptEdits"]');
    assert.notEqual(rebuilt, mode);
    assert.ok(rebuilt.classList.contains('selected'));
    assert.equal(ctx.document.activeElement, rebuilt);
    assert.ok(dialog.contains(ctx.document.activeElement));
  } finally { ctx.destroy(); }
});

test('toggling Dangerous Skip off focuses the selected Default mode', async () => {
  const ctx = setup();
  try {
    ctx.window.api.getEffectiveSettings = async () => ({ dangerouslySkipPermissions: true });
    const dialog = await openConfigure(ctx);
    dialog.querySelector('[data-mode="dangerous-skip"]').click();
    assert.equal(ctx.document.activeElement, dialog.querySelector('[data-mode="null"]'));
    assert.ok(ctx.document.activeElement.classList.contains('selected'));
  } finally { ctx.destroy(); }
});

test('Enter on Cancel closes New Session without launching and restores focus to +', async () => {
  const ctx = setup();
  try {
    let launches = 0;
    ctx.window.launchNewSession = () => { launches++; };
    const dialog = await openConfigure(ctx);
    dialog.querySelector('.new-session-cancel-btn').focus();
    ctx.press('Enter');
    assert.equal(launches, 0);
    assert.equal(ctx.document.querySelector('.new-session-overlay'), null);
    assert.equal(ctx.document.activeElement, ctx.anchor);
  } finally { ctx.destroy(); }
});

for (const selector of ['#nsd-worktree-name', '#nsd-pre-launch', '#nsd-add-dirs']) {
  test(`Enter in ${selector} does not start New Session`, async () => {
    const ctx = setup();
    try {
      let launches = 0;
      ctx.window.launchNewSession = () => { launches++; };
      const dialog = await openConfigure(ctx);
      const input = dialog.querySelector(selector);
      input.focus();
      const event = ctx.press('Enter');
      assert.equal(launches, 0);
      assert.ok(dialog.isConnected);
      assert.equal(ctx.document.activeElement, input);
      assert.equal(event.defaultPrevented, false);
    } finally { ctx.destroy(); }
  });
}

test('mousedown on New session menu padding keeps the menu open', () => {
  const ctx = setup();
  try {
    ctx.open();
    const popover = ctx.document.querySelector('.new-session-popover');
    const event = new ctx.window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    popover.dispatchEvent(event);
    if (!event.defaultPrevented) {
      if (popover.hasAttribute('tabindex')) popover.focus();
      else ctx.document.activeElement.blur();
    }
    assert.equal(ctx.document.querySelector('.new-session-popover'), popover);
    assert.equal(ctx.anchor.getAttribute('aria-expanded'), 'true');
  } finally { ctx.destroy(); }
});

test('a null focusout target keeps the New session menu open when focus settles inside it', async () => {
  const ctx = setup();
  try {
    const items = ctx.open();
    ctx.window.dispatchEvent(new ctx.window.Event('blur'));
    items[0].dispatchEvent(new ctx.window.FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    items[1].focus();
    await Promise.resolve();
    assert.ok(ctx.document.querySelector('.new-session-popover'));
    assert.equal(ctx.document.activeElement, items[1]);
    assert.equal(ctx.anchor.getAttribute('aria-expanded'), 'true');
  } finally { ctx.destroy(); }
});

test('a null focusout target closes the New session menu when focus leaves the document', async () => {
  const ctx = setup();
  try {
    const items = ctx.open();
    let relatedTarget = 'not observed';
    items[0].addEventListener('focusout', event => { relatedTarget = event.relatedTarget; });
    items[0].blur();
    await Promise.resolve();
    assert.equal(relatedTarget, null);
    assert.equal(ctx.document.activeElement, ctx.document.body);
    assert.equal(ctx.document.querySelector('.new-session-popover'), null);
    assert.equal(ctx.anchor.getAttribute('aria-expanded'), 'false');
  } finally { ctx.destroy(); }
});

test('a null focusout target waits for focus to settle before closing the New session menu', async () => {
  const ctx = setup();
  try {
    const items = ctx.open();
    items[0].blur();
    items[1].focus();
    await Promise.resolve();
    assert.ok(ctx.document.querySelector('.new-session-popover'));
    assert.equal(ctx.anchor.getAttribute('aria-expanded'), 'true');
  } finally { ctx.destroy(); }
});

test('a null focusout from a replaced New session menu leaves the reopened menu open', async () => {
  const ctx = setup();
  try {
    const items = ctx.open();
    items[0].blur();
    const reopened = ctx.open();
    await Promise.resolve();
    assert.ok(reopened[0].isConnected);
    assert.equal(ctx.document.querySelectorAll('.new-session-popover').length, 1);
    assert.equal(ctx.anchor.getAttribute('aria-expanded'), 'true');
  } finally { ctx.destroy(); }
});

for (const shiftKey of [false, true]) {
  test(`${shiftKey ? 'Shift+Tab' : 'Tab'} closes the New session menu and lets native navigation continue from +`, () => {
    const ctx = setup();
    try {
      const items = ctx.open();
      items[2].focus();
      const event = ctx.press('Tab', { shiftKey });
      assert.equal(ctx.document.querySelector('.new-session-popover'), null);
      assert.equal(ctx.anchor.getAttribute('aria-expanded'), 'false');
      assert.equal(ctx.document.activeElement, ctx.anchor);
      assert.equal(event.defaultPrevented, false);
    } finally { ctx.destroy(); }
  });
}

test('sidebar refresh skips New session button probes on non-stateful nodes', () => {
  const ctx = setup();
  try {
    const morphdom = ctx.window.morphdom;
    let probes = 0;
    ctx.window.morphdom = (from, to, options) => {
      const before = options.onBeforeElUpdated;
      options.onBeforeElUpdated = (fromEl, toEl) => {
        const classes = fromEl.classList;
        const contains = classes.contains.bind(classes);
        const stateful = contains('js-stateful');
        classes.contains = name => {
          if (!stateful && name === 'project-new-btn') probes++;
          return contains(name);
        };
        try { return before(fromEl, toEl); }
        finally { delete classes.contains; }
      };
      return morphdom(from, to, options);
    };
    ctx.sidebar.renderProjects([ctx.project]);
    assert.equal(probes, 0);
  } finally { ctx.destroy(); }
});

test('opening the New session menu focuses its first menuitem and exposes menu semantics', () => {
  const ctx = setup();
  try {
    const items = ctx.open();
    assert.equal(ctx.document.activeElement, items[0]);
    assert.equal(ctx.document.querySelector('.new-session-popover').getAttribute('role'), 'menu');
    assert.ok(items.every(item => item.getAttribute('role') === 'menuitem'));
    assert.equal(ctx.anchor.getAttribute('aria-expanded'), 'true');
  } finally { ctx.destroy(); }
});

test('project and worktree New session buttons announce a collapsed menu before opening', () => {
  const ctx = setup();
  try {
    const wt = { projectPath: '/fixture/.claude/worktrees/child', folder: '-fixture-child', sessions: [] };
    ctx.sidebar.renderProjects([ctx.project, wt]);
    const buttons = [...ctx.document.querySelectorAll('.project-new-btn')];
    assert.equal(buttons.length, 2);
    assert.ok(ctx.document.querySelector('.worktree-new-btn'));
    for (const button of buttons) {
      assert.equal(button.getAttribute('aria-haspopup'), 'menu');
      assert.equal(button.getAttribute('aria-expanded'), 'false');
      button.click();
      assert.equal(ctx.document.activeElement, ctx.document.querySelector('.new-session-popover button'));
      ctx.press('Escape');
      assert.equal(ctx.document.activeElement, button);
    }
  } finally { ctx.destroy(); }
});

test('New session menu arrows wrap and Home/End focus the edges with one Tab stop', () => {
  const ctx = setup();
  try {
    const items = ctx.open();
    items[0].focus();
    const check = index => {
      assert.equal(ctx.document.activeElement, items[index]);
      assert.deepEqual(items.filter(item => item.tabIndex === 0), [items[index]]);
    };
    ctx.press('ArrowDown'); check(1);
    ctx.press('ArrowDown'); check(2);
    ctx.press('ArrowDown'); check(0);
    ctx.press('ArrowUp'); check(2);
    ctx.press('Home'); check(0);
    ctx.press('End'); check(2);
  } finally { ctx.destroy(); }
});

test('Escape closes the New session menu and returns focus to its opener', () => {
  const ctx = setup();
  try {
    const items = ctx.open();
    items[1].focus();
    ctx.press('Escape');
    assert.equal(ctx.document.querySelector('.new-session-popover'), null);
    assert.equal(ctx.document.activeElement, ctx.anchor);
    assert.equal(ctx.anchor.getAttribute('aria-expanded'), 'false');
  } finally { ctx.destroy(); }
});

test('focus leaving the New session menu closes it without stealing outside focus', () => {
  const ctx = setup();
  try {
    const items = ctx.open();
    items[0].focus();
    ctx.document.body.insertAdjacentHTML('beforeend', '<button id="outside">Outside</button>');
    ctx.document.getElementById('outside').focus();
    assert.equal(ctx.document.querySelector('.new-session-popover'), null);
    assert.equal(ctx.document.activeElement.id, 'outside');
    assert.equal(ctx.anchor.getAttribute('aria-expanded'), 'false');
  } finally { ctx.destroy(); }
});

for (const key of ['Enter', ' ']) {
  test(`${key === ' ' ? 'Space' : key} activates Terminal once and closes the New session menu`, () => {
    const ctx = setup();
    try {
      const launches = [];
      ctx.window.launchTerminalSession = project => launches.push(project.projectPath);
      const items = ctx.open();
      items[2].focus();
      ctx.press(key);
      assert.deepEqual(launches, ['/fixture']);
      assert.equal(ctx.document.querySelector('.new-session-popover'), null);
      assert.equal(ctx.anchor.getAttribute('aria-expanded'), 'false');
    } finally { ctx.destroy(); }
  });
}

test('outside mousedown closes the New session menu immediately and mouse Terminal still launches', () => {
  const ctx = setup();
  try {
    ctx.open();
    ctx.document.body.dispatchEvent(new ctx.window.MouseEvent('mousedown', { bubbles: true }));
    assert.equal(ctx.document.querySelector('.new-session-popover'), null);
    assert.equal(ctx.anchor.getAttribute('aria-expanded'), 'false');
    const launches = [];
    ctx.window.launchTerminalSession = project => launches.push(project.projectPath);
    ctx.open()[2].click();
    assert.deepEqual(launches, ['/fixture']);
  } finally { ctx.destroy(); }
});

test('replacing a New session menu resets the old opener and Escape focuses the new opener', () => {
  const ctx = setup();
  try {
    ctx.open();
    const second = ctx.document.createElement('button');
    ctx.document.body.appendChild(second);
    ctx.window.showNewSessionPopover(ctx.project, second);
    assert.equal(ctx.document.querySelectorAll('.new-session-popover').length, 1);
    assert.equal(ctx.anchor.getAttribute('aria-expanded'), 'false');
    ctx.press('Escape');
    assert.equal(ctx.document.activeElement, second);
    assert.equal(second.getAttribute('aria-expanded'), 'false');
  } finally { ctx.destroy(); }
});

test('a sidebar refresh keeps aria-expanded true while the New session menu is open', () => {
  const ctx = setup();
  try {
    ctx.open();
    assert.equal(ctx.anchor.getAttribute('aria-expanded'), 'true');
    ctx.sidebar.renderProjects([ctx.project]);
    assert.equal(ctx.anchor.getAttribute('aria-expanded'), 'true');
    assert.ok(ctx.document.querySelector('.new-session-popover'));
    ctx.press('Escape');
    assert.equal(ctx.anchor.getAttribute('aria-expanded'), 'false');
    assert.equal(ctx.document.activeElement, ctx.anchor);
  } finally { ctx.destroy(); }
});

test('mouse Claude and Configure keep their existing launch actions and close the menu', async () => {
  const ctx = setup();
  try {
    const calls = [];
    ctx.window.resolveDefaultSessionOptions = async () => ({ permissionMode: 'plan' });
    const launched = new Promise(resolve => {
      ctx.window.launchNewSession = (project, options) => {
        calls.push([project.projectPath, options.permissionMode]);
        resolve();
      };
    });
    ctx.window.showNewSessionDialog = project => calls.push([project.projectPath, 'configure']);
    ctx.open()[0].click();
    await launched;
    assert.deepEqual(calls, [['/fixture', 'plan']]);
    assert.equal(ctx.document.querySelector('.new-session-popover'), null);
    assert.equal(ctx.anchor.getAttribute('aria-expanded'), 'false');
    ctx.open()[1].click();
    assert.deepEqual(calls, [['/fixture', 'plan'], ['/fixture', 'configure']]);
    assert.equal(ctx.document.querySelector('.new-session-popover'), null);
    assert.equal(ctx.anchor.getAttribute('aria-expanded'), 'false');
  } finally { ctx.destroy(); }
});
