'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom } = require('./dom-setup');

const parts = [
  { sessionId: 'root-000', name: 'Original', modified: '2026-10-10T09:00:00Z' },
  { sessionId: 'member-111', aiTitle: 'Middle', modified: '2026-10-11T09:00:00Z' },
  { sessionId: 'head-222', summary: 'Latest', modified: '2026-10-12T09:00:00Z' },
];
const row = { ...parts[0], modified: parts[2].modified, headSessionId: 'head-222', mergedMemberIds: ['head-222', 'member-111'], conversationParts: parts };

function setup(t, session = row) {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  ctx.window.sessionMap.set(session.sessionId, session);
  return ctx;
}

function menu(ctx, session = row) {
  ctx.window.showSessionContextMenu({ clientX: 20, clientY: 20 }, session.sessionId);
  return ctx.document.querySelector('.session-context-menu');
}

function openParts(ctx, session = row) {
  const root = menu(ctx, session);
  const button = [...root.querySelectorAll('button')].find(b => b.textContent === 'Parts');
  assert.ok(button, 'merged rows offer Parts');
  button.click();
  return root.querySelector('[aria-label="Parts"]');
}

test('a merged row shows its head short id and the exact parts badge and title', t => {
  const ctx = setup(t);
  const item = ctx.sidebar.buildSessionItem(row);
  assert.equal(item.querySelector('.session-short-id').textContent, 'head');
  assert.equal(item.querySelector('.session-short-id').title, 'head-222');
  assert.equal(item.querySelector('.session-parts-badge').textContent, '3 parts');
  assert.equal(item.querySelector('.session-parts-badge').title, 'This conversation has 3 parts: compaction mirrors and continuations of one exchange');
});

test('an unmerged row has neither a badge nor a Parts menu', t => {
  const session = { ...parts[0], mergedMemberIds: [] };
  const ctx = setup(t, session);
  assert.equal(ctx.sidebar.buildSessionItem(session).querySelector('.session-parts-badge'), null);
  assert.equal([...menu(ctx, session).querySelectorAll('button')].some(b => b.textContent === 'Parts'), false);
});

for (const remoteAlias of [null, 'host']) {
  test(`Parts lists every part newest first and targets member actions (${remoteAlias || 'local'})`, t => {
    const session = { ...row, remoteAlias };
    const ctx = setup(t, session);
    const copied = [], viewed = [];
    ctx.window.api.writeClipboard = id => { copied.push(id); return Promise.resolve(); };
    ctx.window.showJsonlViewer = s => viewed.push(s);
    let list = openParts(ctx, session);
    assert.deepEqual([...list.querySelectorAll('.session-part-label')].map(el => el.textContent),
      [parts[2], parts[1], parts[0]].map(p => `${p.name || p.aiTitle || p.summary} · last active ${ctx.window.formatDate(new Date(p.modified))}`));
    const member = list.querySelector('[data-part-id="member-111"]');
    [...member.querySelectorAll('button')].find(b => b.textContent === 'Copy id').click();
    assert.deepEqual(copied, ['member-111']);
    assert.equal(ctx.document.querySelector('.app-notice'), null, 'successful copying stays silent');
    assert.equal(ctx.document.querySelector('.session-context-menu'), null);
    list = openParts(ctx, session);
    [...list.querySelector('[data-part-id="member-111"]').querySelectorAll('button')].find(b => b.textContent === 'View messages').click();
    assert.equal(viewed[0].sessionId, 'member-111');
    assert.equal(viewed[0].remoteAlias, remoteAlias);
    assert.equal(viewed[0].aiTitle, 'Middle');
  });
}

test('Parts uses human fallbacks for absent names and absent or invalid dates', t => {
  const session = { ...row, conversationParts: [{ sessionId: 'root-000' }, { sessionId: 'head-222', modified: 'invalid' }] };
  const ctx = setup(t, session);
  const list = openParts(ctx, session);
  assert.deepEqual([...list.querySelectorAll('.session-part-label')].map(el => el.textContent),
    Array(3).fill('Untitled conversation · last active unknown'));
});

test('Parts supports keyboard opening, navigation, return and dismissal', t => {
  const ctx = setup(t);
  const root = menu(ctx);
  const button = [...root.querySelectorAll('button')].find(b => b.textContent === 'Parts');
  assert.ok(button);
  const key = (target, value) => target.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
  button.focus();
  key(button, 'ArrowRight');
  const list = root.querySelector('[aria-label="Parts"]');
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(ctx.document.activeElement.textContent, 'View messages');
  key(ctx.document.activeElement, 'ArrowDown');
  assert.equal(ctx.document.activeElement.textContent, 'Copy id');
  key(ctx.document.activeElement, 'ArrowLeft');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(ctx.document.activeElement, button);
  assert.ok(list.hidden);
  key(button, 'Enter');
  assert.equal(list.hidden, false);
  key(ctx.document.activeElement, 'Escape');
  assert.equal(ctx.document.querySelector('.session-context-menu'), null);
});

test('Parts permits internal scrolling and dismisses on outside click and page scroll', t => {
  const ctx = setup(t);
  let list = openParts(ctx);
  list.dispatchEvent(new ctx.window.Event('scroll'));
  assert.ok(ctx.document.querySelector('.session-context-menu'));
  ctx.document.body.dispatchEvent(new ctx.window.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(ctx.document.querySelector('.session-context-menu'), null);
  list = openParts(ctx);
  ctx.document.dispatchEvent(new ctx.window.Event('scroll'));
  assert.equal(ctx.document.querySelector('.session-context-menu'), null);
});

test('Parts expansion near the viewport bottom keeps every action within reach', t => {
  const ctx = setup(t);
  Object.defineProperty(ctx.window.HTMLElement.prototype, 'offsetHeight', { configurable: true, get() {
    return this.classList.contains('session-context-menu')
      ? (this.querySelector('.session-parts-menu')?.hidden ? 100 : 500) : 0;
  } });
  ctx.window.showSessionContextMenu({ clientX: 20, clientY: ctx.window.innerHeight - 20 }, row.sessionId);
  const root = ctx.document.querySelector('.session-context-menu');
  [...root.querySelectorAll('button')].find(b => b.textContent === 'Parts').click();
  assert.ok(parseFloat(root.style.top) + root.offsetHeight <= ctx.window.innerHeight - 4,
    'expanded menu fits the viewport');
});

test('an open Parts menu yields keyboard control when focus moves outside it', t => {
  const ctx = setup(t);
  openParts(ctx);
  const input = ctx.document.createElement('textarea');
  ctx.document.body.appendChild(input);
  input.focus();
  const event = new ctx.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true });
  input.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false, 'the new focused control keeps its keyboard behavior');
  assert.equal(ctx.document.activeElement, input);
  assert.equal(ctx.document.querySelector('.session-context-menu'), null);
});

test('Copy id rejection shows a persistent error notice with a reason and recovery', async t => {
  const ctx = setup(t);
  ctx.window.api.writeClipboard = () => Promise.reject(new Error('Clipboard unavailable'));
  const list = openParts(ctx);
  [...list.querySelector('[data-part-id="member-111"]').querySelectorAll('button')]
    .find(button => button.textContent === 'Copy id').click();
  await new Promise(resolve => setImmediate(resolve));
  const notice = ctx.document.querySelector('.app-notice[role="alert"]');
  assert.ok(notice, 'copy failure is visible after the menu closes');
  assert.equal(notice.querySelector('.app-notice-message').textContent,
    'Could not copy the id member: Clipboard unavailable. Try Copy id again.');
  assert.ok(notice.querySelector('.app-notice-dismiss'), 'error remains dismissable');
  assert.equal(ctx.document.querySelector('.session-context-menu'), null);
});

for (const action of ['Refresh screen', 'Send to background', "Don't restore", 'Copy id', 'View messages']) {
  test(`choosing ${action} restores focus to the connected opener`, t => {
    const ctx = setup(t);
    const opener = ctx.document.createElement('button');
    ctx.document.body.appendChild(opener);
    opener.focus();
    ctx.window.openSessions.set('head-222', { closed: false });
    ctx.window.dormantWorkingSet = new Map([['root-000', {}]]);
    ctx.window.backgroundActionReason = () => '';
    ctx.window.requestTerminalRefresh = () => {};
    ctx.window.sendSessionToBackground = () => {};
    ctx.window.dismissDormantSession = () => {};
    ctx.window.api.writeClipboard = () => Promise.resolve();
    ctx.window.showJsonlViewer = () => {};
    const root = action === 'Copy id' || action === 'View messages' ? openParts(ctx) : menu(ctx);
    const button = [...root.querySelectorAll('button')].find(item => item.textContent === action);
    assert.ok(button && !button.disabled);
    button.click();
    assert.equal(ctx.document.activeElement, opener);
  });
}

test('a menu action preserves focus taken by its viewer', t => {
  const ctx = setup(t);
  const opener = ctx.document.createElement('button');
  const viewer = ctx.document.createElement('textarea');
  ctx.document.body.append(opener, viewer);
  opener.focus();
  ctx.window.showJsonlViewer = () => viewer.focus();
  const list = openParts(ctx);
  [...list.querySelectorAll('button')].find(button => button.textContent === 'View messages').click();
  assert.equal(ctx.document.activeElement, viewer);
});

test('a menu action does not try to focus a disconnected opener', t => {
  const ctx = setup(t);
  const opener = ctx.document.createElement('button');
  ctx.document.body.appendChild(opener);
  opener.focus();
  const list = openParts(ctx);
  opener.remove();
  let focused = false;
  opener.focus = () => { focused = true; };
  ctx.window.api.writeClipboard = () => Promise.resolve();
  [...list.querySelectorAll('button')].find(button => button.textContent === 'Copy id').click();
  assert.equal(focused, false);
});

test('Escape returns focus to the menu opener', t => {
  const ctx = setup(t);
  const opener = ctx.document.createElement('button');
  ctx.document.body.appendChild(opener);
  opener.focus();
  menu(ctx);
  ctx.document.activeElement.dispatchEvent(new ctx.window.KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, cancelable: true,
  }));
  assert.equal(ctx.document.activeElement, opener);
});

test('modified menu navigation keys pass through without changing focus or activating actions', t => {
  const ctx = setup(t);
  const root = menu(ctx);
  const button = root.querySelector('.session-parts-btn');
  button.focus();
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
    for (const key of ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' ']) {
      const event = new ctx.window.KeyboardEvent('keydown', { key, [modifier]: true, bubbles: true, cancelable: true });
      button.dispatchEvent(event);
      assert.equal(event.defaultPrevented, false, `${modifier}+${key} passes through`);
      assert.equal(ctx.document.activeElement, button, `${modifier}+${key} keeps focus`);
      assert.equal(button.getAttribute('aria-expanded'), 'false', `${modifier}+${key} does not open Parts`);
    }
  }
});

test('badge and Parts agree when member ids repeat and the head is outside the members', t => {
  const session = { ...row, mergedMemberIds: ['member-111', 'member-111', 'root-000'] };
  const ctx = setup(t, session);
  const list = openParts(ctx, session);
  assert.equal(list.querySelectorAll('.session-part').length, 3);
  assert.equal(ctx.sidebar.buildSessionItem(session).querySelector('.session-parts-badge').textContent, '3 parts');
});
