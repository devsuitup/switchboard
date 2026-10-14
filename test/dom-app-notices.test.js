'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { setupSidebarDom } = require('./dom-setup');

function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  ctx.window.setTimeout = setTimeout;
  ctx.window.clearTimeout = clearTimeout;
  ctx.window.Date = Date;
  return ctx;
}

test('error notices stay after 20 seconds, announce as alerts and dismiss on request', t => {
  const { window, document } = setup(t);
  window.showAppNotice({ id: 'failure', kind: 'error', message: 'Could not stop the session.' });
  t.mock.timers.tick(20_000);
  const notice = document.querySelector('[data-notice-id="failure"]');
  assert.ok(notice);
  assert.equal(notice.getAttribute('role'), 'alert');
  const dismiss = notice.querySelector('button');
  assert.equal(dismiss.textContent, 'Dismiss');
  dismiss.click();
  assert.equal(document.querySelector('[data-notice-id="failure"]'), null);
});

for (const [kind, duration] of [['undo', 10_000], ['info', 15_000]]) {
  for (const interaction of ['focus', 'pointer']) {
    test(`${kind} pauses for ${interaction} and expires after only the remaining time on leave`, t => {
      const { window, document } = setup(t);
      const outside = document.createElement('button');
      document.body.append(outside);
      outside.focus();
      window.showAppNotice({ id: 'pause', kind, message: 'Saved.' });
      const notice = document.querySelector('.app-notice');
      t.mock.timers.tick(4_000);
      if (interaction === 'focus') notice.querySelector('button').focus();
      else notice.dispatchEvent(new window.MouseEvent('mouseenter'));
      t.mock.timers.tick(30_000);
      assert.ok(notice.isConnected);
      if (interaction === 'focus') outside.focus();
      else notice.dispatchEvent(new window.MouseEvent('mouseleave'));
      t.mock.timers.tick(duration - 4_001);
      assert.ok(notice.isConnected);
      t.mock.timers.tick(1);
      assert.equal(notice.isConnected, false);
    });
  }
}

test('leaving hover does not resume a focused notice, including focus moving between its buttons', t => {
  const { window, document } = setup(t);
  const outside = document.createElement('button');
  document.body.append(outside);
  window.showAppNotice({ id: 'overlap', kind: 'undo', message: 'Archived.', actionLabel: 'Undo', onAction() {} });
  const notice = document.querySelector('.app-notice');
  t.mock.timers.tick(3_000);
  notice.dispatchEvent(new window.MouseEvent('mouseenter'));
  notice.querySelector('.app-notice-action').focus();
  notice.dispatchEvent(new window.MouseEvent('mouseleave'));
  t.mock.timers.tick(20_000);
  notice.querySelector('.app-notice-dismiss').focus();
  t.mock.timers.tick(20_000);
  assert.ok(notice.isConnected);
  outside.focus();
  t.mock.timers.tick(6_999);
  assert.ok(notice.isConnected);
  t.mock.timers.tick(1);
  assert.equal(notice.isConnected, false);
});

test('the shipped page has an empty polite live region before notices are loaded and keeps it after dismissal', t => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const dom = new JSDOM(html);
  t.after(() => dom.window.close());
  const region = dom.window.document.getElementById('app-notices');
  assert.ok(region);
  assert.equal(region.getAttribute('aria-live'), 'polite');
  assert.equal(region.childElementCount, 0);
  assert.ok(html.indexOf('id="app-notices"') < html.indexOf('src="app-notices.js"'));
  const { window, document } = setup(t);
  const persistent = document.getElementById('app-notices');
  assert.ok(persistent);
  window.showAppNotice({ id: 'live', message: 'Saved.' });
  window.clearAppNotice('live');
  assert.equal(document.getElementById('app-notices'), persistent);
  assert.equal(persistent.childElementCount, 0);
});

for (const selector of ['.app-notice-dismiss', '.app-notice-action']) {
  test(`${selector} preserves pointer focus and restores keyboard focus after removal`, t => {
    const { window, document } = setup(t);
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    let called = 0;
    const show = () => window.showAppNotice({ id: 'focus', kind: 'undo', message: 'Archived.', actionLabel: 'Undo', onAction: () => { called++; } });
    show();
    const pointerButton = document.querySelector(selector);
    const down = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    pointerButton.dispatchEvent(down);
    assert.equal(down.defaultPrevented, true);
    pointerButton.click();
    assert.equal(document.activeElement, outside);
    show();
    const keyboardButton = document.querySelector(selector);
    keyboardButton.focus();
    keyboardButton.click();
    assert.equal(document.activeElement, outside);
    assert.equal(called, selector === '.app-notice-action' ? 2 : 0);
  });
}

test('caller ids cannot collide with page ids and omitted ids never produce an undefined DOM id', t => {
  const { window, document } = setup(t);
  const sidebar = document.getElementById('sidebar-content');
  for (const id of ['app-notices', 'sidebar-content', 'spaces and # punctuation']) {
    window.showAppNotice({ id, kind: 'error', message: id });
    const notice = [...document.querySelectorAll('.app-notice')].find(el => el.dataset.noticeId === id);
    assert.ok(notice);
    assert.notEqual(notice.id, id);
  }
  window.showAppNotice({ message: 'No caller id' });
  assert.equal(document.querySelector('[id="undefined"]'), null);
  assert.equal(document.getElementById('sidebar-content'), sidebar);
  window.clearAppNotice('app-notices');
  assert.equal(document.querySelectorAll('#app-notices').length, 1);
  assert.equal(document.querySelectorAll('.app-notice').length, 3);
});

test('Dismiss delegates directly to clearAppNotice without a redundant branch', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/app-notices.js'), 'utf8');
  assert.match(source, /dismiss\.addEventListener\('click', \(\) => clearAppNotice\(id\)\);/);
});

test('two ids stack and replacing one id preserves the other notice', t => {
  const { window, document } = setup(t);
  window.showAppNotice({ id: 'first', kind: 'error', message: 'First failure' });
  window.showAppNotice({ id: 'second', kind: 'error', message: 'Second failure' });
  window.showAppNotice({ id: 'first', kind: 'error', message: 'Updated failure' });
  assert.equal(document.querySelectorAll('#app-notices > .app-notice').length, 2);
  assert.equal(document.querySelectorAll('[data-notice-id="first"]').length, 1);
  assert.match(document.querySelector('[data-notice-id="first"]').textContent, /Updated failure/);
  assert.match(document.querySelector('[data-notice-id="second"]').textContent, /Second failure/);
});

test('info notices announce as status and expire after 15 seconds', t => {
  const { window, document } = setup(t);
  window.showAppNotice({ id: 'info', kind: 'info', message: 'Saved.' });
  assert.equal(document.querySelector('[data-notice-id="info"]').getAttribute('role'), 'status');
  t.mock.timers.tick(14_999);
  assert.ok(document.querySelector('[data-notice-id="info"]'));
  t.mock.timers.tick(1);
  assert.equal(document.querySelector('[data-notice-id="info"]'), null);
});

test('a replaced or cleared notice cannot expire its later replacement', t => {
  const { window, document } = setup(t);
  window.showAppNotice({ id: 'same', kind: 'info', message: 'Old' });
  t.mock.timers.tick(5_000);
  window.showAppNotice({ id: 'same', kind: 'error', message: 'New error' });
  t.mock.timers.tick(15_000);
  assert.match(document.querySelector('[data-notice-id="same"]').textContent, /New error/);
  window.clearAppNotice('same');
  assert.equal(document.querySelector('[data-notice-id="same"]'), null);
  window.clearAppNotice('missing');
  window.showAppNotice({ id: 'same', kind: 'info', message: 'Clear this timer' });
  window.clearAppNotice('same');
  t.mock.timers.tick(5_000);
  window.showAppNotice({ id: 'same', kind: 'info', message: 'Later' });
  t.mock.timers.tick(10_000);
  assert.match(document.querySelector('[data-notice-id="same"]').textContent, /Later/);
  t.mock.timers.tick(5_000);
  assert.equal(document.querySelector('[data-notice-id="same"]'), null);
});

test('Undo gives a visible explanation, a keyboard reachable action and a 10 second window', t => {
  const { window, document } = setup(t);
  let undone = 0;
  window.showAppNotice({
    id: 'undo', kind: 'undo', message: 'Conversation archived.',
    actionLabel: 'Undo', onAction: () => { undone++; },
  });
  const notice = document.querySelector('[data-notice-id="undo"]');
  assert.equal(notice.getAttribute('role'), 'status');
  assert.match(notice.textContent, /Conversation archived\./);
  const action = [...notice.querySelectorAll('button')].find(button => button.textContent === 'Undo');
  assert.ok(action);
  assert.equal(action.type, 'button');
  assert.equal(action.tabIndex, 0);
  action.focus();
  assert.equal(document.activeElement, action);
  t.mock.timers.tick(9_999);
  assert.ok(document.querySelector('[data-notice-id="undo"]'));
  action.click();
  action.click();
  assert.equal(undone, 1);
  assert.equal(document.querySelector('[data-notice-id="undo"]'), null);
  window.showAppNotice({ id: 'expiry', kind: 'undo', message: 'Archived.', actionLabel: 'Undo', onAction: () => { undone++; } });
  t.mock.timers.tick(9_999);
  assert.ok(document.querySelector('[data-notice-id="expiry"]'));
  t.mock.timers.tick(1);
  assert.equal(document.querySelector('[data-notice-id="expiry"]'), null);
  assert.equal(undone, 1);
});

test('ordinary notice actions use the supplied label and callback without interpreting message HTML', t => {
  const { window, document } = setup(t);
  let called = 0;
  window.showAppNotice({ id: 'action', kind: 'error', message: '<img src=x onerror=alert(1)>', actionLabel: 'Retry', onAction: () => { called++; } });
  assert.equal(document.querySelector('[data-notice-id="action"] img'), null);
  assert.match(document.querySelector('[data-notice-id="action"]').textContent, /<img/);
  const action = [...document.querySelectorAll('[data-notice-id="action"] button')].find(button => button.textContent === 'Retry');
  action.click();
  assert.equal(called, 1);
  assert.equal(document.querySelector('[data-notice-id="action"]'), null);
});

test('the shipped page loads notices before their sidebar caller', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.ok(html.includes('<script src="app-notices.js"></script>'));
  assert.ok(html.indexOf('src="app-notices.js"') < html.indexOf('src="sidebar.js"'));
});

test('notices use a bottom-right flex stack and wrap long text within the viewport', t => {
  const { window, document } = setup(t);
  const style = document.createElement('style');
  style.textContent = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
  document.head.append(style);
  window.showAppNotice({ id: 'layout', kind: 'error', message: 'Long message '.repeat(100) });
  const stack = window.getComputedStyle(document.querySelector('#app-notices'));
  assert.equal(stack.position, 'fixed');
  assert.equal(stack.bottom, '32px');
  assert.equal(stack.right, '12px');
  assert.equal(stack.display, 'flex');
  assert.equal(stack.flexDirection, 'column');
  assert.notEqual(stack.gap, '0px');
  assert.equal(stack.overflowY, 'auto');
  const message = window.getComputedStyle(document.querySelector('.app-notice-message'));
  assert.equal(message.whiteSpace, 'pre-wrap');
  assert.equal(message.overflowWrap, 'anywhere');
});
