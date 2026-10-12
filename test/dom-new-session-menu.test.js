'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setupSidebarDom } = require('./dom-setup');

function setup() {
  const ctx = setupSidebarDom();
  const dialogsFile = path.join(__dirname, '../public/dialogs.js');
  vm.runInContext(fs.readFileSync(dialogsFile, 'utf8'), ctx.context, { filename: dialogsFile });
  const project = { projectPath: '/fixture', folder: '-fixture', sessions: [] };
  ctx.sidebar.renderProjects([project]);
  const anchor = ctx.document.querySelector('.project-new-btn');
  const press = key => ctx.document.activeElement.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  const open = () => {
    anchor.click();
    return [...ctx.document.querySelectorAll('.new-session-popover button')];
  };
  return { ...ctx, project, anchor, press, open };
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

test('window blur with a null focusout target keeps the New session menu open', () => {
  const ctx = setup();
  try {
    const items = ctx.open();
    ctx.window.dispatchEvent(new ctx.window.Event('blur'));
    items[0].dispatchEvent(new ctx.window.FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    assert.ok(ctx.document.querySelector('.new-session-popover'));
    assert.equal(ctx.anchor.getAttribute('aria-expanded'), 'true');
  } finally { ctx.destroy(); }
});

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
